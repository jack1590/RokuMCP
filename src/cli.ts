#!/usr/bin/env node
/**
 * rokuctl: the roku-mcp SDK from the shell, for scripts, CI and agents without MCP.
 *
 *   rokuctl <group>.<command> [positional...] [--flag value | --flag=value] [--json '{...}'] [--out file] [--timeout ms]
 *
 * Contract: exactly one JSON object on stdout, {"ok":true,"data":...} or
 * {"ok":false,"error":{"code","message"}}. Exit codes: 0 ok, 1 device or tool error,
 * 2 usage error, 3 timeout. Binary data (screenshots) and output over 64 KiB go to --out only.
 * Secrets come from the environment or .env (ROKU_DEVICE_PASSWORD, ROKU_RCE_TOKEN, ...), never flags.
 */
import './env.js';
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { COMMANDS, commandShape, commandSummary, findCommand, parseCommandInput, type Command } from './commands.js';
import { describeError } from './sdk/describe.js';
import { jsonify } from './sdk/json.js';
import { stopStartedRuns } from './rce.js';

export const MAX_STDOUT_BYTES = 64 * 1024;

export class UsageError extends Error {}

/** --timeout elapsed: reported as is, not as a device timeout. */
class CliTimeout extends Error {}

type Output = { exitCode: number; stdout: string };

const kebab = (key: string) => key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
const camel = (flag: string) => flag.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

type Field = Parameters<typeof z.safeParse>[0] | undefined;
const accepts = (field: Field, value: unknown) => !!field && z.safeParse(field, value).success;

/**
 * The JSON reading of a value when the field accepts it as a non-string (so `--match true` is a
 * boolean where the schema allows one), else the raw text. A string "true" for such a field needs --json.
 */
function coerce(field: Field, raw: string): unknown {
  if (!field) return raw;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'string' && accepts(field, parsed)) return parsed;
  } catch {
    // not JSON: the raw text
  }
  return raw;
}

/** A field that takes booleans and not strings: a bare `--flag` means true. */
function isBooleanField(field: Field): boolean {
  return accepts(field, true) && !accepts(field, 'x');
}

export interface ParsedArgs {
  command: Command;
  input: Record<string, unknown>;
  out?: string;
  timeoutMs?: number;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const [name, ...rest] = argv;
  if (!name || name === 'help' || name === '--help') throw new UsageError('help');
  const command = findCommand(name);
  if (!command || command.session) {
    throw new UsageError(
      command
        ? `${name} keeps state between calls and is available in code mode only (roku_run). Use console.capture for a one-shot capture.`
        : `Unknown command "${name}". Run "rokuctl help" for the list.`
    );
  }
  const shape: Record<string, Field> = commandShape(command);
  const input: Record<string, unknown> = {};
  const positionals: string[] = [];
  let out: string | undefined;
  let timeoutMs: number | undefined;

  let optionsEnded = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (optionsEnded || !arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    if (arg === '--') {
      optionsEnded = true;
      continue;
    }
    const eq = arg.indexOf('=');
    const flag = eq > 0 ? arg.slice(2, eq) : arg.slice(2);
    const key = camel(flag);
    const takeValue = (): string => {
      if (eq > 0) return arg.slice(eq + 1);
      const next = rest[i + 1];
      if (next === undefined) throw new UsageError(`--${flag} needs a value`);
      i++;
      return next;
    };
    if (key === 'out') out = takeValue();
    else if (key === 'timeout') {
      timeoutMs = Number(takeValue());
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new UsageError('--timeout must be a positive number of milliseconds');
    } else if (key === 'json') {
      let obj: unknown;
      try {
        obj = JSON.parse(takeValue());
      } catch {
        throw new UsageError('--json must be a JSON object');
      }
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new UsageError('--json must be a JSON object');
      const unknown = Object.keys(obj).filter((k) => !(k in shape));
      if (unknown.length) throw new UsageError(`Unknown option${unknown.length > 1 ? 's' : ''} in --json for ${name}: ${unknown.join(', ')}`);
      Object.assign(input, obj);
    } else if (key === 'password') {
      throw new UsageError('Pass the password through ROKU_DEVICE_PASSWORD or ROKU_RCE_PASSWORD (or .env), not a flag: flags are visible to other processes.');
    } else if (!(key in shape)) {
      throw new UsageError(`Unknown option --${flag} for ${name}`);
    } else if (eq < 0 && isBooleanField(shape[key]) && !['true', 'false'].includes(rest[i + 1] ?? '')) {
      input[key] = true;
    } else {
      input[key] = coerce(shape[key], takeValue());
    }
  }

  const slots = command.positional ?? [];
  slots.forEach((slot, idx) => {
    if (slot.endsWith('...')) {
      const key = slot.slice(0, -3);
      if (positionals.length > idx) input[key] = positionals.slice(idx);
      positionals.length = Math.min(positionals.length, idx);
    } else if (positionals[idx] !== undefined) {
      input[slot] = coerce(shape[slot], positionals[idx]);
    }
  });
  if (positionals.length > slots.length && !slots.some((s) => s.endsWith('...'))) {
    // The values are not echoed: a stray argument may be a mistyped password.
    throw new UsageError(`Too many arguments for ${name}: expected at most ${slots.length}, got ${positionals.length}.`);
  }
  if ('password' in input) throw new UsageError('Pass the password through the environment or .env, not --json.');
  if (out && !fs.existsSync(path.dirname(path.resolve(out)))) throw new UsageError(`--out folder does not exist: ${path.dirname(path.resolve(out))}`);
  return { command, input, out, timeoutMs };
}

