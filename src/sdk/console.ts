/**
 * The BrightScript debug console (port 8085; an RCE WebSocket bridge on a Cloud Device).
 * Port 8085 takes one client, so there is one single-shot connection or one capture per process.
 */
import type { Duplex } from 'stream';
import fs from 'fs';
import path from 'path';
import { linearRegExp } from './linear-regexp.js';
import { friendlyError, resolveTarget, type TargetParams } from '../roku-config.js';
import { RokuError } from './errors.js';

const CONSOLE_PORT = 8085;
const MAX_KEPT_LINES = 50_000;
const PREVIEW_CHARS = 240;
const WAITING_FOR_DEBUGGER = /Waiting for debugger on/;

const CAPTURE_ACTIVE =
  'A console capture is active and holds port 8085 (single client). Use roku_console_wait, or read the capture file; stop it with roku_console_capture_stop to use the single-shot console tools again.';
const NOT_CONNECTED = 'No active console connection. Use roku_console_connect first.';

// --- Single-shot connection ------------------------------------------------------------------

interface ConsoleSession {
  socket: Duplex;
  buffer: string;
  host: string;
  connected: boolean;
}

let session: ConsoleSession | null = null;

export type ConnectResult = { connected: true; label: string; port: number } | { alreadyConnected: true; label: string };

/** Opens the console for one follow-up consoleRead or consoleSend. */
export async function consoleConnect(options: TargetParams & { port?: number } = {}): Promise<ConnectResult> {
  if (capture) throw new RokuError('capture_active', CAPTURE_ACTIVE, { bare: true });
  if (session?.connected) return { alreadyConnected: true, label: session.host };

  const target = await resolveTarget(options);
  const port = options.port ?? 8085;
  const socket = await target.connect(port, 10_000);
  const newSession: ConsoleSession = { socket, buffer: '', host: target.label, connected: true };
  session = newSession;
  socket.on('data', (data) => {
    if (session === newSession) session.buffer += data.toString();
  });
  socket.on('close', () => {
    if (session === newSession) session.connected = false;
  });
  socket.on('error', () => {
    if (session === newSession) session.connected = false;
  });
  return { connected: true, label: target.label, port };
}

function requireSession(): ConsoleSession {
  if (!session?.connected) throw new RokuError('not_connected', capture ? CAPTURE_ACTIVE : NOT_CONNECTED, { bare: true });
  return session;
}

function closeSession(): string {
  const host = session!.host;
  session!.socket.destroy();
  session = null;
  return host;
}

/** Output buffered since consoleConnect; closes the connection. */
export async function consoleRead(): Promise<{ output: string; label: string }> {
  const s = requireSession();
  await new Promise((r) => setTimeout(r, 200));
  const output = s.buffer;
  s.buffer = '';
  return { output, label: closeSession() };
}

/** Sends one command, returns what arrives within 500 ms, and closes the connection. */
export async function consoleSend(options: { command: string }): Promise<{ output: string; label: string }> {
  const s = requireSession();
  try {
    return await new Promise((resolve, reject) => {
      s.buffer = '';
      s.socket.write(options.command + '\r\n', (err) => {
        if (err) {
          const host = session?.host ?? 'unknown';
          if (session) closeSession();
          reject(new RokuError('send_failed', `Failed to send command: ${err.message} — disconnected from ${host}`, { bare: true }));
          return;
        }
        setTimeout(() => {
          const output = session!.buffer;
          session!.buffer = '';
          resolve({ output, label: closeSession() });
        }, 500);
      });
    });
  } catch (error) {
    if (session) closeSession();
    throw error;
  }
}

/** Closes the single-shot connection; null when there was none. */
export function consoleDisconnect(): { label: string } | null {
  return session ? { label: closeSession() } : null;
}

// --- Capture to file -------------------------------------------------------------------------

export type WaitPredicate = 'jwtValid';

export interface WaitResult {
  matched: boolean;
  reason?: 'timeout' | 'waiting_for_debugger' | 'capture_stopped';
  lineNumber?: number;
  timestamp?: string;
  preview?: string;
}

interface Waiter {
  regex: RegExp;
  predicate?: WaitPredicate;
  resolve: (r: WaitResult) => void;
}

