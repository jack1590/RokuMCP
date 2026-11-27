/**
 * Parity harness: calls every tool with fixed inputs against fake devices and compares the
 * full result (text, images, isError) plus every request the fakes received with the
 * recording in test/parity/golden.json.
 *
 * The recording was made on master @ 80f87a6 (v1.9.0), before the SDK extraction.
 * Re-record only on purpose: UPDATE_GOLDEN=1 npm test.
 *
 * Not covered here (they need the network or a downloaded binary): roku_discover (SSDP),
 * analyze_perfetto, compare_perfetto, query_perfetto (trace_processor), roku_perfetto_start
 * and the LAN installer on port 80 (only its connection-refused path).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { setRceClientFactory } from '../src/rce.js';
import { buildServer } from '../src/index.js';
import { FakeWorld, startLanFakes, stubRce } from './helpers/fakes.js';
import { buildBsprof } from './helpers/bsprof-fixture.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const goldenPath = path.join(repo, 'test', 'parity', 'golden.json');
const fixtureApp = path.join(repo, 'test', 'fixtures', 'app');

const LAN = { host: '127.0.0.1' };
const RCE = { rceDevice: '400' };
const futureJwt = jwt({ exp: 4_102_444_800 });
const expiredJwt = jwt({ exp: 1_000 });

function jwt(payload: object): string {
  const b = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b({ alg: 'none' })}.${b(payload)}.sig`;
}

type Env = Record<string, string | undefined>;
interface Step {
  name: string;
  tool: string;
  args?: Record<string, unknown>;
  env?: Env;
  before?: (w: FakeWorld) => unknown;
  /** Extra evidence recorded after the call (e.g. a file the tool wrote). */
  after?: () => unknown;
}

const settle = () => new Promise<void>((r) => setTimeout(r, 50));

const BASE_ENV: Env = { ROKU_DEVICE_PASSWORD: 'pw', ROKU_RCE_PASSWORD: 'rpw' };

