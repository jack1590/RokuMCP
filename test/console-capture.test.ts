/**
 * Console capture: pure helpers plus an end-to-end run of the capture/wait/stop
 * tools against a fake 8085 server on localhost (no device needed).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  defaultLogFileName,
  splitLines,
  hasValidJwt,
  redactedPreview,
  registerConsoleCaptureTools,
} from '../src/tools/console-capture.js';

function jwt(exp: number): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64({ exp })}.sig`;
}

const future = Math.floor(Date.now() / 1000) + 3600;
const past = Math.floor(Date.now() / 1000) - 3600;

test('defaultLogFileName matches the VS Code extension naming', () => {
  assert.equal(defaultLogFileName(new Date(2026, 9, 15, 9, 5, 7)), '2026-10-15T09\u223605\u223607-rokuDevice.log');
});

test('splitLines carries partial lines across chunks', () => {
  const a = splitLines('', 'one\ntw');
  assert.deepEqual(a, { lines: ['one'], pending: 'tw' });
  const b = splitLines(a.pending, 'o\r\nthree');
  assert.deepEqual(b, { lines: ['two'], pending: 'three' });
});

test('hasValidJwt checks the Bearer token exp', () => {
  assert.equal(hasValidJwt(`-H 'Authorization: Bearer ${jwt(future)}'`), true);
  assert.equal(hasValidJwt(`-H 'Authorization: Bearer ${jwt(past)}'`), false);
  assert.equal(hasValidJwt('no token here'), false);
  assert.equal(hasValidJwt("-H 'Authorization: Bearer not.a-jwt.x'"), false);
});

test('redactedPreview strips tokens and truncates', () => {
  const line = `curl -H 'Authorization: Bearer ${jwt(future)}' -d '{"x":"${'a'.repeat(500)}"}'`;
  const preview = redactedPreview(line);
  assert.ok(!preview.includes(jwt(future)));
  assert.ok(preview.includes('Bearer <redacted>'));
  assert.ok(preview.length <= 241);
});

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;

function toolHandlers(): Record<string, Handler> {
  const server = new McpServer({ name: 't', version: '0' });
  const handlers: Record<string, Handler> = {};
  const original = server.registerTool.bind(server);
  (server as unknown as { registerTool: unknown }).registerTool = (name: string, config: unknown, cb: Handler) => {
    handlers[name] = cb;
    return original(name, config as never, cb as never);
  };
  registerConsoleCaptureTools(server);
  return handlers;
}

test('capture skips replay, records new output and waits for a valid-token curl', async () => {
  const sockets: net.Socket[] = [];
  const fake = net.createServer((s) => {
    sockets.push(s);
    s.write('REPLAY old session line\n');
  });
  // The tools always dial 8085; skip when the port is taken (e.g. a real console proxy).
  const listening = await new Promise<boolean>((resolve) => {
    fake.once('error', () => resolve(false));
    fake.listen(8085, '127.0.0.1', () => resolve(true));
  });
  if (!listening) return;

  try {
    const tools = toolHandlers();
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'cap-')), 'out.log');

    const started = await tools.roku_console_capture_start({ host: '127.0.0.1', file, settleMs: 200 });
    assert.ok(!started.isError, started.content[0].text);

    const waiting = tools.roku_console_wait({ pattern: 'query Startup\\b', predicate: 'jwtValid', timeoutMs: 3000, sinceCaptureStart: true });
    const s = sockets[0];
    s.write(`[t1][HTTP] curl -X POST 'u' -H 'Authorization: Bearer ${jwt(past)}' -d '{"query":"query Startup {}"}'\n`);
    s.write(`[t2][HTTP] curl -X POST 'u' -H 'Authorization: Bearer ${jwt(future)}' -d '{"query":"query Sta`);
    s.write('rtup {}"}\'\n');

    const waited = JSON.parse((await waiting).content[0].text);
    assert.equal(waited.matched, true);
    assert.equal(waited.timestamp, 't2');
    assert.equal(waited.lineNumber, 2);
    assert.ok(!waited.preview.includes(jwt(future)));

    const again = JSON.parse((await tools.roku_console_wait({ pattern: 'query Startup\\b', timeoutMs: 100 })).content[0].text);
    assert.equal(again.lineNumber, 1, 'sinceCaptureStart scans already captured lines');

    const stopped = JSON.parse((await tools.roku_console_capture_stop({})).content[0].text);
    assert.equal(stopped.active, false);
    assert.equal(stopped.lines, 2);

    const written = readFileSync(file, 'utf8');
    assert.ok(!written.includes('REPLAY'), 'replayed output is skipped');
    assert.ok(written.includes('[t2]'));
  } finally {
    sockets.forEach((s) => s.destroy());
    await new Promise((r) => fake.close(r));
  }
});

test('wait reports waiting_for_debugger', async () => {
  const sockets: net.Socket[] = [];
  const fake = net.createServer((s) => sockets.push(s));
  const listening = await new Promise<boolean>((resolve) => {
    fake.once('error', () => resolve(false));
    fake.listen(8085, '127.0.0.1', () => resolve(true));
  });
  if (!listening) return;

  try {
    const tools = toolHandlers();
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'cap-')), 'out.log');
    await tools.roku_console_capture_start({ host: '127.0.0.1', file, settleMs: 100 });
    const waiting = tools.roku_console_wait({ pattern: 'never', timeoutMs: 3000 });
    sockets[0].write('10-15 15:44:01.636 sdkl [plg.dbg.conn.wait] Waiting for debugger on 1.2.3.4:8081\n');
    const res = JSON.parse((await waiting).content[0].text);
    assert.deepEqual([res.matched, res.reason], [false, 'waiting_for_debugger']);
    await tools.roku_console_capture_stop({});
  } finally {
    sockets.forEach((s) => s.destroy());
    await new Promise((r) => fake.close(r));
  }
});

test('wait times out and errors without an active capture', async () => {
  const tools = toolHandlers();
  const res = await tools.roku_console_wait({ pattern: 'x', timeoutMs: 10 });
  assert.equal(res.isError, true);
});
