import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setRceClientFactory } from '../src/rce.js';
import { runCli, MAX_STDOUT_BYTES } from '../src/cli.js';
import { FakeWorld, stubRce } from './helpers/fakes.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const world = new FakeWorld();
setRceClientFactory(() => stubRce(world));
const RCE = ['--rce-device', '400'];

async function cli(...argv: string[]) {
  world.calls = [];
  const r = await runCli(argv);
  assert.equal(r.stdout.includes('\n'), false, 'stdout is one JSON line');
  return { code: r.exitCode, json: JSON.parse(r.stdout), stdout: r.stdout };
}

test('help lists one-shot commands only', async () => {
  const { code, json } = await cli('help');
  assert.equal(code, 0);
  const names = json.data.commands.map((c: { name: string }) => c.name);
  assert.ok(names.includes('input.keypress') && names.includes('console.capture'));
  assert.ok(!names.includes('console.connect') && !names.includes('perfetto.start'));
});

test('usage errors exit 2 with code "usage"', async () => {
  for (const argv of [
    [],
    ['nope.cmd'],
    ['console.connect', ...RCE],
    ['input.keypress', ...RCE, '--bogus', '1'],
    ['input.keys', 'Up', ...RCE, '--delay-ms', 'abc'],
    ['input.keypress', 'Home', 'extra', ...RCE],
    ['app.deploy', '/x', '--password', 'secret'],
    ['app.deploy', '--json', '{"rootDir":"/x","password":"secret"}'],
    ['input.keypress', '--json', '[1]'],
    ['device.sleep', '1', '--timeout', '-5'],
  ]) {
    const { code, json } = await cli(...argv);
    if (argv.length === 0) {
      assert.equal(code, 0, 'no arguments prints help');
      continue;
    }
    assert.equal(code, 2, argv.join(' '));
    assert.equal(json.ok, false);
    assert.equal(json.error.code, 'usage', argv.join(' '));
    assert.ok(!JSON.stringify(json).includes('secret'), 'the password is not echoed');
  }
});

test('positionals, flags and coercion reach the SDK', async () => {
  let r = await cli('input.keypress', 'Home', ...RCE);
  assert.deepEqual([r.code, r.json, world.calls], [0, { ok: true, data: null }, ['rce keypress Home']]);

  r = await cli('input.keys', 'Up', 'Down', '--delay-ms=0', ...RCE);
  assert.deepEqual(world.calls, ['rce keypress Up', 'rce keypress Down']);

  r = await cli('rta.visible', 'RTA_2', 'false', ...RCE);
  assert.equal(r.code, 0);
  assert.ok(world.calls.some((c) => c.includes('"field":"visible","value":false')), world.calls.join('\n'));

  r = await cli('device.launch', 'dev', '--json', '{"params":{"contentId":"7"}}', ...RCE);
  assert.ok(world.calls.includes('ecp POST launch/dev?contentId=7'));

  r = await cli('ui.find', '--attr', 'text', '--value', 'Play', ...RCE);
  assert.deepEqual(r.json.data, [{ name: 'play', uiElementId: 'RTA_4', text: 'Play', focused: 'true' }]);

  r = await cli('rce.status', '401');
  assert.equal(r.json.data.id, 401);
});

test('device errors exit 1 with a stable code; timeouts exit 3', async () => {
  world.ecpStatus['query/app-ui'] = 404;
  let r = await cli('ui.app-ui', ...RCE);
  world.ecpStatus = {};
  assert.equal(r.code, 1);
  assert.equal(r.json.error.code, 'no_dev_channel');

  r = await cli('rce.status', 'nope');
  assert.deepEqual([r.code, r.json.error.code], [1, 'not_found']);

  r = await cli('device.sleep', '5000', '--timeout', '50');
  assert.deepEqual([r.code, r.json.error.code], [3, 'timeout']);

  world.rtaSilent.add('onFieldChangeOnce');
  r = await cli('rta.observe', '--key-path', 'a.b', '--timeout-ms', '10', ...RCE);
  world.rtaSilent.clear();
  assert.deepEqual([r.code, r.json.error.code], [3, 'timeout']);
});