function steps(work: string): Step[] {
  const s: Step[] = [];
  const sampleApp = path.join(work, 'app');
  const add = (name: string, tool: string, args?: Record<string, unknown>, extra: Partial<Step> = {}) => s.push({ name, tool, args, ...extra });

  // --- ECP and input, on a LAN device and on a Cloud Device ---------------------------------
  for (const [label, t] of [['lan', LAN], ['rce', RCE]] as const) {
    add(`${label} keypress`, 'roku_keypress', { ...t, key: 'Home' });
    add(`${label} keypress literal percent`, 'roku_keypress', { ...t, key: 'Lit_%' });
    add(`${label} key sequence`, 'roku_keypress_sequence', { ...t, keys: ['Up', 'Down', 'Select'], delayMs: 0 });
    add(`${label} type text`, 'roku_type_text', { ...t, text: 'a b&', delayMs: 0 });
    add(`${label} launch with params`, 'roku_launch', { ...t, appId: 'dev', params: { contentId: '42', mediaType: 'movie' } });
    add(`${label} launch restart`, 'roku_launch', { ...t, appId: 'dev', restart: true });
    add(`${label} launch restart, exit-app fails`, 'roku_launch', { ...t, appId: 'dev', restart: true }, { before: (w) => (w.ecpStatus['exit-app/dev'] = 500) });
    add(`${label} device info`, 'roku_query_device_info', { ...t });
    add(`${label} active app`, 'roku_query_active_app', { ...t });
    add(`${label} media player`, 'roku_query_media_player', { ...t });
    add(`${label} media player 403`, 'roku_query_media_player', { ...t }, { before: (w) => (w.ecpStatus['query/media-player'] = 403) });
    add(`${label} app ui`, 'roku_query_app_ui', { ...t });
    add(`${label} app ui 404`, 'roku_query_app_ui', { ...t }, { before: (w) => (w.ecpStatus['query/app-ui'] = 404) });
    add(`${label} app ui 403`, 'roku_query_app_ui', { ...t }, { before: (w) => (w.ecpStatus['query/app-ui'] = 403) });
    add(`${label} app ui 401`, 'roku_query_app_ui', { ...t }, { before: (w) => (w.ecpStatus['query/app-ui'] = 401) });
    add(`${label} app ui 500`, 'roku_query_app_ui', { ...t }, { before: (w) => (w.ecpStatus['query/app-ui'] = 500) });
    add(`${label} sg nodes all`, 'roku_query_sg_nodes', { ...t, type: 'all' });
    add(`${label} sg nodes roots`, 'roku_query_sg_nodes', { ...t, type: 'roots' });
    add(`${label} sg nodes node`, 'roku_query_sg_nodes', { ...t, type: 'node', nodeId: 'RTA_2' });
    add(`${label} sg nodes node without id`, 'roku_query_sg_nodes', { ...t, type: 'node' });
    add(`${label} sg nodes 404`, 'roku_query_sg_nodes', { ...t, type: 'all' }, { before: (w) => (w.ecpStatus['query/sgnodes/all'] = 404) });
    add(`${label} find node by id`, 'roku_find_node', { ...t, nodeId: 'menu' });
    add(`${label} find node by name`, 'roku_find_node', { ...t, nodeId: 'title' });
    add(`${label} find node by attr`, 'roku_find_node', { ...t, attr: 'text', value: 'Play' });
    add(`${label} find node by prefixed attr, many`, 'roku_find_node', { ...t, attr: '@_name', value: 'MainScene' });
    add(`${label} find node by subtype attr, many`, 'roku_find_node', { ...t, attr: 'focused', value: 'true' });
    add(`${label} find node none`, 'roku_find_node', { ...t, nodeId: 'nothing' });
    add(`${label} find node none by attr`, 'roku_find_node', { ...t, attr: 'text', value: 'Nope' });
    add(`${label} find node missing args`, 'roku_find_node', { ...t, attr: 'text' });
    add(`${label} find node 404`, 'roku_find_node', { ...t, nodeId: 'menu' }, { before: (w) => (w.ecpStatus['query/app-ui'] = 404) });
    add(`${label} focused node`, 'roku_get_focused_node', { ...t });
    add(`${label} focused node 404`, 'roku_get_focused_node', { ...t }, { before: (w) => (w.ecpStatus['query/app-ui'] = 404) });
  }
  add('sleep', 'roku_sleep', { durationMs: 5 });
  add('sleep negative', 'roku_sleep', { durationMs: -3 });
  add('unknown cloud device', 'roku_keypress', { rceDevice: 'nope', key: 'Home' });
  add('unresolvable host', 'roku_query_device_info', { host: 'no-such-host.invalid' });
  add('ROKU_RCE_DEVICE env picks the Cloud Device', 'roku_keypress', { key: 'Back' }, { env: { ROKU_RCE_DEVICE: '400' } });
  add('host param beats ROKU_RCE_DEVICE', 'roku_keypress', { ...LAN, key: 'Back' }, { env: { ROKU_RCE_DEVICE: '400' } });
  add('ROKU_IP alias', 'roku_keypress', { key: 'Back' }, { env: { ROKU_IP: '127.0.0.1' } });

  // --- Deploy, delete, screenshot ---------------------------------------------------------
  add('deploy without manifest', 'roku_deploy', { ...RCE, rootDir: path.join(work, 'empty') });
  add('deploy rce', 'roku_deploy', { ...RCE, rootDir: sampleApp });
  add('deploy rce identical', 'roku_deploy', { rceDevice: 'Parity_3', rootDir: sampleApp, files: ['manifest', 'source/**/*'] });
  add('deploy staging overlaps rootDir', 'roku_deploy', { ...RCE, rootDir: sampleApp, stagingDir: path.join(sampleApp, 'stage') });
  add('deploy staging contains rootDir', 'roku_deploy', { ...RCE, rootDir: sampleApp, stagingDir: work });
  add('deploy lan, installer closed', 'roku_deploy', { ...LAN, rootDir: sampleApp, stagingDir: path.join(work, 'stage') });
  add('deploy lan without password', 'roku_deploy', { ...LAN, rootDir: sampleApp }, { env: { ROKU_DEVICE_PASSWORD: undefined } });
  add('deploy rce without password', 'roku_deploy', { ...RCE, rootDir: sampleApp }, { env: { ROKU_DEVICE_PASSWORD: undefined, ROKU_RCE_PASSWORD: undefined } });
  add('deploy rce password param', 'roku_deploy', { ...RCE, rootDir: sampleApp, password: 'param' }, { env: { ROKU_DEVICE_PASSWORD: undefined, ROKU_RCE_PASSWORD: undefined } });
  add('delete rce', 'roku_delete_dev_channel', { ...RCE });
  add('delete lan, installer closed', 'roku_delete_dev_channel', { ...LAN });
  add('delete lan without password', 'roku_delete_dev_channel', { ...LAN }, { env: { ROKU_DEVICE_PASSWORD: undefined } });
  add('screenshot rce to dir', 'roku_screenshot', { ...RCE, outDir: path.join(work, 'shots'), outFile: 'shot' }, { after: () => fs.readFileSync(path.join(work, 'shots', 'shot.png')).toString('hex') });
  add('screenshot rce default name', 'roku_screenshot', { ...RCE, outDir: path.join(work, 'shots') });
  add('screenshot lan, installer closed', 'roku_screenshot', { ...LAN });
  add('screenshot without password', 'roku_screenshot', { ...LAN }, { env: { ROKU_DEVICE_PASSWORD: undefined } });

  // --- Single-shot console ----------------------------------------------------------------
  add('console read without connection', 'roku_console_read');
  add('console send without connection', 'roku_console_send', { command: 'bt' });
  add('console disconnect without connection', 'roku_console_disconnect');
  add('console connect lan', 'roku_console_connect', { ...LAN });
  add('console connect again', 'roku_console_connect', { ...RCE });
  add('console read lan', 'roku_console_read');
  add('console connect rce', 'roku_console_connect', { ...RCE });
  add('console send bt', 'roku_console_send', { command: 'bt' });
  add('console connect lan for disconnect', 'roku_console_connect', { ...LAN });
  add('console disconnect', 'roku_console_disconnect');
  add('console connect refused port', 'roku_console_connect', { ...LAN, port: 8099 });
  add('console connect rce closed bridge', 'roku_console_connect', { ...RCE, port: 8087 }, { before: (w) => w.closedPorts.add(8087) });
  add('console connect, read nothing new', 'roku_console_connect', { ...LAN });
  add('console read drains the replay', 'roku_console_read');

  // --- Console capture --------------------------------------------------------------------
  const capFile = path.join(work, 'logs', 'cap.log');
  add('capture status idle', 'roku_console_capture_status');
  add('capture wait without capture', 'roku_console_wait', { pattern: 'x' });
  add('capture stop without capture', 'roku_console_capture_stop');
  add('capture start rce', 'roku_console_capture_start', { ...RCE, file: capFile, settleMs: 100 });
  add('console connect during capture', 'roku_console_connect', { ...LAN });
  add('console read during capture', 'roku_console_read');
  add('capture start twice', 'roku_console_capture_start', { ...LAN, file: capFile, settleMs: 10 });
  add('capture wait matched', 'roku_console_wait', { pattern: 'app started', timeoutMs: 1000 }, {
    before: (w) => {
      w.consoleEmit('[12:00:01.000] app started\r\n');
      w.consoleEmit(`01-02 12:00:02.500 GET /a Authorization: Bearer ${expiredJwt}\n`);
      w.consoleEmit(`01-02 12:00:03.250 GET /b Authorization: Bearer ${futureJwt}\n`);
      w.consoleEmit('partial tail');
      return settle();
    },
  });
  add('capture wait jwtValid', 'roku_console_wait', { pattern: 'Authorization', predicate: 'jwtValid', timeoutMs: 1000 });
  add('capture wait invalid pattern', 'roku_console_wait', { pattern: '(' });
  add('capture wait timeout', 'roku_console_wait', { pattern: 'never', timeoutMs: 50 });
  add('capture wait new lines only', 'roku_console_wait', { pattern: 'app started|late', sinceCaptureStart: false, timeoutMs: 2000 }, {
    before: (w) => void setTimeout(() => w.consoleEmit('\nlate line\n'), 50),
  });
  add('capture wait waiting_for_debugger', 'roku_console_wait', { pattern: 'nomatch', timeoutMs: 2000 }, {
    before: (w) => void setTimeout(() => w.consoleEmit('------ Waiting for debugger on 192.168.1.2:8081\n'), 50),
  });
  add('capture status active', 'roku_console_capture_status');
  add('capture stop', 'roku_console_capture_stop', undefined, { after: () => fs.readFileSync(capFile, 'utf8') });
  add('capture start lan append', 'roku_console_capture_start', { ...LAN, file: capFile, append: true, settleMs: 50 });
  add('capture stop lan', 'roku_console_capture_stop', undefined, {
    before: (w) => {
      w.consoleEmit('appended\n');
      return settle();
    },
    after: () => fs.readFileSync(capFile, 'utf8'),
  });
  add('capture start refused', 'roku_console_capture_start', { ...RCE, file: capFile, settleMs: 10 }, { before: (w) => w.closedPorts.add(8085) });
  add('capture status after refused start', 'roku_console_capture_status');

  // --- Runtime UI editing (RTA) ------------------------------------------------------------
  for (const [label, t] of [['lan', LAN], ['rce', RCE]] as const) {
    add(`${label} edit node by element id`, 'roku_edit_node', { ...t, nodeId: 'RTA_2', fields: { text: 'Hi', visible: false, translation: [1, 2], opacity: 0.5 } });
    add(`${label} edit node by scene id`, 'roku_edit_node', { ...t, nodeId: 'title', fields: { text: 'x' } });
    add(`${label} edit node rta error`, 'roku_edit_node', { ...t, nodeId: 'missingNode', fields: { text: 'x' } });
    add(`${label} edit node no fields`, 'roku_edit_node', { ...t, nodeId: 'RTA_2', fields: {} });
    add(`${label} set visible`, 'roku_set_node_visible', { ...t, nodeId: 'RTA_2', visible: false });
    add(`${label} set visible true`, 'roku_set_node_visible', { ...t, nodeId: 'title', visible: true });
    add(`${label} move node`, 'roku_move_node', { ...t, nodeId: 'RTA_3', x: 10, y: 20 });
    add(`${label} move node rta error`, 'roku_move_node', { ...t, nodeId: 'missing', x: 1, y: 1 });
    add(`${label} focus node`, 'roku_focus_node', { ...t, nodeId: 'RTA_4' });
    add(`${label} unfocus node`, 'roku_focus_node', { ...t, nodeId: 'menu', on: false });
    add(`${label} remove node`, 'roku_remove_node', { ...t, nodeId: 'rta_5' });
    add(`${label} create node`, 'roku_create_node', { ...t, parentId: 'RTA_3', subtype: 'Label', id: 'newLabel', fields: { text: 'n' } });
    add(`${label} create node bare`, 'roku_create_node', { ...t, parentId: 'menu', subtype: 'Rectangle' });
    add(`${label} get value element`, 'roku_get_value', { ...t, nodeId: 'RTA_2', field: 'text' });
    add(`${label} get value scene`, 'roku_get_value', { ...t, nodeId: 'title', field: 'text' });
    add(`${label} get value keyPath`, 'roku_get_value', { ...t, keyPath: 'MainScene.title.text' });
    add(`${label} get value keyPath global`, 'roku_get_value', { ...t, keyPath: 'appVersion', base: 'global' });
    add(`${label} get value base override`, 'roku_get_value', { ...t, nodeId: 'RTA_2', field: 'text', base: 'scene' });
    add(`${label} get value rta error`, 'roku_get_value', { ...t, keyPath: 'missing.text' });
    add(`${label} get value missing args`, 'roku_get_value', { ...t, nodeId: 'RTA_2' });
    add(`${label} observe element`, 'roku_observe_field', { ...t, nodeId: 'RTA_2', field: 'text', match: 'Hi', timeoutMs: 100 });
    add(`${label} observe scene`, 'roku_observe_field', { ...t, nodeId: 'title', field: 'visible', timeoutMs: 100 });
    add(`${label} observe keyPath`, 'roku_observe_field', { ...t, keyPath: 'MainScene.video.state', match: 'playing' });
    add(`${label} observe missing args`, 'roku_observe_field', { ...t, field: 'text' });
    add(`${label} rta not in channel`, 'roku_edit_node', { ...t, nodeId: 'RTA_2', fields: { text: 'x' } }, { before: (w) => (w.rtaUp = false) });
  }
  add('rta observe timeout', 'roku_observe_field', { ...RCE, keyPath: 'MainScene.x', timeoutMs: 100 }, { before: (w) => w.rtaSilent.add('onFieldChangeOnce') });
  add('rta rce port closed', 'roku_get_value', { ...RCE, keyPath: 'a.b' }, { before: (w) => w.closedPorts.add(9000) });
  add('rta lan refused', 'roku_focus_node', { host: '127.0.0.1', nodeId: 'RTA_1' }, { before: (w) => (w.rtaUp = false) });

  // --- Perfetto -------------------------------------------------------------------------
  add('perfetto stop without recording', 'roku_perfetto_stop');
  add('perfetto enable lan', 'roku_perfetto_enable', { ...LAN });
  add('perfetto enable lan 500', 'roku_perfetto_enable', { ...LAN, channelId: '12345' }, { before: (w) => (w.ecpStatus['perfetto/enable/12345'] = 500) });
  add('perfetto enable rce', 'roku_perfetto_enable', { ...RCE });
  add('perfetto start rce', 'roku_perfetto_start', { ...RCE });
  add('perfetto enable via ROKU_RCE_DEVICE', 'roku_perfetto_enable', {}, { env: { ROKU_RCE_DEVICE: '400' } });
  add('perfetto stop after enable', 'roku_perfetto_stop');

  // --- bsprof ---------------------------------------------------------------------------
  const prof = path.join(work, 'tiny.bsprof');
  for (const mode of ['memory', 'cpu', 'full', 'summary']) add(`bsprof ${mode}`, 'analyze_bsprof', { filePath: prof, mode });
  add('bsprof options', 'analyze_bsprof', { filePath: prof, mode: 'memory', top: 1, sortBy: 'allocated', filterModule: 'main', threshold: 5 });
  add('bsprof compare', 'compare_bsprof', { beforePath: prof, afterPath: prof, top: 5 });
  add('bsprof info', 'bsprof_info', { filePath: prof });
  add('bsprof missing file', 'analyze_bsprof', { filePath: path.join(work, 'none.bsprof'), mode: 'cpu' });
  add('bsprof compare missing file', 'compare_bsprof', { beforePath: prof, afterPath: path.join(work, 'none.bsprof') });
  add('bsprof info missing file', 'bsprof_info', { filePath: path.join(work, 'none.bsprof') });

  // --- Stream diagnosis ------------------------------------------------------------------
  const master = fs.readFileSync(path.join(repo, 'test-streams', 'demuxed-aac-hls', 'master.m3u8'), 'utf8');
  add('diagnose without evidence', 'roku_diagnose_stream', {});
  add('diagnose drm error', 'roku_diagnose_stream', { errorInfo: '{"errorCode":-6,"errorInfo":{"category":"drm","drmerrcode":13,"dbgmsg":"license"}}' });
  add('diagnose pasted log text', 'roku_diagnose_stream', { errorInfo: 'errorCode: -3 errorMsg: "unknown codec"' });
  add('diagnose error and manifest', 'roku_diagnose_stream', { errorInfo: '{"errorCode":-5}', content: master, format: 'hls', drm: { keySystem: 'Widevine' } });
  add('diagnose missing charles file', 'roku_diagnose_stream', { charlesSessionPath: path.join(work, 'none.chlsj') });
  add('diagnose bad manifest', 'roku_diagnose_stream', { content: 'not a manifest' });
  add('diagnose captureLive rce', 'roku_diagnose_stream', { ...RCE, captureLive: true });
  add('diagnose captureLive without url', 'roku_diagnose_stream', { ...LAN, captureLive: true });
  add('diagnose captureLive ignored with errorInfo', 'roku_diagnose_stream', { ...RCE, captureLive: true, errorInfo: '{"errorCode":-1}' });

  // --- Roku Cloud Emulator ---------------------------------------------------------------
  add('rce list devices', 'roku_rce_list_devices');
  add('rce status running', 'roku_rce_status', { rceDevice: '400' });
  add('rce status by name', 'roku_rce_status', { rceDevice: 'Parity_2' });
  add('rce status from env', 'roku_rce_status', {}, { env: { ROKU_RCE_DEVICE: '402' } });
  add('rce status without device', 'roku_rce_status', {});
  add('rce status unknown', 'roku_rce_status', { rceDevice: 'nope' });
  add('rce start refuses a running device', 'roku_rce_start', { rceDevice: '400' });
  add('rce start', 'roku_rce_start', { rceDevice: '401' });
  add('rce start with options', 'roku_rce_start', { rceDevice: '401', snapshotId: 1126, maxRuntimeMinutes: 5 });
  add('rce start not ready', 'roku_rce_start', { rceDevice: '402' }, { before: (w) => w.readyFails.add(402) });
  add('rce start without device', 'roku_rce_start', {});
  add('rce start max runtime too high', 'roku_rce_start', { rceDevice: '401', maxRuntimeMinutes: 500 });
  add('rce stop', 'roku_rce_stop', { rceDevice: '400' });
  add('rce stop without run', 'roku_rce_stop', { rceDevice: '401' });
  add('rce stop unknown', 'roku_rce_stop', { rceDevice: 'nope' });
  return s;
}

