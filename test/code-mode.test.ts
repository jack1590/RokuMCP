import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { setRceClientFactory } from '../src/rce.js';
import { buildServer } from '../src/index.js';
import { runSnippet, sandboxSupported } from '../src/sandbox/run.js';
import { FakeWorld, stubRce } from './helpers/fakes.js';
import { buildBsprof } from './helpers/bsprof-fixture.js';

const world = new FakeWorld();
setRceClientFactory(() => stubRce(world));
const skip = !sandboxSupported() && 'needs Node 22.13+';

function workdir(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'roku-run-')));
  fs.writeFileSync(path.join(dir, '.env'), 'ROKU_RCE_TOKEN=sk-live-token-value\n');
  fs.mkdirSync(path.join(dir, '.git'));
  fs.writeFileSync(path.join(dir, '.git', 'config'), '[remote] url = https://user:pat@github.com/x');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'hello');
  return dir;
}

const run = (code: string, extra: Record<string, unknown> = {}) => {
  world.calls = [];
  return runSnippet({ code, rceDevice: '400', ...extra });
};

test('code mode lists only roku_run, roku_sdk_docs and roku_screenshot', async () => {
  const client = new Client({ name: 't', version: '0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([buildServer('code').connect(a), client.connect(b)]);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ['roku_run', 'roku_screenshot', 'roku_sdk_docs']);
  const docs = JSON.parse(((await client.callTool({ name: 'roku_sdk_docs', arguments: {} })) as { content: Array<{ text: string }> }).content[0].text);
  assert.ok(docs.calls.some((c: { call: string }) => c.call === 'roku.input.keypress'));
  const one = JSON.parse(((await client.callTool({ name: 'roku_sdk_docs', arguments: { query: 'keypress' } })) as { content: Array<{ text: string }> }).content[0].text);
  assert.equal(one.calls[0].options.properties.key.type, 'string');
  await client.close();
});

test('a snippet drives the SDK in one call', { skip }, async () => {
  const r = await run(`
    await roku.input.keypress({ key: 'Home' });
    await roku.input.keys({ keys: ['Down', 'Select'], delayMs: 0 });
    console.log('pressed', 3);
    const node = await roku.ui.find({ attr: 'text', value: 'Play' });
    let missing;
    try { await roku.ui.sgNodes({ type: 'node' }); } catch (e) { missing = e.code; }
    return { node, missing, info: await roku.device.info() };
  `);
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.deepEqual((r.result as { node: unknown }).node, [{ name: 'play', uiElementId: 'RTA_4', text: 'Play', focused: 'true' }]);
  assert.equal((r.result as { missing: string }).missing, 'bad_args');
  assert.deepEqual(r.logs, ['pressed 3']);
  assert.ok(world.calls.includes('rce keypress Home') && world.calls.includes('rce keypress Select'));
});

test('call errors: unknown calls, bad options, uncaught errors carry code and message only', { skip }, async () => {
  let r = await run(`return await roku.ui.nope()`);
  assert.deepEqual([r.ok, r.error?.code], [false, 'unknown_call']);
  r = await run(`return await roku.input.keypress('Home')`);
  assert.deepEqual([r.ok, r.error?.code], [false, 'bad_args']);
  r = await run(`return await roku.input.keypress({})`);
  assert.equal(r.error?.code, 'bad_args');
  r = await run(`throw new Error('mine')`);
  assert.deepEqual(r.error, { code: 'snippet_error', message: 'mine' });
  r = await run(`try { await roku.rce.status({ rceDevice: 'nope' }) } catch (e) { return { code: e.code, stack: e.stack } }`);
  assert.equal((r.result as { code: string }).code, 'not_found');
  assert.ok(!/src[\\/](sdk|sandbox|tools)/.test((r.result as { stack: string }).stack), 'no server stack frames');
});

test('the sandbox has no environment, file system, processes or SDK', { skip }, async () => {
  process.env.ROKU_RCE_TOKEN = 'sk-parent-secret';
  try {
    const r = await run(`
      const t = (f) => { try { return f(); } catch (e) { return 'DENIED ' + e.code; } };
      const fs = process.getBuiltinModule('fs');
      return {
        env: Object.keys(process.env).filter((k) => !k.startsWith('__CF')),
        escape: t(() => this?.constructor?.constructor('return process.env')()),
        fnEscape: t(() => (async () => {}).constructor.constructor('return Object.keys(process.env)')()),
        readEnv: t(() => fs.readFileSync('${path.resolve('.env')}', 'utf8')),
        readEtc: t(() => fs.readFileSync('/etc/hosts', 'utf8')),
        write: t(() => fs.writeFileSync('/tmp/roku-run-escape.txt', 'x')),
        spawn: t(() => process.getBuiltinModule('child_process').execSync('id').toString()),
        worker: t(() => new (process.getBuiltinModule('worker_threads').Worker)('1', { eval: true })),
        binding: t(() => typeof process.binding('fs')),
        inspector: t(() => process.getBuiltinModule('inspector').open(0)),
        imports: t(() => typeof require),
      };
    `);
    assert.equal(r.ok, true, JSON.stringify(r.error));
    const v = r.result as Record<string, unknown>;
    assert.deepEqual(v.env, []);
    assert.ok(!JSON.stringify(v).includes('sk-parent-secret'));
    for (const k of ['readEnv', 'readEtc', 'write', 'spawn', 'worker', 'binding', 'inspector']) assert.equal(v[k], 'DENIED ERR_ACCESS_DENIED', k);
    assert.equal(v.imports, 'undefined');
    assert.equal(fs.existsSync('/tmp/roku-run-escape.txt'), false);
  } finally {
    delete process.env.ROKU_RCE_TOKEN;
  }
});

test('timeout, memory, log and result limits fire', { skip, timeout: 60_000 }, async () => {
  let r = await run('while (true) {}', { timeoutMs: 500 });
  assert.equal(r.error?.code, 'timeout');
  r = await run('const a = []; while (true) a.push(new Array(1e6).fill(1));', { timeoutMs: 30_000 });
  assert.equal(r.error?.code, 'memory_limit');
  r = await run(`for (let i = 0; i < 5000; i++) console.log('x'.repeat(100)); return 1`);
  assert.equal(r.ok, true);
  assert.equal(r.logsTruncated, true);
  assert.ok(r.logs.join('').length <= 64 * 1024);
  r = await run(`return 'x'.repeat(200 * 1024)`);
  assert.equal(r.error?.code, 'output_too_large');
  r = await run(`const o = {}; o.o = o; return o`);
  assert.equal(r.error?.code, 'unserializable_result');
  r = await run(`process.send({ type: 'weird' }); await new Promise(() => {})`, { timeoutMs: 5000 });
  assert.equal(r.error?.code, 'protocol');
});

test('roku.fs stays inside the working directory and away from secrets', { skip }, async () => {
  const root = workdir();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'roku-out-'));
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside');
  fs.symlinkSync(outside, path.join(root, 'link'));
  fs.symlinkSync(path.join(root, '.env'), path.join(root, 'env-link.txt'));
  try {
    const r = await run(
      `
      const t = async (f) => { try { return await f(); } catch (e) { return e.code; } };
      return {
        read: await roku.fs.read('notes.txt'),
        write: await roku.fs.write('out/result.json', '{"a":1}'),
        list: (await roku.fs.list('.')).map((e) => e.name).sort(),
        env: await t(() => roku.fs.read('.env')),
        envLocal: await t(() => roku.fs.read('sub/.env.local')),
        git: await t(() => roku.fs.read('.git/config')),
        dotdot: await t(() => roku.fs.read('../../etc/hosts')),
        abs: await t(() => roku.fs.read('/etc/hosts')),
        symlinkDir: await t(() => roku.fs.read('link/secret.txt')),
        symlinkFile: await t(() => roku.fs.read('env-link.txt')),
        writeEnv: await t(() => roku.fs.write('.env', 'x')),
        writeOut: await t(() => roku.fs.write('../link/pwn.txt', 'x')),
        writeSrc: await t(() => roku.fs.write('../package.json', '{}')),
        key: await t(() => roku.fs.write('server.key', 'x')),
      };
    `,
      { root }
    );
    assert.equal(r.ok, true, JSON.stringify(r.error));
    const v = r.result as Record<string, unknown>;
    assert.equal(v.read, 'hello');
    assert.deepEqual(v.write, { path: path.join('roku-run', 'out', 'result.json'), bytes: 7 });
    assert.deepEqual(r.files, [path.join('roku-run', 'out', 'result.json')]);
    assert.ok(!(v.list as string[]).includes('.env') && !(v.list as string[]).includes('.git'));
    for (const k of ['env', 'envLocal', 'git', 'dotdot', 'abs', 'symlinkDir', 'symlinkFile', 'writeEnv', 'writeOut', 'writeSrc', 'key']) assert.equal(v[k], 'path_denied', k);
    assert.equal(fs.existsSync(path.join(outside, 'pwn.txt')), false);
    assert.equal(fs.readFileSync(path.join(root, '.env'), 'utf8').includes('sk-live'), true, '.env untouched');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('SDK path options obey the same policy', { skip }, async () => {
  const root = workdir();
  fs.writeFileSync(path.join(root, 'tiny.bsprof'), buildBsprof());
  fs.mkdirSync(path.join(root, 'app', 'source'), { recursive: true });
  fs.writeFileSync(path.join(root, 'app', 'manifest'), 'title=x\n');
  try {
    const r = await run(
      `
      const t = async (f) => { try { return await f(); } catch (e) { return e.code; } };
      return {
        profile: (await roku.profile.info({ filePath: 'tiny.bsprof' })).targetName,
        etc: await t(() => roku.profile.info({ filePath: '/etc/hosts' })),
        charles: await t(() => roku.stream.diagnose({ charlesSessionPath: '.env' })),
        staging: await t(() => roku.app.deploy({ rootDir: 'app', stagingDir: 'app/../stage' })),
        dotGlob: await t(() => roku.app.deploy({ rootDir: 'app', files: ['**/*', '.env'] })),
        upGlob: await t(() => roku.app.deploy({ rootDir: 'app', files: ['../**/*'] })),
        rootWithEnv: await t(() => roku.app.deploy({ rootDir: '.' })),
        shotOut: await t(() => roku.ui.screenshot({ outDir: '/tmp' })),
        capture: await t(() => roku.console.captureStart({ file: '../x.log' })),
        deploy: await roku.app.deploy({ rootDir: 'app' }),
      };
    `,
      { root }
    );
    assert.equal(r.ok, true, JSON.stringify(r.error));
    const v = r.result as Record<string, unknown>;
    assert.equal(v.profile, 'TestApp (dev)');
    for (const k of ['etc', 'charles', 'staging', 'dotGlob', 'upGlob', 'rootWithEnv', 'shotOut', 'capture']) assert.equal(v[k], 'path_denied', k);
    assert.equal((v.deploy as { label: string }).label, 'Cloud Device 400 (Parity_1)');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('review fixes: no signals, no sqlite, no spoofed results, no calls after done', { skip, timeout: 60_000 }, async () => {
  let r = await run(`
    let sqlite = 'none';
    try { sqlite = typeof (await import('node:sqlite')).DatabaseSync; } catch (e) { sqlite = e.code; }
    return { kill: typeof process.kill, _kill: typeof process._kill, debug: typeof process._debugProcess, sqlite, builtin: typeof process.getBuiltinModule('node:sqlite') };
  `);
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.deepEqual(r.result, { kill: 'undefined', _kill: 'undefined', debug: 'undefined', sqlite: 'ERR_UNKNOWN_BUILTIN_MODULE', builtin: 'undefined' });

  r = await run(`process.send({ type: 'done', logs: Array(50000).fill('x'.repeat(1000)), error: { code: 'timeout', message: 'y'.repeat(1e6) } }); await new Promise(() => {})`, { timeoutMs: 5000 });
  assert.equal(r.error?.code, 'snippet_error', 'a snippet cannot claim a sandbox code');
  assert.ok(r.error!.message.length <= 2000);
  assert.ok(r.logs.join('').length <= 64 * 1024 && r.logsTruncated);

  r = await run(`process.send({ type: 'done', value: 1 }); for (let i = 0; i < 5; i++) await roku.input.keypress({ key: 'Up' }).catch(() => {}); process.send({ type: 'ready' });`, { timeoutMs: 3000 });
  assert.equal(r.ok, true);
  await new Promise((res) => setTimeout(res, 200));
  assert.ok(!world.calls.includes('rce keypress Up'), 'no call runs after done');
});

test('review fixes: dangling links, outFile, more secret files, deploy globs', { skip }, async () => {
  const root = workdir();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'roku-out-'));
  fs.mkdirSync(path.join(root, 'roku-run'));
  fs.symlinkSync(path.join(outside, 'new.txt'), path.join(root, 'roku-run', 'dangling'));
  for (const f of ['.mcp.json', 'mcp.json', 'bsconfig.json', 'rokudeploy.json', '.git-credentials', 'prod.env', '.envrc']) fs.writeFileSync(path.join(root, f), 'secret');
  fs.mkdirSync(path.join(root, '.windsurf'));
  fs.writeFileSync(path.join(root, '.windsurf', 'mcp.json'), 'secret');
  fs.mkdirSync(path.join(root, 'app', 'source'), { recursive: true });
  fs.writeFileSync(path.join(root, 'app', 'manifest'), 'title=x\n');
  fs.writeFileSync(path.join(root, 'app', 'source', '.env'), 'secret');
  try {
    const r = await run(
      `
      const t = async (f) => { try { return await f(); } catch (e) { return e.code; } };
      const out = {};
      out.dangling = await t(() => roku.fs.write('dangling', 'PWNED'));
      out.outFile = await t(() => roku.ui.screenshot({ outDir: 'shots', outFile: '../../escaped' }));
      out.perfettoOut = await t(() => roku.perfetto.start({ host: '127.0.0.1', outFile: '../x' }));
      for (const f of ['.mcp.json', 'mcp.json', 'bsconfig.json', 'rokudeploy.json', '.git-credentials', 'prod.env', '.envrc', '.windsurf/mcp.json']) out[f] = await t(() => roku.fs.read(f));
      out.glob = await t(() => roku.app.deploy({ rootDir: 'app', files: ['source/[.]env'] }));
      out.nestedSecret = await t(() => roku.app.deploy({ rootDir: 'app' }));
      out.shot = (await roku.ui.screenshot({ outDir: 'shots', outFile: 'ok' })).filePath;
      return out;
    `,
      { root }
    );
    assert.equal(r.ok, true, JSON.stringify(r.error));
    const v = r.result as Record<string, unknown>;
    for (const [k, code] of Object.entries(v)) if (k !== 'shot') assert.equal(code, 'path_denied', k);
    assert.equal(v.shot, path.join(root, 'roku-run', 'shots', 'ok.png'));
    assert.equal(fs.existsSync(path.join(outside, 'new.txt')), false, 'dangling link target not created');
    assert.deepEqual(fs.readdirSync(outside), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
