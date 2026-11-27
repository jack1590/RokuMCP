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
import { stopRunStartedHere } from '../sdk/rce.js';
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
  maxArgChars: 1024 * 1024,
  maxParseBytes: 5 * 1024 * 1024,
  /** Calls running at once across all runs; more wait in a queue (CPU-heavy parses cannot pile up). */
  maxInFlight: 2,
  /** Longest a call holds a work slot. */
  maxSlotMs: 60_000,
  /** Waits (sleep, console wait, observe, Cloud Device start/stop) one run may have at once. */
  maxWaitsPerRun: 8,
  /** ...and across all runs: waits only hold sockets, so this is high, but bounded. */
  maxWaitsTotal: 64,
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

/**
 * Calls a snippet may not make. perfetto.query hands SQL to trace_processor, which runs with the
 * server's rights; its SQLite can ATTACH any database and EXPORT_JSON overwrites any file, and no
 * text filter closes that reliably.
 */
const NOT_IN_CODE_MODE: Record<string, string> = {
  'perfetto.query':
    'roku.perfetto.query is not available in roku_run: trace_processor runs SQL with the server\'s rights. Use roku.perfetto.analyze, or the query_perfetto tool in full mode.',
};

/** Every call name a snippet may use, for the docs tool. */
export const CALL_NAMES = [...BY_CALL.keys(), 'fs.read', 'fs.write', 'fs.list'].filter((n) => !Object.hasOwn(NOT_IN_CODE_MODE, n));

/** Options the SDK reads from (outDir and file, which it writes to, must be in the output folder). */
const READ_KEYS = ['filePath', 'beforePath', 'afterPath', 'charlesSessionPath'];

/** Error codes only roku_run itself reports; a snippet cannot claim them. */
const SANDBOX_CODES = new Set(['timeout', 'memory_limit', 'crashed', 'protocol', 'spawn_failed', 'unsupported_node', 'sandbox_unsafe', 'output_too_large']);
const MAX_ERROR_CHARS = 2000;
/** Ends where roku_run stopped the script itself: its own cleanup did not run. */
const KILLED = new Set(['timeout', 'memory_limit', 'crashed', 'protocol']);

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

/** Calls that only wait (device, console, observer, Cloud Device start/stop): they use the wait lane. */
const WAIT_CALLS = new Set(['device.sleep', 'console.wait', 'console.capture', 'console.captureStart', 'rta.observe', 'rce.start', 'rce.stop']);

interface Lane {
  max: number;
  /** Longest a call holds a slot; then it stops counting, so one hung call cannot block every later run. */
  holdMs: number;
  inFlight: number;
  queue: Array<{ owner: Dispatcher; resolve: () => void }>;
}

/**
 * Server-wide lanes shared by every roku_run: CPU or I/O work, and waits. Parallel runs cannot add up
 * parses, and waits (which hold sockets for minutes) are bounded too.
 */
const LANES: Record<'work' | 'wait', Lane> = {
  work: { max: RUN_LIMITS.maxInFlight, holdMs: RUN_LIMITS.maxSlotMs, inFlight: 0, queue: [] },
  wait: { max: RUN_LIMITS.maxWaitsTotal, holdMs: RUN_LIMITS.maxTimeoutMs + 10_000, inFlight: 0, queue: [] },
};

/** A LAN host as an address only: no port or path, so a script cannot aim a call at any service. */
const PLAIN_HOST = /^(?:[A-Za-z0-9][A-Za-z0-9-]*(?:\.[A-Za-z0-9-]+)*|\[[0-9A-Fa-f:.]+\]|[0-9A-Fa-f:]+(?:\.[0-9.]+)?)$/;
// The length cap comes first: it bounds the regex work on any input.
const plainHost = (h: unknown) => typeof h === 'string' && h.length <= 255 && PLAIN_HOST.test(h);

/** Wait options a script may set, capped at the longest run. */
const WAIT_KEYS = ['timeoutMs', 'durationMs', 'settleMs'];
/** Per-key delays in key sequences and typing. */
const MAX_DELAY_MS = 10_000;

class Dispatcher {
  calls = 0;
  readonly files = new Set<string>();
  /** Set when the run's result is decided: its queued calls are dropped, not started. */
  closed = false;
  /** This run's calls waiting for a free slot. */
  queued = 0;
  /** Cloud Device starts this run made: the device, and whether a Run may have been started. */
  private readonly rceStarts: Array<{ ref: string | undefined; outcome: Promise<boolean>; done: boolean }> = [];