interface CaptureSession {
  socket: Duplex;
  host: string;
  file: string;
  out: fs.WriteStream;
  startedAt: Date;
  writing: boolean;
  bytes: number;
  pending: string;
  lines: string[];
  lineCount: number;
  replayBytes: number;
  waiters: Set<Waiter>;
}

export interface CaptureSummary {
  active: boolean;
  file: string;
  host: string;
  startedAt: string;
  bytes: number;
  lines: number;
}

let capture: CaptureSession | null = null;

export function isCaptureActive(): boolean {
  return capture !== null;
}

/** Same naming as the VS Code BrightScript extension (U+2236 instead of ':') so files sort together. */
export function defaultLogFileName(date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}T${p(date.getHours())}\u2236${p(date.getMinutes())}\u2236${p(date.getSeconds())}`;
  return `${stamp}-rokuDevice.log`;
}

/** Splits streamed chunks into complete lines, carrying the partial tail over to the next chunk. */
export function splitLines(pending: string, chunk: string): { lines: string[]; pending: string } {
  const parts = (pending + chunk).split('\n');
  const rest = parts.pop() ?? '';
  return { lines: parts.map((l) => l.replace(/\r$/, '')), pending: rest };
}

/** True when the line carries an `Authorization: Bearer <jwt>` whose `exp` is in the future. */
export function hasValidJwt(line: string, now = Date.now()): boolean {
  const jwt = line.match(/Bearer\s+([\w-]+)\.([\w-]+)\.([\w-]*)/);
  if (!jwt) return false;
  try {
    const payload = JSON.parse(Buffer.from(jwt[2], 'base64url').toString('utf8'));
    return typeof payload.exp === 'number' && payload.exp * 1000 > now;
  } catch {
    return false;
  }
}

const JWT = linearRegExp('eyJ[\\w-]+\\.[\\w-]+\\.[\\w-]*', 'g');

/** Short, token-free excerpt safe to return to the agent. */
export function redactedPreview(line: string): string {
  // Linear engine: the backtracking form was quadratic on long runs of "eyJ".
  const redacted = line.replace(/(Bearer\s+)[\w.-]+/gi, '$1<redacted>').replace(JWT, '<jwt>');
  return redacted.length > PREVIEW_CHARS ? redacted.slice(0, PREVIEW_CHARS) + '…' : redacted;
}

function lineTimestamp(line: string): string | undefined {
  return line.match(/^\[([^\]]+)\]/)?.[1] ?? line.match(/^(\d\d-\d\d \d\d:\d\d:\d\d\.\d+)/)?.[1];
}

function lineMatches(line: string, regex: RegExp, predicate?: WaitPredicate): boolean {
  if (!regex.test(line)) return false;
  return predicate !== 'jwtValid' || hasValidJwt(line);
}

function onLine(s: CaptureSession, line: string): void {
  s.lineCount++;
  s.lines.push(line);
  if (s.lines.length > MAX_KEPT_LINES) s.lines.shift();

  for (const w of s.waiters) {
    if (lineMatches(line, w.regex, w.predicate)) {
      s.waiters.delete(w);
      w.resolve({ matched: true, lineNumber: s.lineCount, timestamp: lineTimestamp(line), preview: redactedPreview(line) });
    } else if (WAITING_FOR_DEBUGGER.test(line)) {
      s.waiters.delete(w);
      w.resolve({ matched: false, reason: 'waiting_for_debugger', lineNumber: s.lineCount, preview: redactedPreview(line) });
    }
  }
}

function endCapture(s: CaptureSession): Promise<void> {
  if (capture === s) capture = null;
  for (const w of s.waiters) w.resolve({ matched: false, reason: 'capture_stopped' });
  s.waiters.clear();
  if (s.pending) {
    s.out.write(s.pending);
    onLine(s, s.pending);
    s.pending = '';
  }
  s.socket.destroy();
  return new Promise((resolve) => s.out.end(() => resolve()));
}

function summary(s: CaptureSession): CaptureSummary {
  return { active: capture === s, file: s.file, host: s.host, startedAt: s.startedAt.toISOString(), bytes: s.bytes, lines: s.lineCount };
}

export interface CaptureStartOptions extends TargetParams {
  /** Log path; defaults to ./logs/<YYYY-MM-DDTHH∶MM∶SS>-rokuDevice.log. */
  file?: string;
  append?: boolean;
  /** Output received during this window after connecting (the replay of the previous session) is dropped. */
  settleMs?: number;
}

/** Records the console to a file until captureStop. Console text is never returned. */
export async function captureStart(options: CaptureStartOptions = {}): Promise<{ label: string; port: number; file: string; replayReceived: boolean }> {
  if (capture) throw new RokuError('capture_active', `Capture already active: ${JSON.stringify(summary(capture))}`, { bare: true });
  try {
    const target = await resolveTarget(options);
    const host = target.label;
    const file = path.resolve(options.file ?? path.join('logs', defaultLogFileName()));
    fs.mkdirSync(path.dirname(file), { recursive: true });

    const socket = await target.connect(CONSOLE_PORT, 10_000);
    const s: CaptureSession = {
      socket,
      host,
      file,
      out: fs.createWriteStream(file, { flags: options.append ? 'a' : 'w' }),
      startedAt: new Date(),
      writing: false,
      bytes: 0,
      pending: '',
      lines: [],
      lineCount: 0,
      replayBytes: 0,
      waiters: new Set(),
    };

    capture = s;
    socket.on('data', (data) => {
      const text = data.toString();
      if (!s.writing) {
        s.replayBytes += text.length;
        return;
      }
      s.out.write(text);
      s.bytes += text.length;
      const split = splitLines(s.pending, text);
      s.pending = split.pending;
      for (const line of split.lines) onLine(s, line);
    });
    socket.on('close', () => {
      if (capture === s) void endCapture(s);
    });
    socket.on('error', () => {
      if (capture === s) void endCapture(s);
    });

    await new Promise((r) => setTimeout(r, options.settleMs ?? 2000));
    s.writing = true;
    s.startedAt = new Date();
    return { label: host, port: CONSOLE_PORT, file, replayReceived: s.replayBytes > 0 };
  } catch (error) {
    if (capture) await endCapture(capture);
    throw error;
  }
}

export interface WaitOptions {
  /** JavaScript regular expression tested against each line. */
  pattern: string;
  /**
   * Compile with V8's linear-time engine (no backreferences or lookarounds), so a pattern cannot
   * stall the server on a long line. roku_run sets it for snippet patterns.
   */
  linear?: boolean;
  timeoutMs?: number;
  predicate?: WaitPredicate;
  /** Also match lines already captured (default true). */
  sinceCaptureStart?: boolean;
}

/** Waits for a matching line in the active capture; the preview is redacted, the full line is in the file. */
export async function consoleWait(options: WaitOptions): Promise<WaitResult & { file: string }> {
  const s = capture;
  if (!s) throw new RokuError('no_capture', 'No active capture. Call roku_console_capture_start first.', { bare: true });
  let regex: RegExp;
  try {
    regex = options.linear ? linearRegExp(options.pattern) : new RegExp(options.pattern);
  } catch (error) {
    const hint = options.linear ? ' (roku_run patterns run in linear time: no backreferences or lookarounds)' : '';
    throw new RokuError('bad_pattern', `Invalid pattern: ${friendlyError(error)}${hint}`, { bare: true });
  }
  const predicate = options.predicate;

  if (options.sinceCaptureStart ?? true) {
    const offset = s.lineCount - s.lines.length;
    const idx = s.lines.findIndex((l) => lineMatches(l, regex, predicate));
    if (idx >= 0) {
      const line = s.lines[idx];
      return { matched: true, lineNumber: offset + idx + 1, timestamp: lineTimestamp(line), preview: redactedPreview(line), file: s.file };
    }
  }

  const result = await new Promise<WaitResult>((resolve) => {
    const waiter: Waiter = {
      regex,
      predicate,
      resolve: (r) => {
        clearTimeout(timer);
        resolve(r);
      },
    };
    const timer = setTimeout(() => {
      s.waiters.delete(waiter);
      resolve({ matched: false, reason: 'timeout' });
    }, options.timeoutMs ?? 120_000);
    s.waiters.add(waiter);
  });
  return { ...result, file: s.file };
}

/** Stops the capture and flushes the file; null when none was active. */
export async function captureStop(): Promise<CaptureSummary | null> {
  const s = capture;
  if (!s) return null;
  await endCapture(s);
  return summary(s);
}

export function captureStatus(): CaptureSummary | { active: false } {
  return capture ? summary(capture) : { active: false };
}
