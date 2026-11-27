/**
 * roku_run: runs an agent-written async function body against the SDK in a sandboxed child
 * process (see runner.ts). This side holds the SDK, the secrets and the device connections;
 * the child only sends call requests, which are checked against the command table, validated
 * with the same zod schemas as the MCP tools, and held to the path policy.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { COMMANDS, commandShape, parseCommandInput, type Command } from '../commands.js';
import type { TargetParams } from '../roku-config.js';
import { describeError, type ErrorInfo } from '../sdk/describe.js';
import { withDefaults } from '../sdk/defaults.js';
import { RokuError } from '../sdk/errors.js';
import { toPlain } from '../sdk/json.js';
import { OUTPUT_DIR, PathPolicy } from './policy.js';

export const RUN_LIMITS = {
  defaultTimeoutMs: 30_000,
  maxTimeoutMs: 300_000,
  memoryMb: 128,
  maxCalls: 5_000,
  maxReadBytes: 1024 * 1024,
  maxWriteBytes: 5 * 1024 * 1024,
  maxResultChars: 100 * 1024,
};

/** Node's permission model without the experimental flag: 22.13+ (and 23.5+). */
export function sandboxSupported(version = process.versions.node): boolean {
  const [major, minor] = version.split('.').map(Number);
  return major > 23 || (major === 23 && minor >= 5) || (major === 22 && minor >= 13);
}

export interface RunOptions extends TargetParams {
  code: string;
  timeoutMs?: number;
  /** Folder roku.fs and path arguments are confined to; defaults to the server's working directory. */
  root?: string;
}

export interface RunResult {
  ok: boolean;
  result?: unknown;
  /** sandbox: true when roku_run itself stopped the snippet (timeout, memory, crash, protocol). */
  error?: ErrorInfo & { sandbox?: true };
  logs: string[];
  logsTruncated?: boolean;
  /** Files the snippet wrote with roku.fs.write, relative to the root. */
  files: string[];
  calls: number;
}

/** roku.<group>.<method> names: "ui.app-ui" is called as roku.ui.appUi. */
const camel = (s: string) => s.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
const BY_CALL = new Map<string, Command>(COMMANDS.map((c) => {
  const [group, name] = c.name.split('.');
  return [`${group}.${camel(name)}`, c];
}));

/** Every call name a snippet may use, for the docs tool. */
export const CALL_NAMES = [...BY_CALL.keys(), 'fs.read', 'fs.write', 'fs.list'];

/** Options the SDK reads from, and options it writes to (those must be in the output folder). */
const READ_KEYS = ['filePath', 'beforePath', 'afterPath', 'charlesSessionPath'];
const WRITE_KEYS = ['outDir', 'file'];
/** Error codes only roku_run itself reports; a snippet cannot claim them. */
const SANDBOX_CODES = new Set(['timeout', 'memory_limit', 'crashed', 'protocol', 'spawn_failed', 'unsupported_node', 'sandbox_unsafe', 'output_too_large']);
const MAX_ERROR_CHARS = 2000;

function capLogs(raw: unknown): { logs: string[]; truncated: boolean } {
  const logs: string[] = [];
  let chars = 0;
  let truncated = false;
  for (const l of Array.isArray(raw) ? raw : []) {
    if (typeof l !== 'string') continue;
    if (chars + l.length > 64 * 1024 || logs.length >= 2000) {
      truncated = true;
      break;
    }
    chars += l.length;
    logs.push(l);
  }
  return { logs, truncated };
}

let runnerSource: string | undefined;
function runner(): string {
  runnerSource ??= fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'runner.js'), 'utf8');
  return runnerSource;
}

/** The child's environment: nothing from ours (no tokens, no passwords). Windows needs SystemRoot to start. */
function childEnv(): NodeJS.ProcessEnv {
  return process.platform === 'win32' && process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {};
}

class Dispatcher {
  calls = 0;
  readonly files = new Set<string>();

  constructor(private readonly policy: PathPolicy, private readonly target: TargetParams) {}