  /**
   * After roku_run killed the script: stops each Cloud Device Run it started. A start still in
   * flight is stopped once it finishes. Resolves with a sentence for the error message.
   */
  async stopRunsAfterKill(): Promise<string> {
    if (this.rceStarts.length === 0) return '';
    const notes: string[] = [];
    const stop = async (ref: string | undefined) => {
      try {
        const r = await stopRunStartedHere(ref);
        return r.stopped ? `Stopped the Cloud Device Run it started on device ${r.deviceId}.` : '';
      } catch (error) {
        return `Could not stop the Cloud Device Run it started (${describeError(error).message}): it may still be billing; check roku_rce_status.`;
      }
    };
    for (const s of this.rceStarts) {
      if (s.done) {
        if (await s.outcome) notes.push(await stop(s.ref));
      } else {
        // Still starting: stop it as soon as the start returns (it bills from the start request).
        void s.outcome.then((started) => (started ? stop(s.ref) : ''));
        notes.push('A Cloud Device Run it was still starting will be stopped once it is up.');
      }
    }
    return notes.filter(Boolean).map((n) => ' ' + n).join('');
  }
  /** This run's waits in flight (still counted after the run ends, until they finish). */
  private waits = 0;

  /** Runs dispatch in its lane (at most lane.max calls at once across all runs). */
  async enqueue(name: unknown, args: unknown): Promise<unknown> {
    const isWait = typeof name === 'string' && WAIT_CALLS.has(name);
    const lane = isWait ? LANES.wait : LANES.work;
    if (isWait && this.waits >= RUN_LIMITS.maxWaitsPerRun) {
      throw new RokuError('too_many_waits', `At most ${RUN_LIMITS.maxWaitsPerRun} waits (sleep, console wait, observe, Cloud Device start/stop) at once per run.`);
    }
    while (lane.inFlight >= lane.max && !this.closed) {
      this.queued++;
      await new Promise<void>((resolve) => lane.queue.push({ owner: this, resolve }));
      this.queued--;
    }
    if (this.closed) throw new RokuError('run_ended', 'The run ended before this call started.');
    // The slot is freed when the call really finishes, even after its run ended (a script that
    // returns without awaiting must not get fresh slots), or after lane.holdMs at most.
    lane.inFlight++;
    if (isWait) this.waits++;
    let held = true;
    const release = () => {
      if (!held) return;
      held = false;
      lane.inFlight--;
      if (isWait) this.waits--;
      // Wake one waiter per freed slot, after an event-loop turn so a run's timeout can fire.
      setImmediate(() => lane.queue.shift()?.resolve());
    };
    const cap = setTimeout(release, lane.holdMs);
    cap.unref();
    try {
      return await this.dispatch(name, args);
    } finally {
      clearTimeout(cap);
      release();
    }
  }

  close(): void {
    this.closed = true;
    for (const lane of Object.values(LANES)) {
      for (let i = lane.queue.length - 1; i >= 0; i--) {
        if (lane.queue[i].owner === this) lane.queue.splice(i, 1)[0].resolve();
      }
    }
  }

  constructor(private readonly policy: PathPolicy, private readonly target: TargetParams) {}

