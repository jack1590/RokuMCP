import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import net from 'net';
import fs from 'fs';
import path from 'path';
import { resolveHost, friendlyError } from '../roku-config.js';

const CONSOLE_PORT = 8085;
const MAX_KEPT_LINES = 50_000;
const PREVIEW_CHARS = 240;
const WAITING_FOR_DEBUGGER = /Waiting for debugger on/;

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
  socket: net.Socket;
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

/** Short, token-free excerpt safe to return to the agent. */
export function redactedPreview(line: string): string {
  const redacted = line.replace(/(Bearer\s+)[\w.-]+/gi, '$1<redacted>').replace(/eyJ[\w-]+\.[\w-]+\.[\w-]*/g, '<jwt>');
  return redacted.length > PREVIEW_CHARS ? redacted.slice(0, PREVIEW_CHARS) + '…' : redacted;
}

function lineTimestamp(line: string): string | undefined {
  return line.match(/^\[([^\]]+)\]/)?.[1] ?? line.match(/^(\d\d-\d\d \d\d:\d\d:\d\d\.\d+)/)?.[1];
}

function lineMatches(line: string, regex: RegExp, predicate?: WaitPredicate): boolean {
  if (!regex.test(line)) return false;
  return predicate !== 'jwtValid' || hasValidJwt(line);
}

function onLine(session: CaptureSession, line: string): void {
  session.lineCount++;
  session.lines.push(line);
  if (session.lines.length > MAX_KEPT_LINES) session.lines.shift();

  for (const w of session.waiters) {
    if (lineMatches(line, w.regex, w.predicate)) {
      session.waiters.delete(w);
      w.resolve({ matched: true, lineNumber: session.lineCount, timestamp: lineTimestamp(line), preview: redactedPreview(line) });
    } else if (WAITING_FOR_DEBUGGER.test(line)) {
      session.waiters.delete(w);
      w.resolve({ matched: false, reason: 'waiting_for_debugger', lineNumber: session.lineCount, preview: redactedPreview(line) });
    }
  }
}

function endCapture(session: CaptureSession): Promise<void> {
  if (capture === session) capture = null;
  for (const w of session.waiters) w.resolve({ matched: false, reason: 'capture_stopped' });
  session.waiters.clear();
  if (session.pending) {
    session.out.write(session.pending);
    onLine(session, session.pending);
    session.pending = '';
  }
  session.socket.destroy();
  return new Promise((resolve) => session.out.end(() => resolve()));
}

function summary(session: CaptureSession): string {
  return JSON.stringify({ active: capture === session, file: session.file, host: session.host, startedAt: session.startedAt.toISOString(), bytes: session.bytes, lines: session.lineCount });
}

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

