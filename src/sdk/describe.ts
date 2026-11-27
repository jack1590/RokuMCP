import axios from 'axios';
import { RceError } from 'roku-rce';
import { friendlyError } from '../roku-config.js';
import { RokuError } from './errors.js';

export interface ErrorInfo {
  /**
   * Stable and machine-readable: a RokuError or RCE code, http_<status>, timeout,
   * connection_refused, host_not_found, a lower-case errno (enoent, econnreset, ...), or error.
   */
  code: string;
  /** The same text the MCP tools show after their "<Tool> failed:" prefix, with secrets removed. */
  message: string;
}

const SECRET_VARS = ['ROKU_RCE_TOKEN', 'ROKU_RCE_PASSWORD', 'ROKU_DEVICE_PASSWORD', 'ROKU_DEV_PASSWORD', 'ROKU_PASSWORD'];

/** Removes bearer tokens, JWTs and the values of the secret ROKU_* variables from text. */
export function redactSecrets(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let out = text.replace(/(Bearer\s+)[\w.~+/=-]+/gi, '$1<redacted>').replace(/eyJ[\w-]+\.[\w-]+\.[\w-]*/g, '<jwt>');
  for (const k of SECRET_VARS) {
    const v = env[k];
    // A word-character edge must not touch another word character, so a password like "roku" does
    // not mangle "roku_console_wait"; a symbol edge ("!abcd") still matches when glued to text.
    // shortcut: values under 4 characters are not redacted (too many false hits), upgrade if they appear.
    if (v && v.length >= 4) {
      const body = v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const before = /^\w/.test(v) ? '(?<!\\w)' : '';
      const after = /\w$/.test(v) ? '(?!\\w)' : '';
      out = out.replace(new RegExp(before + body + after, 'g'), '<redacted>');
    }
  }
  return out;
}

const ERRNO: Record<string, string> = {
  ETIMEDOUT: 'timeout',
  ESOCKETTIMEDOUT: 'timeout',
  ECONNABORTED: 'timeout',
  ECONNREFUSED: 'connection_refused',
  ENOTFOUND: 'host_not_found',
  EAI_AGAIN: 'host_not_found',
};

/** A Node errno such as ENOENT (axios's own ERR_* codes are not errnos). */
function errnoOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^E(?!RR_)[A-Z]+(?:_[A-Z]+)*$/.test(code) ? code : undefined;
}

/** File system errors: their own message is clearer than friendlyError's network guesses. */
const FS_ERRNO = new Set(['ENOENT', 'EACCES', 'EPERM', 'EISDIR', 'ENOTDIR', 'EEXIST', 'ENOSPC', 'EROFS']);

function classify(error: unknown): string {
  if (error instanceof RokuError) return error.code;
  if (error instanceof RceError) return error.code ?? (error.status ? `http_${error.status}` : 'rce_error');
  if (axios.isAxiosError(error) && error.response?.status) return `http_${error.response.status}`;
  const errno = errnoOf(error);
  if (errno) return ERRNO[errno] ?? errno.toLowerCase();
  if ((error as { code?: unknown } | null)?.code === 'ERR_SOCKET_CONNECTION_TIMEOUT') return 'timeout';
  // Plain errors from the RTA client, the LAN socket connect and the live capture: "... timed out
  // [after <n>ms]" or "Timed out ...". Anchored so a file path that contains "timeout" is not one.
  const raw = error instanceof Error ? error.message : String(error);
  if (/timed out( after \d+ ?ms)?\.?$|^timed out\b/i.test(raw)) return 'timeout';
  return 'error';
}

/** A plain {code, message} for any error, for the CLI and code mode. Never includes a stack. */
export function describeError(error: unknown): ErrorInfo {
  const raw = FS_ERRNO.has(errnoOf(error) ?? '') && error instanceof Error;
  const message = error instanceof RokuError || raw ? (error as Error).message : friendlyError(error);
  return { code: classify(error), message: redactSecrets(message) };
}