  async dispatch(name: unknown, args: unknown): Promise<unknown> {
    if (++this.calls > RUN_LIMITS.maxCalls) throw new RokuError('too_many_calls', `More than ${RUN_LIMITS.maxCalls} calls in one run.`);
    if (typeof name !== 'string' || !Array.isArray(args)) throw new RokuError('protocol', 'Malformed call.');
    if (name.startsWith('fs.')) return this.fs(name, args);

    const command = BY_CALL.get(name);
    if (!command) throw new RokuError('unknown_call', `roku.${name} does not exist. List the calls with roku_sdk_docs.`);
    const options = args[0] ?? {};
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new RokuError('bad_args', `roku.${name} takes one options object, e.g. roku.${name}({ ... }).`);
    }
    const shape = commandShape(command);
    const merged = 'host' in shape || 'rceDevice' in shape ? withDefaults(this.target, options as object) : options;
    const valid = parseCommandInput(command, merged);
    if (!valid.success) {
      const issues = valid.error.issues.map((i) => `${i.path.join('.') || '(options)'}: ${i.message}`).join('; ');
      throw new RokuError('bad_args', `Invalid options for roku.${name}: ${issues}`);
    }
    const input = valid.data as Record<string, unknown>;
    this.defaults(command, input);
    this.checkPaths(input);
    return toPlain(await command.run(input)).data;
  }

  private checkPaths(input: Record<string, unknown>): void {
    if (input.stagingDir !== undefined) throw new RokuError('path_denied', 'stagingDir cannot be set from roku_run (roku-deploy empties and deletes it); the default temp folder is used.');
    // Glob patterns cannot be checked reliably as text ([.]env, @(.env)): deploy the whole folder instead.
    if (input.files !== undefined) throw new RokuError('path_denied', 'files cannot be set from roku_run; deploy a build folder that holds only the channel.');
    if (input.rootDir !== undefined) input.rootDir = this.policy.resolveDeployRoot(input.rootDir);
    if (input.outFile !== undefined) this.policy.checkFileName(input.outFile, 'outFile');
    for (const key of READ_KEYS) if (input[key] !== undefined) input[key] = this.policy.resolveRead(input[key], key);
    for (const key of WRITE_KEYS) if (input[key] !== undefined) input[key] = this.policy.resolveWrite(input[key], key);
  }

  /** A capture with no file goes to the output folder, not ./logs. */
  defaults(command: Command, input: Record<string, unknown>): void {
    if ((command.name === 'console.capture-start' || command.name === 'console.capture') && input.file === undefined) {
      input.file = path.join(OUTPUT_DIR, 'logs', `capture-${Date.now()}.log`);
    }
  }

  private fs(name: string, args: unknown[]): unknown {
    const [p, content] = args;
    switch (name) {
      case 'fs.read': {
        const abs = this.policy.resolveRead(p);
        const size = fs.statSync(abs).size;
        if (size > RUN_LIMITS.maxReadBytes) throw new RokuError('too_large', `${p} is ${size} bytes; roku.fs.read reads at most ${RUN_LIMITS.maxReadBytes}.`);
        return fs.readFileSync(abs, 'utf8');
      }
      case 'fs.write': {
        if (typeof content !== 'string') throw new RokuError('bad_args', 'roku.fs.write(path, text) takes a string.');
        if (Buffer.byteLength(content) > RUN_LIMITS.maxWriteBytes) throw new RokuError('too_large', `roku.fs.write writes at most ${RUN_LIMITS.maxWriteBytes} bytes.`);
        const abs = this.policy.resolveWrite(p);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        // Check again after mkdir, and never follow a link at the final name.
        this.policy.resolveWrite(abs);
        const fd = fs.openSync(abs, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | (fs.constants.O_NOFOLLOW ?? 0));
        try {
          fs.writeSync(fd, content);
        } finally {
          fs.closeSync(fd);
        }
        this.files.add(this.policy.relative(abs));
        return { path: this.policy.relative(abs), bytes: Buffer.byteLength(content) };
      }
      case 'fs.list': {
        const abs = this.policy.resolveRead(p ?? '.');
        return fs
          .readdirSync(abs, { withFileTypes: true })
          .filter((d) => this.policy.listable(d.name))
          .map((d) => ({ name: d.name, type: d.isDirectory() ? 'dir' : d.isFile() ? 'file' : 'other' }));
      }
      default:
        throw new RokuError('unknown_call', `roku.${name} does not exist. Use roku.fs.read, roku.fs.write or roku.fs.list.`);
    }
  }
}