/** Replaces Buffers with a byte count, returning the first one so --out can write it. */
function stripBinary(value: unknown): { data: unknown; binary?: Buffer } {
  let binary: Buffer | undefined;
  const walk = (v: unknown): unknown => {
    if (Buffer.isBuffer(v)) {
      binary ??= v;
      return { binary: true, bytes: v.length };
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return { data: walk(value), binary };
}

const success = (data: unknown): Output => ({ exitCode: 0, stdout: jsonify({ ok: true, data: data ?? null }, 0) });
const failure = (exitCode: number, code: string, message: string): Output => ({ exitCode, stdout: jsonify({ ok: false, error: { code, message } }, 0) });

function help(): Output {
  const commands = COMMANDS.filter((c) => !c.session).map((c) => ({
    name: c.name,
    args: [
      ...(c.positional ?? []).map((p) => `<${p}>`),
      ...Object.keys(commandShape(c))
        .filter((k) => k !== 'password' && !(c.positional ?? []).some((p) => p.replace('...', '') === k))
        .map((k) => `--${kebab(k)}`),
    ].join(' '),
    summary: commandSummary(c),
  }));
  return success({
    usage: 'rokuctl <command> [positional...] [--option value] [--json \'{...}\'] [--out file] [--timeout ms]',
    exitCodes: { 0: 'ok', 1: 'device or tool error', 2: 'usage error', 3: 'timeout' },
    commands,
  });
}

/** Runs one CLI invocation; never throws. */
export async function runCli(argv: string[]): Promise<Output> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) return error.message === 'help' ? help() : failure(2, 'usage', error.message);
    throw error;
  }
  const valid = parseCommandInput(parsed.command, parsed.input);
  if (!valid.success) {
    const issues = valid.error.issues.map((i) => `${i.path.join('.') || '(input)'}: ${i.message}`).join('; ');
    return failure(2, 'usage', `Invalid arguments for ${parsed.command.name}: ${issues}`);
  }

  let result: unknown;
  try {
    const call = Promise.resolve(parsed.command.run(valid.data));
    result = parsed.timeoutMs
      ? await Promise.race([
          call,
          new Promise((_, reject) => setTimeout(() => reject(new CliTimeout(`--timeout ${parsed.timeoutMs} ms elapsed before ${parsed.command.name} finished.`)), parsed.timeoutMs).unref()),
        ])
      : await call;
  } catch (error) {
    if (error instanceof CliTimeout) {
      // A Run whose start was cut off would bill until its max runtime.
      return failure(3, 'timeout', error.message + (await stopRuns()));
    }
    const info = describeError(error);
    return failure(info.code === 'timeout' ? 3 : 1, info.code, info.message);
  }

  const { data, binary } = stripBinary(result);
  if (parsed.out) {
    const body = binary ?? (typeof data === 'string' ? data : jsonify(data));
    try {
      fs.writeFileSync(parsed.out, body);
    } catch (error) {
      return failure(1, 'out_write_failed', `${parsed.command.name} succeeded, but writing --out failed: ${describeError(error).message}`);
    }
    return success({ file: parsed.out, bytes: Buffer.byteLength(body), ...(binary && data && typeof data === 'object' ? { result: data } : {}) });
  }
  const out = success(data);
  if (Buffer.byteLength(out.stdout) > MAX_STDOUT_BYTES) {
    return failure(2, 'output_too_large', `The result is ${Buffer.byteLength(out.stdout)} bytes, over the ${MAX_STDOUT_BYTES}-byte stdout limit. Run again with --out <file>.`);
  }
  return out;
}

const isDirectRun = !!process.argv[1] && /(?:^|[\\/])(?:rokuctl|cli\.js)$/.test(process.argv[1]);

const SIGNAL_EXIT = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 } as const;

/** Writes the one JSON line and exits; later calls are ignored. */
let finished = false;
function finish(exitCode: number, stdout: string): void {
  if (finished) return;
  finished = true;
  process.stdout.write(stdout + '\n', () => process.exit(exitCode));
}

/** Stops any Cloud Device Run this process started; returns a sentence for the error message. */
async function stopRuns(): Promise<string> {
  // No MCP client is waiting to SIGKILL a CLI, so give a just-requested Run time to show up.
  const { stopped, failed } = await stopStartedRuns(20_000);
  const parts: string[] = [];
  if (stopped.length) parts.push(`Stopped the Cloud Device Run it started (device ${stopped.map((r) => r.deviceId).join(', ')}).`);
  if (failed.length) {
    parts.push(`Could not stop a Run it started on Cloud Device ${failed.map((f) => f.deviceId).join(', ')}: it may still be billing. Check with "rokuctl rce.status <device>" and stop it with "rokuctl rce.stop <device>".`);
  }
  return parts.length ? ' ' + parts.join(' ') : '';
}

if (isDirectRun) {
  for (const signal of Object.keys(SIGNAL_EXIT) as Array<keyof typeof SIGNAL_EXIT>) {
    process.on(signal, () => {
      void stopRuns().then((note) => finish(SIGNAL_EXIT[signal], jsonify({ ok: false, error: { code: 'interrupted', message: `Interrupted by ${signal}.${note}` } }, 0)));
    });
  }
  process.on('uncaughtException', (error) => {
    void stopRuns().then((note) => {
      const info = describeError(error);
      finish(1, jsonify({ ok: false, error: { code: info.code, message: info.message + note } }, 0));
    });
  });
  runCli(process.argv.slice(2)).then(
    ({ exitCode, stdout }) => finish(exitCode, stdout),
    (error) => finish(1, jsonify({ ok: false, error: describeError(error) }, 0))
  );
}
