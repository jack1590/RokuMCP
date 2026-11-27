import axios from 'axios';
import { RceError } from 'roku-rce';
import { friendlyError } from '../roku-config.js';
import { RokuError } from './errors.js';

export interface ErrorInfo {
  /** Stable, machine-readable: a RokuError or RCE code, http_<status>, timeout, connection_refused, host_not_found, or error. */
  code: string;
  /** The same text the MCP tools show after their "<Tool> failed:" prefix. */
  message: string;
}

/** A plain {code, message} for any error, for the CLI and code mode. Never includes a stack. */
export function describeError(error: unknown): ErrorInfo {
  if (error instanceof RokuError) return { code: error.code, message: error.message };
  const message = friendlyError(error);
  if (error instanceof RceError) return { code: error.code ?? (error.status ? `http_${error.status}` : 'rce_error'), message };
  const raw = error instanceof Error ? error.message : String(error);
  const errno = (error as { code?: unknown } | null)?.code;
  if (errno === 'ECONNABORTED' || errno === 'ETIMEDOUT' || /ETIMEDOUT|ESOCKETTIMEDOUT|time(d )?out/i.test(raw)) return { code: 'timeout', message };
  if (axios.isAxiosError(error) && error.response?.status) return { code: `http_${error.response.status}`, message };
  if (errno === 'ECONNREFUSED' || /ECONNREFUSED/.test(raw)) return { code: 'connection_refused', message };
  if (errno === 'ENOTFOUND' || /ENOTFOUND|getaddrinfo/.test(raw)) return { code: 'host_not_found', message };
  return { code: 'error', message };
}