/** Runs one snippet; never throws. */
export async function runSnippet(options: RunOptions): Promise<RunResult> {
  const base = { logs: [] as string[], files: [] as string[], calls: 0 };
  if (!sandboxSupported()) {
    return { ok: false, error: { code: 'unsupported_node', message: `roku_run needs Node.js 22.13 or later for its sandbox (this server runs ${process.version}). The other tools work as usual.` }, ...base };
  }
  const timeoutMs = Math.min(Math.max(options.timeoutMs ?? RUN_LIMITS.defaultTimeoutMs, 1), RUN_LIMITS.maxTimeoutMs);
  let policy: PathPolicy;
  try {
    policy = new PathPolicy(options.root);
  } catch (error) {
    return { ok: false, error: describeError(error), ...base };
  }
  const dispatcher = new Dispatcher(policy, { host: options.host, rceDevice: options.rceDevice, password: options.password });

  const child = spawn(
    process.execPath,
    [
      '--permission',
      // node:sqlite reads and writes files outside the permission grants on Node 22.
      ...(process.allowedNodeEnvironmentFlags.has('--no-experimental-sqlite') ? ['--no-experimental-sqlite'] : []),
      `--max-old-space-size=${RUN_LIMITS.memoryMb}`,
      '--disable-warning=ExperimentalWarning',
      '--input-type=module',
      '-e',
      runner(),
    ],
    { cwd: os.tmpdir(), env: childEnv(), stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true }
  );
  let stderr = '';
  child.stderr!.on('data', (d: Buffer) => {
    if (stderr.length < 4096) stderr += d.toString();
  });

  let settled = false;
  return new Promise<RunResult>((resolve) => {
    const settle = (r: Omit<RunResult, 'files' | 'calls'>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.exitCode === null) child.kill('SIGKILL');
      resolve({ ...r, files: [...dispatcher.files], calls: dispatcher.calls });
    };
    const timer = setTimeout(
      () => settle({ ok: false, error: { code: 'timeout', message: `roku_run stopped the snippet after ${timeoutMs} ms. A device call already in progress may still finish; no new calls run.`, sandbox: true }, logs: [] }),
      timeoutMs
    );

    let started = false;
    child.on('message', (raw: unknown) => {
      if (settled) return; // nothing runs after the result is decided
      const m = raw as { type?: unknown; id?: unknown; name?: unknown; args?: unknown; value?: unknown; error?: unknown; logs?: unknown; logsTruncated?: unknown; reason?: unknown };
      if (m?.type === 'unsafe') {
        return settle({ ok: false, error: { code: 'sandbox_unsafe', message: `roku_run refused to run the snippet: ${String(m.reason).slice(0, 200)}. Use a Node.js release where this is closed.`, sandbox: true }, logs: [] });
      }
      if (m?.type === 'ready' && !started) {
        started = true;
        child.send({ type: 'run', code: options.code });
      } else if (m?.type === 'call' && typeof m.id === 'number' && started) {
        const id = m.id;
        dispatcher.dispatch(m.name, m.args).then(
          (value) => !settled && child.connected && child.send({ type: 'result', id, value }),
          (error) => !settled && child.connected && child.send({ type: 'result', id, error: describeError(error) })
        );
      } else if (m?.type === 'done' && started) {
        // The child is untrusted: cap what it reports here, not only in the runner.
        const capped = capLogs(m.logs);
        const logs = capped.logs;
        const logsTruncated = capped.truncated || m.logsTruncated === true || undefined;
        const error = m.error as ErrorInfo | undefined;
        if (error && typeof error.code === 'string' && typeof error.message === 'string') {
          const code = /^[A-Za-z0-9_]{1,40}$/.test(error.code) && !SANDBOX_CODES.has(error.code) ? error.code : 'snippet_error';
          return settle({ ok: false, error: { code, message: error.message.slice(0, MAX_ERROR_CHARS) }, logs, logsTruncated });
        }
        const text = JSON.stringify(m.value ?? null);
        if (text.length > RUN_LIMITS.maxResultChars) {
          return settle({ ok: false, error: { code: 'output_too_large', message: `The return value is ${text.length} characters (limit ${RUN_LIMITS.maxResultChars}). Write it with roku.fs.write and return the path.`, sandbox: true }, logs, logsTruncated });
        }
        settle({ ok: true, result: m.value ?? null, logs, logsTruncated });
      } else {
        settle({ ok: false, error: { code: 'protocol', message: 'The snippet sent a message roku_run does not understand.', sandbox: true }, logs: [] });
      }
    });

    child.on('exit', (code, signal) => {
      if (settled) return;
      const oom = /heap out of memory|Allocation failed/i.test(stderr) || signal === 'SIGABRT' || code === 134;
      settle({
        ok: false,
        error: oom
          ? { code: 'memory_limit', message: `The snippet used more than ${RUN_LIMITS.memoryMb} MB of heap and was stopped.`, sandbox: true }
          : { code: 'crashed', message: `The snippet process exited (${signal ?? `code ${code}`}) before returning.`, sandbox: true },
        logs: [],
      });
    });
    child.on('error', (error) => settle({ ok: false, error: { code: 'spawn_failed', message: error.message, sandbox: true }, logs: [] }));
  });
}