/** Removes what changes between runs: paths, times, random ids, elapsed-time billing. */
function normalizer(work: string) {
  const tmp = [fs.realpathSync(os.tmpdir()), os.tmpdir()];
  return (text: string): string => {
    let t = text.split(work).join('<work>').split(fs.realpathSync(work)).join('<work>').split(repo).join('<repo>');
    for (const d of tmp) t = t.split(d).join('<tmp>');
    return t
      .replace(/screenshot-\d+/g, 'screenshot-<ts>')
      .replace(/roku-mcp-staging-\d+/g, 'roku-mcp-staging-<ts>')
      .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z/g, '<iso>')
      .replace(/("(?:elapsedSeconds|billedMinutes|costUsd|billedMinutesAtStop|costUsdAtStop)\\?":\s*)[\d.]+/g, '$1<n>');
  };
}

/** RTA request ids are random; only the get_value and observe_field results echo them. */
const RTA_ECHO = new Set(['roku_get_value', 'roku_observe_field']);

function maskRtaId(tool: string, text: string): string {
  return RTA_ECHO.has(tool) ? text.replace(/^(\{\s*"id":\s*")[a-z0-9]+(")/, '$1<rta-id>$2') : text;
}

const ENV_KEYS = ['ROKU_DEVICE_HOST', 'ROKU_IP', 'ROKU_HOST', 'ROKU_DEV_TARGET', 'ROKU_DEVICE_PASSWORD', 'ROKU_DEV_PASSWORD', 'ROKU_PASSWORD', 'ROKU_RCE_DEVICE', 'ROKU_RCE_PASSWORD', 'ROKU_RCE_TOKEN'];

function setEnv(env: Env): void {
  for (const k of ENV_KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(env)) if (v !== undefined) process.env[k] = v;
}

test('every tool matches the master recording', { timeout: 180_000 }, async () => {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'roku-parity-'));
  fs.mkdirSync(path.join(work, 'empty'));
  fs.writeFileSync(path.join(work, 'tiny.bsprof'), buildBsprof());
  fs.cpSync(fixtureApp, path.join(work, 'app'), { recursive: true });
  const world = new FakeWorld();
  setRceClientFactory(() => stubRce(world));
  const lan = await startLanFakes(world);
  const server: McpServer = buildServer();
  const client = new Client({ name: 'parity', version: '0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const norm = normalizer(work);
  const records: unknown[] = [];

  try {
    for (const step of steps(work)) {
      setEnv({ ...BASE_ENV, ...step.env });
      world.calls = [];
      world.ecpStatus = {};
      world.rtaUp = true;
      world.rtaSilent.clear();
      world.closedPorts.clear();
      world.readyFails.clear();
      await step.before?.(world);
      let result: unknown;
      try {
        result = await client.callTool({ name: step.tool, arguments: step.args ?? {} }, undefined, { timeout: 60_000 });
      } catch (error) {
        result = { thrown: error instanceof Error ? error.message : String(error) };
      }
      for (const c of (result as { content?: Array<{ text?: string }> }).content ?? []) {
        if (typeof c.text === 'string') c.text = maskRtaId(step.tool, c.text);
      }
      // Let late socket events (closes, bridge teardown) land in this step's call log.
      await new Promise((r) => setTimeout(r, 20));
      const extra = step.after?.();
      records.push(JSON.parse(norm(JSON.stringify({ name: step.name, tool: step.tool, args: step.args ?? {}, result, calls: [...world.calls], ...(extra !== undefined ? { extra } : {}) }))));
    }
  } finally {
    await client.close();
    await lan.close();
    setEnv(saved);
    fs.rmSync(work, { recursive: true, force: true });
  }

  if (process.env.UPDATE_GOLDEN) {
    fs.mkdirSync(path.dirname(goldenPath), { recursive: true });
    fs.writeFileSync(goldenPath, JSON.stringify(records, null, 2) + '\n');
    return;
  }
  const golden = JSON.parse(fs.readFileSync(goldenPath, 'utf8')) as Array<{ name: string }>;
  assert.equal(records.length, golden.length, 'step count changed');
  for (let i = 0; i < golden.length; i++) assert.deepEqual(records[i], golden[i], `parity mismatch at step ${i}: ${golden[i].name}`);
});

test('tools/list matches the master recording (names, schemas, descriptions, annotations)', async () => {
  const server: McpServer = buildServer();
  const client = new Client({ name: 'parity', version: '0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const { tools } = await client.listTools();
  await client.close();
  const listPath = path.join(repo, 'test', 'parity', 'tools-list.json');
  assert.deepEqual(JSON.parse(JSON.stringify(tools)), JSON.parse(fs.readFileSync(listPath, 'utf8')));
});
