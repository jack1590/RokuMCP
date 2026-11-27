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

/** The first of raw text or its JSON reading that the schema field accepts. */
function coerce(field: Field, raw: string): unknown {
  if (!field || accepts(field, raw)) return raw;
  try {
    const parsed = JSON.parse(raw);
    if (accepts(field, parsed)) return parsed;
  } catch {
    // not JSON: leave raw so validation reports the field
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

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith('--') || arg === '--') {
      positionals.push(arg);
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
    throw new UsageError(`Too many arguments for ${name}: ${positionals.slice(slots.length).join(' ')}`);
  }
  if ('password' in input) throw new UsageError('Pass the password through the environment or .env, not --json.');
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
      const { stopped, failed } = await stopStartedRuns(3500);
      const note = stopped.length ? ` Stopped the Cloud Device Run this command started.` : failed.length ? ` A Cloud Device Run it started could not be stopped: check rce.status.` : '';
      return failure(3, 'timeout', error.message + note);
    }
    const info = describeError(error);
    return failure(info.code === 'timeout' ? 3 : 1, info.code, info.message);
  }

  const { data, binary } = stripBinary(result);
  if (parsed.out) {
    const body = binary ?? (typeof data === 'string' ? data : jsonify(data));
    fs.writeFileSync(parsed.out, body);
    return success({ file: parsed.out, bytes: Buffer.byteLength(body), ...(binary && data && typeof data === 'object' ? { result: data } : {}) });
  }
  const out = success(data);
  if (Buffer.byteLength(out.stdout) > MAX_STDOUT_BYTES) {
    return failure(2, 'output_too_large', `The result is ${Buffer.byteLength(out.stdout)} bytes, over the ${MAX_STDOUT_BYTES}-byte stdout limit. Run again with --out <file>.`);
  }
  return out;
}

const isDirectRun = !!process.argv[1] && /(?:^|[\\/])(?:rokuctl|cli\.js)$/.test(process.argv[1]);

if (isDirectRun) {
  // A Run still starting when the user interrupts would bill until its max runtime: stop it.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void stopStartedRuns(3500).finally(() => process.exit(130));
    });
  }
  runCli(process.argv.slice(2)).then(
    ({ exitCode, stdout }) => process.stdout.write(stdout + '\n', () => process.exit(exitCode)),
    (error) => {
      process.stdout.write(jsonify({ ok: false, error: describeError(error) }, 0) + '\n', () => process.exit(1));
    }
  );
}
