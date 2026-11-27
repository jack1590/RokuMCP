/**
 * The program a roku_run child process executes (passed with -e; it imports nothing).
 *
 * The child runs with Node's permission model and no grants: no file system, no child
 * processes, no workers, no addons, no inspector, and an empty environment. It holds no SDK
 * code and no secrets. `roku.<group>.<call>(options)` and `roku.fs.*` are proxies that send each
 * call over IPC to the parent, which validates it, runs it and answers with plain JSON.
 */
type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

const MAX_LOG_CHARS = 64 * 1024;
const pending = new Map<number, Pending>();
const logs: string[] = [];
let logChars = 0;
let logsTruncated = false;
let seq = 0;

class RokuRunError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'RokuError';
    this.code = code;
  }
}

const send = (message: unknown) => (process as unknown as { send(m: unknown): void }).send(message);

function format(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function log(level: string, args: unknown[]): void {
  const line = (level === 'log' ? '' : `[${level}] `) + args.map(format).join(' ');
  if (logChars + line.length > MAX_LOG_CHARS) {
    logsTruncated = true;
    return;
  }
  logChars += line.length;
  logs.push(line);
}

const consoleShim = Object.freeze({
  log: (...a: unknown[]) => log('log', a),
  info: (...a: unknown[]) => log('info', a),
  warn: (...a: unknown[]) => log('warn', a),
  error: (...a: unknown[]) => log('error', a),
});

function call(name: string, args: unknown[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    send({ type: 'call', id, name, args });
  });
}

// `then` is excluded so `await roku.ui` does not look like a thenable.
const group = (name: string) =>
  new Proxy({}, { get: (_t, method) => (typeof method === 'string' && method !== 'then' ? (...args: unknown[]) => call(`${name}.${method}`, args) : undefined) });
const roku = new Proxy({}, { get: (_t, name) => (typeof name === 'string' && name !== 'then' ? group(name) : undefined) });

/** The snippet's return value as JSON, or an error when it cannot be serialized. */
function toJson(value: unknown): { value?: unknown; error?: { code: string; message: string } } {
  try {
    const text = JSON.stringify(value === undefined ? null : value, (_k, v) => (typeof v === 'bigint' ? Number(v) : v));
    return { value: text === undefined ? null : JSON.parse(text) };
  } catch (e) {
    return { error: { code: 'unserializable_result', message: `The return value is not JSON: ${(e as Error).message}` } };
  }
}

process.on('message', async (raw: unknown) => {
  const m = raw as { type?: string; id?: number; value?: unknown; error?: { code: string; message: string }; code?: string };
  if (m.type === 'result' && typeof m.id === 'number') {
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.error) p.reject(new RokuRunError(m.error.code, m.error.message));
    else p.resolve(m.value);
    return;
  }
  if (m.type === 'run' && typeof m.code === 'string') {
    let outcome: { value?: unknown; error?: { code: string; message: string } };
    try {
      const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...a: string[]) => (...a: unknown[]) => Promise<unknown>;
      const fn = new AsyncFunction('roku', 'console', m.code);
      outcome = toJson(await fn(roku, consoleShim));
    } catch (e) {
      const err = e as { code?: unknown; message?: unknown } | null;
      const code = typeof err?.code === 'string' ? err.code : 'snippet_error';
      outcome = { error: { code, message: String(err?.message ?? e) } };
    }
    send({ type: 'done', ...outcome, logs, logsTruncated });
  }
});
send({ type: 'ready' });

export {};
