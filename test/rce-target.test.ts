import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { RceClient, RceError } from 'roku-rce';
import { pickTarget, pickPassword, resolveTarget, friendlyError } from '../src/roku-config.js';
import { setRceClientFactory, type RceClientLike } from '../src/rce.js';
import { registerDeployTools } from '../src/tools/deploy.js';
import { registerEcpTools } from '../src/tools/ecp.js';
import { registerScreenshotTools } from '../src/tools/screenshot.js';
import { registerConsoleTools } from '../src/tools/console.js';
import { registerConsoleCaptureTools } from '../src/tools/console-capture.js';
import { registerBsprofTools } from '../src/tools/bsprof.js';
import { registerPerfettoTools } from '../src/tools/perfetto.js';
import { registerEditUiTools } from '../src/tools/edit-ui.js';
import { registerStreamTools } from '../src/tools/stream.js';
import { registerRceTools } from '../src/tools/rce.js';

const RCE_VARS = ['ROKU_RCE_DEVICE', 'ROKU_RCE_PASSWORD', 'ROKU_RCE_TOKEN', 'ROKU_DEVICE_HOST', 'ROKU_DEVICE_PASSWORD'];

/** Runs fn with only the given ROKU_* vars set, restoring the environment afterwards. */
async function withEnv(vars: Record<string, string>, fn: () => Promise<void>): Promise<void> {
  const saved = Object.fromEntries(RCE_VARS.map((k) => [k, process.env[k]]));
  for (const k of RCE_VARS) delete process.env[k];
  Object.assign(process.env, vars);
  try {
    await fn();
  } finally {
    for (const k of RCE_VARS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

function stubClient(calls: string[]): RceClientLike {
  const device = { id: 400, name: 'Stub', device_type: 'stb', status: 'running', running_device: null };
  const instance = {
    ecp: async (path: string, method: string, o?: { timeoutMs?: number }) => {
      calls.push(`ecp ${method} ${path} ${o?.timeoutMs}`);
      return '<ok/>';
    },
    keypress: async (key: string) => {
      calls.push(`keypress ${key}`);
    },
    openBridge: async (port: number) => {
      calls.push(`bridge ${port}`);
      throw new RceError('nothing listens on device port', { status: 502, code: 'port_closed' });
    },
  };
  return {
    findDevice: async (ref: string | number) => {
      calls.push(`find ${ref}`);
      return device;
    },
    instance: () => instance,
  } as unknown as RceClientLike;
}

test('target precedence: host param > rceDevice > ROKU_RCE_DEVICE > host env > SSDP', () => {
  const env = { ROKU_RCE_DEVICE: 'envDev', ROKU_DEVICE_HOST: '10.0.0.2' };
  assert.deepEqual(pickTarget({ host: '10.0.0.1', rceDevice: '400' }, env), { kind: 'lan', host: '10.0.0.1' });
  assert.deepEqual(pickTarget({ rceDevice: '400' }, env), { kind: 'rce', ref: '400' });
  assert.deepEqual(pickTarget({}, env), { kind: 'rce', ref: 'envDev' });
  assert.deepEqual(pickTarget({}, { ROKU_IP: '10.0.0.3' }), { kind: 'lan', host: '10.0.0.3' });
  assert.deepEqual(pickTarget({}, {}), { kind: 'lan', host: undefined });
});

test('password precedence; LAN targets never read ROKU_RCE_PASSWORD', () => {
  const env = { ROKU_RCE_PASSWORD: 'rce', ROKU_DEVICE_PASSWORD: 'lan' };
  assert.equal(pickPassword('rce', 'param', env), 'param');
  assert.equal(pickPassword('rce', undefined, env), 'rce');
  assert.equal(pickPassword('rce', undefined, { ROKU_DEV_PASSWORD: 'alias' }), 'alias');
  assert.equal(pickPassword('lan', undefined, env), 'lan');
  assert.equal(pickPassword('lan', undefined, { ROKU_RCE_PASSWORD: 'rce' }), undefined);
});

test('an RCE target routes ECP, keys and ports through the Instance API', async () => {
  const calls: string[] = [];
  setRceClientFactory(() => stubClient(calls));
  await withEnv({ ROKU_RCE_DEVICE: 'Stub' }, async () => {
    const target = await resolveTarget({});
    assert.equal(target.kind, 'rce');
    assert.equal(target.label, 'Cloud Device 400 (Stub)');
    await target.ecp('query/device-info');
    await target.ecp('launch/dev', { method: 'POST' });
    await target.ecp('query/app-ui', { timeoutMs: 30_000 });
    await target.keypress('Lit_%');
    await assert.rejects(target.connect(9000), (e: unknown) => e instanceof RceError && e.code === 'port_closed');
  });
  assert.deepEqual(calls, ['find Stub', 'ecp GET query/device-info 10000', 'ecp POST launch/dev 10000', 'ecp GET query/app-ui 30000', 'keypress Lit_%25', 'bridge 9000']);
});

test('an RCE deploy without any password fails before calling RCE', async () => {
  const calls: string[] = [];
  setRceClientFactory(() => stubClient(calls));
  await withEnv({ ROKU_RCE_DEVICE: '400' }, async () => {
    await assert.rejects(resolveTarget({}, { needPassword: true }), /ROKU_RCE_PASSWORD/);
  });
  assert.deepEqual(calls, []);
});

test('friendlyError: RCE messages pass through; 404 and ECONNREFUSED are explained', () => {
  const forbidden = new RceError('the device refused ECP query/app-ui (403: ...). ... Permissive, then save a new Snapshot', { status: 403, code: 'ecp_forbidden' });
  assert.match(friendlyError(forbidden), /Permissive/);
  assert.match(friendlyError(new RceError('Cloud Device 400 is not running', { code: 'not_running' })), /roku_rce_start/);
  assert.equal(friendlyError(new Error('Request failed with status code 404'), { notFound: 'deploy first' }), 'deploy first');
  assert.match(friendlyError(new Error('connect ECONNREFUSED 10.0.0.9:8085')), /10\.0\.0\.9 \(BrightScript debug console, port 8085\)/);
  assert.match(friendlyError(new Error('Connection to 10.0.0.9:8085 timed out')), /^Connection timed out/);
});

async function connectAll(): Promise<Client> {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  for (const register of [
    registerDeployTools, registerEcpTools, registerScreenshotTools, registerConsoleTools, registerConsoleCaptureTools,
    registerBsprofTools, registerPerfettoTools, registerEditUiTools, registerStreamTools, registerRceTools,
  ]) register(server);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(b);
  return client;
}

const text = (r: any) => (r.content as Array<{ text: string }>).map((c) => c.text).join('\n');

test('unsupported-on-RCE tools answer one clear error without touching RCE', async () => {
  const calls: string[] = [];
  setRceClientFactory(() => stubClient(calls));
  const client = await connectAll();
  await withEnv({}, async () => {
    for (const name of ['roku_perfetto_enable', 'roku_perfetto_start']) {
      const r: any = await client.callTool({ name, arguments: { rceDevice: '400' } });
      assert.equal(r.isError, true);
      assert.match(text(r), new RegExp(`${name} is not supported on Roku Cloud Emulator devices`));
    }
    const r: any = await client.callTool({ name: 'roku_diagnose_stream', arguments: { captureLive: true, url: 'https://x/y.m3u8', rceDevice: '400' } });
    assert.equal(r.isError, true);
    assert.match(text(r), /captureLive is not supported on Roku Cloud Emulator devices/);
  });
  assert.deepEqual(calls, []);
  await client.close();
});

test('every tool has a title and explicit read-only/destructive hints', async () => {
  const client = await connectAll();
  const { tools } = await client.listTools();
  assert.equal(tools.length, 46);
  for (const t of tools) {
    assert.ok(t.title, `${t.name} has no title`);
    assert.equal(typeof t.annotations?.readOnlyHint, 'boolean', `${t.name} readOnlyHint`);
    assert.equal(typeof t.annotations?.destructiveHint, 'boolean', `${t.name} destructiveHint`);
  }
  const destructive = tools.filter((t) => t.annotations?.destructiveHint).map((t) => t.name).sort();
  assert.deepEqual(destructive, ['roku_delete_dev_channel', 'roku_deploy', 'roku_diagnose_stream', 'roku_rce_start', 'roku_rce_stop', 'roku_remove_node']);
  assert.equal(tools.find((t) => t.name === 'roku_screenshot')!.annotations!.readOnlyHint, false);
  for (const name of ['roku_rce_start', 'roku_rce_stop', 'roku_rce_status', 'roku_rce_list_devices']) {
    assert.match(tools.find((t) => t.name === name)!.description!, /\$0\.20 per hour/);
  }
  await client.close();
});

test('roku_rce_stop stops only the Run it read; maxRuntimeMinutes is capped at 240', async () => {
  const stops: unknown[] = [];
  const device = { id: 400, name: 'Stub', device_type: 'stb', status: 'running', running_device: { id: 77, created_at: new Date().toISOString(), max_runtime: 600, snapshot_id: 1 } };
  setRceClientFactory(
    () =>
      ({
        findDevice: async () => device,
        startedHere: () => false,
        stop: async (id: number, o: unknown) => (stops.push([id, o]), device),
        waitUntilShutdown: async () => ({ ...device, status: 'shutdown', running_device: null }),
      }) as unknown as RceClientLike
  );
  const client = await connectAll();
  await withEnv({}, async () => {
    const r: any = await client.callTool({ name: 'roku_rce_stop', arguments: { rceDevice: '400' } });
    assert.ok(!r.isError, text(r));
    assert.deepEqual(stops, [[400, { runId: 77 }]]);
    const big: any = await client
      .callTool({ name: 'roku_rce_start', arguments: { rceDevice: '400', maxRuntimeMinutes: 241 } })
      .catch((e: Error) => ({ isError: true, content: [{ text: e.message }] }));
    assert.equal(big.isError, true);
    assert.match(text(big), /maxRuntimeMinutes/);
  });
  await client.close();
});

test('an RCE console capture ends when the device side closes the bridge', async () => {
  // A minimal WebSocket endpoint (no ws types here): handshake, then a close frame (1000).
  const server = http.createServer();
  server.on('upgrade', (req, socket) => {
    socket.on('error', () => {});
    const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    setTimeout(() => socket.end(Buffer.from([0x88, 0x02, 0x03, 0xe8])), 300);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const real = new RceClient({ token: 'tok', apiUrl: `${base}/api/v1` });
  const device = { id: 400, name: 'Stub', device_type: 'stb', status: 'running', running_device: { id: 1, created_at: new Date().toISOString(), instance_api_url: `${base}/instance/x`, max_runtime: 600, snapshot_id: 1 } };
  setRceClientFactory(() => ({ findDevice: async () => device, instance: (d: never) => real.instance(d) }) as unknown as RceClientLike);
  const client = await connectAll();
  try {
    await withEnv({ ROKU_RCE_DEVICE: '400' }, async () => {
      const file = path.join(mkdtempSync(path.join(tmpdir(), 'rce-cap-')), 'out.log');
      const started: any = await client.callTool({ name: 'roku_console_capture_start', arguments: { file, settleMs: 50 } });
      assert.ok(!started.isError, text(started));
      const deadline = Date.now() + 3000;
      let status: any;
      do {
        await new Promise((r) => setTimeout(r, 100));
        status = JSON.parse(text(await client.callTool({ name: 'roku_console_capture_status', arguments: {} })));
      } while (status.active && Date.now() < deadline);
      assert.equal(status.active, false, 'capture still active after the remote close');
    });
  } finally {
    await client.close();
    server.close();
  }
});
