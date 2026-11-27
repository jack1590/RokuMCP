#!/usr/bin/env node
/**
 * Full mode vs code mode: context size of tools/list, and MCP calls, bytes and wall time for
 * three flows, against the fake devices from the test suite (no real device, no billed RCE,
 * no model calls). Tokens are estimated as bytes / 4.
 *
 *   npm run build:test && node scripts/bench.mjs
 *
 * Writes bench/results.json and prints a table.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(repo, 'dist-test');
if (!fs.existsSync(path.join(dist, 'src', 'index.js'))) {
  console.error('Run "npm run build:test" first.');
  process.exit(2);
}
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
const { buildServer } = await import(path.join(dist, 'src', 'index.js'));
const { setRceClientFactory } = await import(path.join(dist, 'src', 'rce.js'));
const { FakeWorld, stubRce } = await import(path.join(dist, 'test', 'helpers', 'fakes.js'));

for (const k of Object.keys(process.env)) if (k.startsWith('ROKU_')) delete process.env[k];
process.env.ROKU_RCE_PASSWORD = 'bench';
const world = new FakeWorld();
setRceClientFactory(() => stubRce(world));

// roku_run confines paths to the server's working directory: run inside a scratch copy of the fixture app.
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'roku-bench-'));
fs.cpSync(path.join(repo, 'test', 'fixtures', 'app'), path.join(work, 'app'), { recursive: true });
process.chdir(work);

const T = { rceDevice: '400' };
const SETTLE = 100; // ms; real flows use 500-2000, kept short so the bench is quick

/** Each flow as the tool calls a full-mode agent makes, and as one roku_run snippet. */
const FLOWS = [
  {
    name: 'deploy, then verify a label',
    full: [
      ['roku_deploy', { ...T, rootDir: path.join(work, 'app') }],
      ['roku_sleep', { durationMs: SETTLE }],
      ['roku_find_node', { ...T, attr: 'text', value: 'Hello' }],
    ],
    code: `await roku.app.deploy({ rootDir: 'app' });
await roku.device.sleep({ durationMs: ${SETTLE} });
return (await roku.ui.find({ attr: 'text', value: 'Hello' })).length > 0;`,
  },
  {
    name: 'navigate five keys, then find a node',
    full: [
      ...['Home', 'Down', 'Down', 'Right', 'Select'].flatMap((key) => [
        ['roku_keypress', { ...T, key }],
        ['roku_sleep', { durationMs: SETTLE }],
      ]),
      ['roku_get_focused_node', { ...T }],
      ['roku_find_node', { ...T, nodeId: 'menu' }],
    ],
    code: `for (const key of ['Home', 'Down', 'Down', 'Right', 'Select']) {
  await roku.input.keypress({ key });
  await roku.device.sleep({ durationMs: ${SETTLE} });
}
return { focused: await roku.ui.focused(), menu: (await roku.ui.find({ nodeId: 'menu' })).length };`,
  },
  {
    name: 'capture the console, wait for a line',
    full: [
      ['roku_console_capture_start', { ...T, file: path.join(work, 'roku-run', 'logs', 'full.log'), settleMs: 0 }],
      ['roku_launch', { ...T, appId: 'dev' }],
      ['roku_console_wait', { pattern: 'HomeScreen ready', timeoutMs: 2000 }],
      ['roku_console_capture_stop', {}],
    ],
    emit: true,
    code: `await roku.console.captureStart({ file: 'logs/code.log', settleMs: 0 });
await roku.device.launch({ appId: 'dev' });
const line = await roku.console.wait({ pattern: 'HomeScreen ready', timeoutMs: 2000 });
await roku.console.captureStop();
return line.matched;`,
  },
];

const bytes = (v) => Buffer.byteLength(JSON.stringify(v));
const tokens = (b) => Math.round(b / 4);

async function connect(mode) {
  const client = new Client({ name: 'bench', version: '0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([buildServer(mode).connect(a), client.connect(b)]);
  return client;
}

async function runFlow(client, calls, emit) {
  let sent = 0;
  let received = 0;
  const started = Date.now();
  const timer = emit ? setInterval(() => world.consoleEmit('HomeScreen ready\n'), 50) : undefined;
  let errors = 0;
  for (const [name, args] of calls) {
    const request = { name, arguments: args };
    const result = await client.callTool(request, undefined, { timeout: 60_000 });
    sent += bytes(request);
    received += bytes(result);
    if (result.isError) errors++;
  }
  clearInterval(timer);
  return { calls: calls.length, requestBytes: sent, responseBytes: received, contextTokens: tokens(sent + received), wallMs: Date.now() - started, errors };
}

const results = { date: new Date().toISOString(), node: process.version, settleMs: SETTLE, modes: {}, flows: [] };
const clients = { full: await connect('full'), code: await connect('code') };
for (const mode of ['full', 'code']) {
  const { tools } = await clients[mode].listTools();
  results.modes[mode] = { tools: tools.length, toolsListBytes: bytes(tools), toolsListTokens: tokens(bytes(tools)) };
}
for (const flow of FLOWS) {
  const full = await runFlow(clients.full, flow.full, flow.emit);
  const code = await runFlow(clients.code, [['roku_run', { ...T, code: flow.code, timeoutMs: 60_000 }]], flow.emit);
  results.flows.push({ name: flow.name, full, code });
}
await clients.full.close();
await clients.code.close();
process.chdir(repo);
fs.rmSync(work, { recursive: true, force: true });

fs.mkdirSync(path.join(repo, 'bench'), { recursive: true });
fs.writeFileSync(path.join(repo, 'bench', 'results.json'), JSON.stringify(results, null, 2) + '\n');

const row = (cols) => '| ' + cols.join(' | ') + ' |';
console.log(row(['', 'tools', 'tools/list bytes', '~tokens']));
console.log(row(['---', '---:', '---:', '---:']));
for (const [m, r] of Object.entries(results.modes)) console.log(row([m, r.tools, r.toolsListBytes, r.toolsListTokens]));
console.log('');
console.log(row(['flow', 'mode', 'calls', 'request B', 'response B', '~tokens', 'ms', 'errors']));
console.log(row(['---', '---', '---:', '---:', '---:', '---:', '---:', '---:']));
for (const f of results.flows) {
  for (const m of ['full', 'code']) console.log(row([f.name, m, f[m].calls, f[m].requestBytes, f[m].responseBytes, f[m].contextTokens, f[m].wallMs, f[m].errors]));
}
const failed = results.flows.some((f) => f.full.errors || f.code.errors);
process.exit(failed ? 1 : 0);
