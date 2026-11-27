import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
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
  return { code: r.exitCode, json: JSON.parse(r.stdout) };
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