test('large and binary output only through --out', async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'rokuctl-'));
  try {
    world.ecpBody['query/app-ui'] = `<app-ui>${'x'.repeat(MAX_STDOUT_BYTES)}</app-ui>`;
    let r = await cli('ui.app-ui', ...RCE);
    assert.deepEqual([r.code, r.json.error.code], [2, 'output_too_large']);
    const xml = path.join(work, 'ui.xml');
    r = await cli('ui.app-ui', ...RCE, '--out', xml);
    assert.equal(r.code, 0);
    assert.equal(fs.readFileSync(xml, 'utf8'), world.ecpBody['query/app-ui']);
    assert.equal(r.json.data.file, xml);
    world.ecpBody = {};

    r = await cli('ui.screenshot', ...RCE, '--out-dir', work, '--out-file', 'shot');
    assert.equal(r.code, 0);
    assert.deepEqual(r.json.data.data, { binary: true, bytes: 8 }, 'no base64 on stdout');
    const png = path.join(work, 'copy.png');
    r = await cli('ui.screenshot', ...RCE, '--out-dir', work, '--out', png);
    assert.equal(fs.readFileSync(png).toString('hex'), '89504e470d0a1a0a');
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test('the rokuctl process prints one JSON line and sets the exit code', async () => {
  const bin = path.resolve(here, '..', 'src', 'cli.js');
  const run = (...args: string[]) =>
    new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      execFile(process.execPath, [bin, ...args], { cwd: os.tmpdir(), env: { PATH: process.env.PATH ?? '' } }, (error, stdout, stderr) =>
        resolve({ code: error ? Number((error as { code?: number }).code) : 0, stdout, stderr })
      );
    });
  let r = await run('device.sleep', '1');
  assert.deepEqual([r.code, JSON.parse(r.stdout)], [0, { ok: true, data: 1 }]);
  assert.equal(r.stdout.trim().split('\n').length, 1);
  r = await run('nope.cmd');
  assert.equal(r.code, 2);
  assert.equal(JSON.parse(r.stdout).error.code, 'usage');
  r = await run('rce.list');
  assert.equal(r.code, 1);
  assert.equal(JSON.parse(r.stdout).error.code, 'no_token');
});

test('review fixes: typed unions, strict --json, --, no echo, --out folder', async () => {
  let r = await cli('rta.observe', '--key-path', 'a.b', '--match', 'true', '--timeout-ms', '10', ...RCE);
  assert.ok(world.calls.some((c) => c.includes('"match":true')), 'boolean, not "true"');
  r = await cli('rta.observe', '--key-path', 'a.b', '--match', '5', '--timeout-ms', '10', ...RCE);
  assert.ok(world.calls.some((c) => c.includes('"match":5')));
  r = await cli('ui.find', '--attr', 'text', '--value', '5', ...RCE);
  assert.equal(r.code, 0, 'a string-only field keeps "5" as text');

  r = await cli('input.keypress', '--json', '{"key":"Home","rceDevise":"400"}');
  assert.deepEqual([r.code, r.json.error.code], [2, 'usage']);
  assert.match(r.json.error.message, /rceDevise/);

  r = await cli('input.keys', ...RCE, '--delay-ms', '0', '--', '--weird', 'Up');
  assert.deepEqual(world.calls, ['rce keypress --weird', 'rce keypress Up']);

  r = await cli('app.deploy', '/x', 'hunter2pw', ...RCE);
  assert.equal(r.code, 2);
  assert.ok(!r.stdout.includes('hunter2pw'));

  r = await cli('device.info', ...RCE, '--out', '/no/such/folder/x.json');
  assert.deepEqual([r.code, r.json.error.code], [2, 'usage']);
});

test('review fixes: error codes and console.capture misses', async () => {
  let r = await cli('profile.info', '/nonexistent/timeout-run.bsprof');
  assert.deepEqual([r.code, r.json.error.code], [1, 'enoent']);
  assert.match(r.json.error.message, /no such file/);

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'rokuctl-cap-'));
  try {
    r = await cli('console.capture', 'never', ...RCE, '--file', path.join(work, 'c.log'), '--settle-ms', '10', '--timeout-ms', '50');
    assert.deepEqual([r.code, r.json.error.code], [3, 'timeout']);
    assert.match(r.json.error.message, /c\.log/);
    setTimeout(() => world.consoleEmit('boot done\n'), 100);
    r = await cli('console.capture', 'boot', ...RCE, '--file', path.join(work, 'c.log'), '--settle-ms', '50', '--timeout-ms', '2000');
    assert.equal(r.code, 0);
    assert.equal(r.json.data.match.preview, 'boot done');
    assert.equal(r.json.data.capture.active, false);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }

  process.env.ROKU_RCE_PASSWORD = 'sup3r-secret';
  try {
    const { describeError } = await import('../src/sdk/describe.js');
    const info = describeError(new Error('login failed for sup3r-secret with Bearer abc.def'));
    assert.equal(info.message, 'login failed for <redacted> with Bearer <redacted>');
  } finally {
    delete process.env.ROKU_RCE_PASSWORD;
  }
});

test('signals print the JSON line and exit 129/130/143', async () => {
  const bin = path.resolve(here, '..', 'src', 'cli.js');
  for (const [signal, code] of [['SIGHUP', 129], ['SIGINT', 130], ['SIGTERM', 143]] as const) {
    const child = spawnCli(bin, ['device.sleep', '5000']);
    await new Promise((r) => setTimeout(r, 400));
    child.proc.kill(signal);
    const { exitCode, stdout } = await child.done;
    assert.equal(exitCode, code, signal);
    const json = JSON.parse(stdout);
    assert.deepEqual([json.ok, json.error.code], [false, 'interrupted']);
  }
});

function spawnCli(bin: string, args: string[]) {
  const proc = spawn(process.execPath, [bin, ...args], { cwd: os.tmpdir(), env: { PATH: process.env.PATH ?? '' } });
  let stdout = '';
  proc.stdout.on('data', (d) => (stdout += d));
  const done = new Promise<{ exitCode: number | null; stdout: string }>((resolve) => proc.on('close', (exitCode) => resolve({ exitCode, stdout })));
  return { proc, done };
}
