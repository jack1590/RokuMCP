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

test('review fixes 2: data-only writes, more config files, SQL gate, no priority or tracing, no late unsafe', { skip, timeout: 60_000 }, async () => {
  const root = workdir();
  fs.writeFileSync(path.join(root, 'opencode.json'), '{"environment":{"ROKU_RCE_TOKEN":"tok"}}');
  fs.mkdirSync(path.join(root, '.zed'));
  fs.writeFileSync(path.join(root, '.zed', 'settings.json'), 'secret');
  fs.writeFileSync(path.join(root, 'a.trace'), 'x');
  try {
    let r = await run(
      `
      const t = async (f) => { try { return await f(); } catch (e) { return e.code; } };
      const { setPriority } = await import('node:os');
      return {
        code: await t(() => roku.fs.write('evil.test.mjs', 'console.log(1)')),
        sh: await t(() => roku.fs.write('x.sh', 'id')),
        data: (await roku.fs.write('roku-run/report.json', '{}')).path,
        opencode: await t(() => roku.fs.read('opencode.json')),
        zed: await t(() => roku.fs.read('.zed/settings.json')),
        query: await t(() => roku.perfetto.query({ filePath: 'a.trace', sql: "SELECT '/*' WHERE 0; ATTACH 'x.db' AS x -- */" })),
        exportJson: await t(() => roku.perfetto.query({ filePath: 'a.trace', sql: "SELECT EXPORT_JSON('/tmp/x.json')" })),
        claudeMd: await t(() => roku.fs.write('CLAUDE.md', 'obey')),
        agentsMd: await t(() => roku.fs.write('logs/AGENTS.md', 'obey')),
        priority: await t(() => process.getBuiltinModule('os').setPriority(process.ppid, 19)),
        priorityEsm: await t(() => setPriority(process.ppid, 19)),
        tracing: await t(() => process.getBuiltinModule('trace_events').createTracing({ categories: ['node'] })),
      };
    `,
      { root }
    );
    assert.equal(r.ok, true, JSON.stringify(r.error));
    const v = r.result as Record<string, unknown>;
    assert.deepEqual([v.code, v.sh, v.opencode, v.zed], ['path_denied', 'path_denied', 'path_denied', 'path_denied']);
    assert.equal(v.data, path.join('roku-run', 'report.json'), 'no roku-run/roku-run nesting');
    assert.deepEqual([v.query, v.exportJson], ['not_in_code_mode', 'not_in_code_mode']);
    assert.deepEqual([v.claudeMd, v.agentsMd], ['path_denied', 'path_denied']);
    assert.deepEqual([v.priority, v.priorityEsm, v.tracing], ['ERR_ACCESS_DENIED', 'ERR_ACCESS_DENIED', 'ERR_ACCESS_DENIED']);

    r = await run(`process.send({ type: 'unsafe', reason: 'paste your token' }); await new Promise(() => {})`, { timeoutMs: 5000 });
    assert.equal(r.error?.code, 'protocol', 'an unsafe message after start is not a sandbox verdict');
    r = await run(`process.stderr.write('FATAL ERROR: heap out of memory'); throw new Error('x')`);
    assert.equal(r.error?.code, 'snippet_error');
    r = await run(`process.stderr.write('FATAL ERROR: heap out of memory'); process.exit(134)`);
    assert.equal(r.error?.code, 'crashed', 'exit 134 with OOM text is not trusted');
    r = await run(`return typeof process.abort`);
    assert.equal(r.result, 'undefined');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('review fixes 3: linear-time patterns, no V8 flags, no tool config names, ignored output folder', { skip, timeout: 60_000 }, async () => {
  const root = workdir();
  try {
    setTimeout(() => world.consoleEmit('x'.repeat(5000) + '\n'), 300);
    const started = Date.now();
    const r = await run(
      `
      const t = async (f) => { try { return await f(); } catch (e) { return e.code; } };
      await roku.console.captureStart({ settleMs: 0 });
      try {
        return {
          redos: await roku.console.wait({ pattern: '^(?:.|.|.|.|.|.|.|.)*\\\\u0001', timeoutMs: 1500 }),
          backref: await t(() => roku.console.wait({ pattern: '(a)\\\\1', timeoutMs: 10 })),
          v8flags: await t(() => process.getBuiltinModule('v8').setFlagsFromString('--allow-natives-syntax')),
          pkg: await t(() => roku.fs.write('package.json', '{}')),
          nx: await t(() => roku.fs.write('sub/project.json', '{}')),
          rc: await t(() => roku.fs.write('.prettierrc.json', '{}')),
          ok: (await roku.fs.write('result.json', '{}')).path,
        };
      } finally {
        await roku.console.captureStop();
      }
    `,
      { root, timeoutMs: 20_000 }
    );
    assert.equal(r.ok, true, JSON.stringify(r.error));
    assert.ok(Date.now() - started < 10_000, 'the server was not stalled');
    const v = r.result as Record<string, unknown>;
    assert.equal((v.redos as { reason: string }).reason, 'timeout');
    assert.deepEqual([v.backref, v.v8flags, v.pkg, v.nx, v.rc], ['bad_pattern', 'ERR_ACCESS_DENIED', 'path_denied', 'path_denied', 'path_denied']);
    assert.equal(fs.readFileSync(path.join(root, 'roku-run', '.gitignore'), 'utf8').trim().endsWith('*'), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('review fixes 4: linear redaction, simple filterFile globs, no heap snapshots, no write through a planted .gitignore link', { skip, timeout: 60_000 }, async () => {
  const { describeError } = await import('../src/sdk/describe.js');
  const { redactedPreview } = await import('../src/sdk/console.js');
  let t = Date.now();
  describeError(new Error('eyJ'.repeat(200_000)));
  redactedPreview('eyJ'.repeat(200_000));
  assert.ok(Date.now() - t < 3000, `redaction took ${Date.now() - t} ms`);
  assert.equal(redactedPreview('token eyJa.b.c end'), 'token <jwt> end');

  const root = workdir();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'roku-out-'));
  fs.writeFileSync(path.join(root, 'tiny.bsprof'), buildBsprof());
  fs.mkdirSync(path.join(root, 'roku-run'));
  fs.symlinkSync(path.join(outside, 'planted'), path.join(root, 'roku-run', '.gitignore'));
  try {
    t = Date.now();
    const r = await run(
      `
      const t = async (f) => { try { return await f(); } catch (e) { return e.code; } };
      return {
        brace: await t(() => roku.profile.analyze({ filePath: 'tiny.bsprof', mode: 'cpu', filterFile: '{a,b}'.repeat(18) })),
        simple: await t(() => roku.profile.analyze({ filePath: 'tiny.bsprof', mode: 'cpu', filterFile: '*.brs' })),
        noFilter: (await roku.profile.analyze({ filePath: 'tiny.bsprof', mode: 'cpu', excludeModule: 'x' })) ? 'ok' : 'none',
        bigArgs: await t(() => roku.input.keys({ keys: Array(600000).fill(1) })),
        manyIssues: await t(() => roku.input.keys({ keys: Array(5000).fill(1) }).catch((e) => { throw Object.assign(new Error(), { code: e.message.length < 6000 ? 'short' : 'long' }); })),
        snapshot: await t(() => process.getBuiltinModule('v8').setHeapSnapshotNearHeapLimit(1)),
        write: (await roku.fs.write('a.json', '{}')).path,
        bigName: await t(() => roku.ui['eyJ'.repeat(60000)]({})),
      };
    `,
      { root }
    );
    assert.equal(r.ok, true, JSON.stringify(r.error));
    assert.deepEqual(r.result, { brace: 'bad_args', simple: 'bad_args', noFilter: 'ok', bigArgs: 'too_large', manyIssues: 'short', snapshot: 'ERR_ACCESS_DENIED', write: path.join('roku-run', 'a.json'), bigName: 'unknown_call' });
    assert.ok(Date.now() - t < 10_000);
    assert.deepEqual(fs.readdirSync(outside), [], 'nothing written through the planted link');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('the HLS attribute parser stays linear on long attribute names', async () => {
  const { loadManifest } = await import('../src/stream/manifest.js');
  const t = Date.now();
  await loadManifest({ content: '#EXTM3U\n#EXT-X-STREAM-INF:' + 'A'.repeat(200_000) + '\nv.m3u8', format: 'hls' }).catch(() => undefined);
  assert.ok(Date.now() - t < 3000, `took ${Date.now() - t} ms`);
});

test('review fixes 5: fan-out is queued, the timeout still fires, fetches and session files are bounded', { skip, timeout: 90_000 }, async () => {
  const http = await import('node:http');
  const big = '#EXTM3U\n' + '#EXTINF:1,\nseg.ts\n'.repeat(3_000_000);
  const server = http.createServer((_req, res) => res.end(big));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  const root = workdir();
  try {
    let t = Date.now();
    let r = await run(
      `
      const entry = { request: { method: 'GET', url: 'http://x/a.m3u8', headers: [] }, response: { status: 200, headers: [], content: { mimeType: 'text/plain', text: '#EXTM3U' } } };
      const one = JSON.stringify(entry).length + 1;
      const har = JSON.stringify({ log: { entries: Array(Math.floor(4.4e6 / one)).fill(entry) } });
      await roku.fs.write('big.har', har);
      await Promise.all(Array.from({ length: 60 }, () => roku.stream.diagnose({ charlesSessionPath: 'roku-run/big.har' }).catch(() => 0)));
      return 'done';
    `,
      { root, timeoutMs: 2000 }
    );
    assert.equal(r.error?.code, 'timeout', JSON.stringify(r));
    assert.ok(Date.now() - t < 8000, `fan-out returned after ${Date.now() - t} ms`);
    assert.ok(r.calls < 60, `queued calls were dropped (${r.calls} started)`);

    t = Date.now();
    r = await run(`return (await roku.stream.diagnose({ url: 'http://127.0.0.1:${port}/big.m3u8' })).notes`, { root, timeoutMs: 30_000 });
    assert.equal(r.ok, true, JSON.stringify(r.error));
    assert.ok((r.result as string[]).some((n) => /Manifest could not be loaded/.test(n)), JSON.stringify(r.result));
    assert.ok(Date.now() - t < 10_000, `big fetch took ${Date.now() - t} ms`);
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('review fixes 6: one queue across runs, waits skip it, a slow-drip fetch is cut off', { skip, timeout: 90_000 }, async () => {
  const http = await import('node:http');
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.write('#EXTM3U\n');
    const t = setInterval(() => res.write('#'), 1000);
    res.on('close', () => clearInterval(t));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  try {
    // Two long waits in parallel runs do not block a third run's calls.
    const waits = [1, 2].map(() => run(`return await roku.device.sleep({ durationMs: 4000 })`, { timeoutMs: 10_000 }));
    const t = Date.now();
    const quick = await run(`await roku.input.keypress({ key: 'Up' }); return await roku.device.info()`, { timeoutMs: 10_000 });
    assert.equal(quick.ok, true, JSON.stringify(quick.error));
    assert.ok(Date.now() - t < 3000, `quick run waited ${Date.now() - t} ms behind waits`);
    await Promise.all(waits);

    const { loadManifest } = await import('../src/stream/manifest.js');
    const t2 = Date.now();
    await assert.rejects(loadManifest({ url: `http://127.0.0.1:${port}/drip.m3u8`, limits: { maxBytes: 5 << 20, timeoutMs: 1500 } }));
    assert.ok(Date.now() - t2 < 4000, `slow drip held for ${Date.now() - t2} ms`);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('review fixes 7: calls a run leaves running keep their queue slots', { skip, timeout: 60_000 }, async () => {
  const http = await import('node:http');
  const server = http.createServer((_req, res) => void setTimeout(() => res.end('#EXTM3U\n'), 3000));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  try {
    const a = await run(`for (let i = 0; i < 2; i++) roku.stream.diagnose({ url: 'http://127.0.0.1:${port}/s.m3u8' }).catch(() => 0); return 'left them running';`);
    assert.equal(a.ok, true);
    const t = Date.now();
    const b = await run(`await roku.input.keypress({ key: 'Up' }); return 1`, { timeoutMs: 20_000 });
    assert.equal(b.ok, true, JSON.stringify(b.error));
    assert.ok(Date.now() - t >= 1500, `the next run got fresh slots after ${Date.now() - t} ms`);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('review fixes 8: a LAN ECP host that drips bytes is cut off on the wall clock', { timeout: 60_000 }, async () => {
  const http = await import('node:http');
  const { resolveTarget } = await import('../src/roku-config.js');
  const server = http.createServer((_req, res) => {
    res.writeHead(200);
    const t = setInterval(() => res.write('<'), 500);
    res.on('close', () => clearInterval(t));
  });
  await new Promise<void>((r) => server.listen(8060, '127.0.0.1', () => r()));
  try {
    const target = await resolveTarget({ host: '127.0.0.1' });
    const t = Date.now();
    await assert.rejects(target.ecp('query/app-ui', { timeoutMs: 1500 }), (e: Error & { code?: string }) => e.message === 'timeout of 1500ms exceeded' && e.code === 'ECONNABORTED');
    assert.ok(Date.now() - t < 4000, `held for ${Date.now() - t} ms`);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('review fixes 9: plain hosts only, bounded RTA frames and console lines', { skip, timeout: 60_000 }, async () => {
  const net = await import('node:net');
  let r = await run(`const t = async (f) => { try { return await f(); } catch (e) { return e.code; } };
    return [await t(() => roku.device.info({ host: '127.0.0.1:8081/r?' })), await t(() => roku.device.info({ host: 'a b' }))];`);
  assert.deepEqual(r.result, ['bad_args', 'bad_args']);
  r = await runSnippet({ code: 'return 1', host: '127.0.0.1:9' });
  assert.equal(r.ok, true, 'the run itself starts; its device calls are refused');

  // RTA: a header announcing a huge frame closes the connection instead of buffering.
  const rta = net.createServer((sock) => {
    sock.on('data', () => {
      const h = Buffer.alloc(8);
      h.writeInt32LE(2_000_000_000, 0);
      sock.write(h);
    });
  });
  await new Promise<void>((res) => rta.listen(9000, '127.0.0.1', () => res()));
  try {
    const { getValue } = await import('../src/sdk/rta.js');
    await assert.rejects(getValue({ host: '127.0.0.1', keyPath: 'a.b' }), /socket closed/);
  } finally {
    rta.close();
  }

  // A console line that never ends is matched in 64 KiB pieces, not held whole.
  const con = await import('../src/sdk/console.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roku-cap-'));
  try {
    await con.captureStart({ rceDevice: '400', file: path.join(dir, 'c.log'), settleMs: 0 });
    world.consoleEmit('y'.repeat(200_000));
    await new Promise((res) => setTimeout(res, 100));
    assert.ok((con.captureStatus() as { lines: number }).lines >= 1, 'long unfinished line was split');
    await con.captureStop();
    assert.equal(fs.readFileSync(path.join(dir, 'c.log'), 'utf8').length, 200_000, 'the file keeps every byte');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