  async dispatch(name: unknown, args: unknown): Promise<unknown> {
    if (++this.calls > RUN_LIMITS.maxCalls) throw new RokuError('too_many_calls', `More than ${RUN_LIMITS.maxCalls} calls in one run.`);
    if (typeof name !== 'string' || !Array.isArray(args)) throw new RokuError('protocol', 'Malformed call.');
    if (name.startsWith('fs.')) return this.fs(name, args);

    if (Object.hasOwn(NOT_IN_CODE_MODE, name)) throw new RokuError('not_in_code_mode', NOT_IN_CODE_MODE[name]);
    const command = BY_CALL.get(name);
    if (!command) throw new RokuError('unknown_call', `roku.${name} does not exist. List the calls with roku_sdk_docs.`);
    // A huge argument costs the server CPU in validation and error formatting before any check.
    const argChars = JSON.stringify(args).length;
    if (argChars > RUN_LIMITS.maxArgChars) throw new RokuError('too_large', `roku.${name} arguments are ${argChars} characters; the limit is ${RUN_LIMITS.maxArgChars}.`);
    const options = args[0] ?? {};
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new RokuError('bad_args', `roku.${name} takes one options object, e.g. roku.${name}({ ... }).`);
    }
    const shape = commandShape(command);
    const merged = 'host' in shape || 'rceDevice' in shape ? withDefaults(this.target, options as object) : options;
    const valid = parseCommandInput(command, merged);
    if (!valid.success) {
      const all = valid.error.issues;
      const issues = all.slice(0, 20).map((i) => `${i.path.join('.').slice(0, 100) || '(options)'}: ${i.message.slice(0, 200)}`).join('; ') + (all.length > 20 ? `; and ${all.length - 20} more` : '');
      throw new RokuError('bad_args', `Invalid options for roku.${name}: ${issues}`);
    }
    const input = valid.data as Record<string, unknown>;
    if (input.host !== undefined && !plainHost(input.host)) {
      throw new RokuError('bad_args', 'host must be an IP address or host name, without a port or path.');
    }
    for (const key of WAIT_KEYS) {
      if (typeof input[key] === 'number') input[key] = Math.min(input[key] as number, RUN_LIMITS.maxTimeoutMs);
    }
    if (typeof input.delayMs === 'number') input.delayMs = Math.min(input.delayMs, MAX_DELAY_MS);
    this.defaults(command, input);
    this.checkPaths(input);
    // bsprof-cli matches this glob with minimatch for every record; even plain * globs backtrack
    // exponentially on a long file name, on the server's event loop.
    if (input.filterFile !== undefined) {
      throw new RokuError('bad_args', 'filterFile cannot be set from roku_run; use filterModule or excludeModule, or filter the report in the script.');
    }
    // Snippet-chosen files and URLs: bounded size and time before parsing on the server.
    if (command.name === 'stream.diagnose') input.limits = { maxBytes: RUN_LIMITS.maxParseBytes, timeoutMs: 15_000 };
    // A snippet's regex runs on the server's event loop: linear time only (no ReDoS).
    if (command.name === 'console.wait' || command.name === 'console.capture') input.linear = true;
    if (command.name === 'rce.start') return toPlain(await this.trackStart(command, input)).data;
    return toPlain(await command.run(input)).data;
  }

  /** Records a Cloud Device start so a killed script's Run can be stopped. */
  private trackStart(command: Command, input: Record<string, unknown>): Promise<unknown> {
    const call = Promise.resolve(command.run(input));
    const entry = {
      ref: (input.rceDevice as string | undefined) || process.env.ROKU_RCE_DEVICE,
      done: false,
      // A refused start (the device already had a Run) started nothing; any other outcome may have.
      outcome: call.then(
        () => true,
        (e: unknown) => !(e instanceof RokuError && e.code === 'run_exists')
      ),
    };
    void entry.outcome.then(() => (entry.done = true));
    this.rceStarts.push(entry);
    return call;
  }

  private checkPaths(input: Record<string, unknown>): void {
    if (input.stagingDir !== undefined) throw new RokuError('path_denied', 'stagingDir cannot be set from roku_run (roku-deploy empties and deletes it); the default temp folder is used.');
    // Glob patterns cannot be checked reliably as text ([.]env, @(.env)): deploy the whole folder instead.
    if (input.files !== undefined) throw new RokuError('path_denied', 'files cannot be set from roku_run; deploy a build folder that holds only the channel.');
    if (input.rootDir !== undefined) input.rootDir = this.policy.resolveDeployRoot(input.rootDir);
    if (input.outFile !== undefined) this.policy.checkFileName(input.outFile, 'outFile');
    for (const key of READ_KEYS) if (input[key] !== undefined) input[key] = this.policy.resolveRead(input[key], key);
    if (input.outDir !== undefined) input.outDir = this.policy.resolveWrite(input.outDir, 'outDir');
    if (input.file !== undefined) input.file = this.policy.resolveWriteFile(input.file, 'file');
    if (input.outDir !== undefined || input.file !== undefined) this.policy.ensureOutputDir();
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
        const abs = this.policy.resolveWriteFile(p);
        this.policy.ensureOutputDir();
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        // Check again after mkdir, and never follow a link at the final name.
        this.policy.resolveWriteFile(abs);
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
      dispatcher.close();
      clearTimeout(timer);
      if (child.exitCode === null) child.kill('SIGKILL');
      const finish = () => resolve({ ...r, files: [...dispatcher.files], calls: dispatcher.calls });
      // The script was killed, so its finally blocks never ran: stop the Runs it started.
      if (r.error?.sandbox && KILLED.has(r.error.code)) {
        void dispatcher.stopRunsAfterKill().then((note) => {
          if (note && r.error) r.error.message += note;
          finish();
        });
      } else {
        finish();
      }
    };
    const timer = setTimeout(
      () => {
        const busy = dispatcher.queued ? ` ${dispatcher.queued} of its calls were still waiting for a free slot: other runs' calls are holding them.` : '';
        settle({ ok: false, error: { code: 'timeout', message: `roku_run stopped the snippet after ${timeoutMs} ms. A device call already in progress may still finish; no new calls run.${busy}`, sandbox: true }, logs: [] });
      },
      timeoutMs
    );

    let started = false;
    child.on('message', (raw: unknown) => {
      if (settled) return; // no new call starts after the result is decided (calls already running finish)
      const m = raw as { type?: unknown; id?: unknown; name?: unknown; args?: unknown; value?: unknown; error?: unknown; logs?: unknown; logsTruncated?: unknown; reason?: unknown };
      if (m?.type === 'unsafe' && !started) {
        return settle({ ok: false, error: { code: 'sandbox_unsafe', message: `roku_run refused to run the snippet: ${String(m.reason).slice(0, 200)}. Use a Node.js release where this is closed.`, sandbox: true }, logs: [] });
      }
      if (m?.type === 'ready' && !started) {
        started = true;
        child.send({ type: 'run', code: options.code });
      } else if (m?.type === 'call' && typeof m.id === 'number' && started) {
        const id = m.id;
        dispatcher.enqueue(m.name, m.args).then(
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
      // V8 aborts on heap exhaustion. The snippet cannot raise SIGABRT itself (process.abort and
      // process.kill are removed), and an exit code or stderr text alone is not trusted.
      const oom = signal === 'SIGABRT' && /heap out of memory|Allocation failed/i.test(stderr);
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