export function registerConsoleCaptureTools(server: McpServer): void {
  server.registerTool(
    'roku_console_capture_start',
    {
      description:
        'Start recording the BrightScript debug console (port 8085) to a file, keeping the connection open until roku_console_capture_stop. ' +
        'Output from before the capture (the console replays the previous session on connect) is skipped. Console text is never returned; use roku_console_wait to detect lines. ' +
        'Port 8085 accepts a single client: detach the VS Code BrightScript debugger first.',
      inputSchema: {
        host: z.string().optional().describe('IP address or hostname of the Roku device'),
        file: z.string().optional().describe('Absolute or cwd-relative log path. Defaults to ./logs/<YYYY-MM-DDTHH∶MM∶SS>-rokuDevice.log'),
        append: z.boolean().optional().default(false).describe('Append to the file instead of truncating it'),
        settleMs: z.number().optional().default(2000).describe('Discard console output received during this window after connecting (replay of the previous session)'),
      },
    },
    async (params): Promise<ToolResult> => {
      if (capture) {
        return { content: [{ type: 'text', text: `Capture already active: ${summary(capture)}` }], isError: true };
      }
      try {
        const host = await resolveHost(params);
        const file = path.resolve(params.file ?? path.join('logs', defaultLogFileName()));
        fs.mkdirSync(path.dirname(file), { recursive: true });

        const socket = new net.Socket();
        const session: CaptureSession = {
          socket,
          host,
          file,
          out: fs.createWriteStream(file, { flags: params.append ? 'a' : 'w' }),
          startedAt: new Date(),
          writing: false,
          bytes: 0,
          pending: '',
          lines: [],
          lineCount: 0,
          replayBytes: 0,
          waiters: new Set(),
        };

        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            socket.destroy();
            reject(new Error(`Connection to ${host}:${CONSOLE_PORT} timed out`));
          }, 10_000);
          socket.once('error', (err) => {
            clearTimeout(timeout);
            reject(err);
          });
          socket.connect(CONSOLE_PORT, host, () => {
            clearTimeout(timeout);
            resolve();
          });
        });

        capture = session;
        socket.on('data', (data) => {
          const text = data.toString();
          if (!session.writing) {
            session.replayBytes += text.length;
            return;
          }
          session.out.write(text);
          session.bytes += text.length;
          const split = splitLines(session.pending, text);
          session.pending = split.pending;
          for (const line of split.lines) onLine(session, line);
        });
        socket.on('close', () => {
          if (capture === session) void endCapture(session);
        });
        socket.on('error', () => {
          if (capture === session) void endCapture(session);
        });

        await new Promise((r) => setTimeout(r, params.settleMs ?? 2000));
        session.writing = true;
        session.startedAt = new Date();

        const note =
          session.replayBytes === 0
            ? ' No console output received yet; if nothing arrives after launching, port 8085 may be held by another client (e.g. the VS Code BrightScript debugger).'
            : '';
        return { content: [{ type: 'text', text: `Capturing ${host}:${CONSOLE_PORT} to ${file}.${note}` }] };
      } catch (error) {
        if (capture) await endCapture(capture);
        return { content: [{ type: 'text', text: `Console capture failed: ${friendlyError(error)}` }], isError: true };
      }
    }
  );

  server.registerTool(
    'roku_console_wait',
    {
      description:
        'Wait until a console line matching a regex appears in the active capture (see roku_console_capture_start). ' +
        'Returns line number, timestamp and a short redacted preview; the full line is in the capture file. ' +
        'Resolves early with reason "waiting_for_debugger" if the channel is blocked waiting for the VS Code debugger (redeploy it with roku_deploy).',
      inputSchema: {
        pattern: z.string().describe('JavaScript regular expression tested against each console line'),
        timeoutMs: z.number().optional().default(120_000).describe('Maximum time to wait (default 120000)'),
        predicate: z.enum(['jwtValid']).optional().describe('jwtValid: only accept lines whose "Authorization: Bearer <jwt>" has a future exp'),
        sinceCaptureStart: z.boolean().optional().default(true).describe('Also match lines already captured; false = only lines arriving after this call'),
      },
    },
    async (params): Promise<ToolResult> => {
      const session = capture;
      if (!session) {
        return { content: [{ type: 'text', text: 'No active capture. Call roku_console_capture_start first.' }], isError: true };
      }
      let regex: RegExp;
      try {
        regex = new RegExp(params.pattern);
      } catch (error) {
        return { content: [{ type: 'text', text: `Invalid pattern: ${friendlyError(error)}` }], isError: true };
      }
      const predicate = params.predicate as WaitPredicate | undefined;

      if (params.sinceCaptureStart ?? true) {
        const offset = session.lineCount - session.lines.length;
        const idx = session.lines.findIndex((l) => lineMatches(l, regex, predicate));
        if (idx >= 0) {
          const line = session.lines[idx];
          const result: WaitResult = { matched: true, lineNumber: offset + idx + 1, timestamp: lineTimestamp(line), preview: redactedPreview(line) };
          return { content: [{ type: 'text', text: JSON.stringify({ ...result, file: session.file }) }] };
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
          session.waiters.delete(waiter);
          resolve({ matched: false, reason: 'timeout' });
        }, params.timeoutMs ?? 120_000);
        session.waiters.add(waiter);
      });
      return { content: [{ type: 'text', text: JSON.stringify({ ...result, file: session.file }) }] };
    }
  );

  server.registerTool(
    'roku_console_capture_stop',
    {
      description: 'Stop the active console capture, flush and close the file. Returns file path, bytes and line count.',
    },
    async (): Promise<ToolResult> => {
      const session = capture;
      if (!session) {
        return { content: [{ type: 'text', text: 'No active capture.' }] };
      }
      await endCapture(session);
      return { content: [{ type: 'text', text: summary(session) }] };
    }
  );

  server.registerTool(
    'roku_console_capture_status',
    {
      description: 'Report whether a console capture is active, its file, bytes and line count.',
    },
    async (): Promise<ToolResult> => ({
      content: [{ type: 'text', text: capture ? summary(capture) : JSON.stringify({ active: false }) }],
    })
  );
}
