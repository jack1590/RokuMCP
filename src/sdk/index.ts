/**
 * The roku-mcp SDK: every device operation the MCP tools, the CLI and code mode use.
 * Functions take one options object; device-facing ones accept `host`, `rceDevice` and
 * `password` (see the target precedence in roku-config.ts). They return data, not MCP text,
 * and throw RokuError for expected failures and the underlying error otherwise.
 */
import type { TargetParams } from '../roku-config.js';
import { withDefaults } from './defaults.js';
import * as device from './device.js';
import * as input from './input.js';
import * as ui from './ui.js';
import * as deployment from './deploy.js';
import * as shots from './screenshot.js';
import * as consoleApi from './console.js';
import * as rtaApi from './rta.js';
import * as profiler from './profiler.js';
import * as perfetto from './perfetto.js';
import * as stream from './stream.js';
import * as rce from './rce.js';

export { RokuError } from './errors.js';
export type { TargetParams } from '../roku-config.js';
export { discover, deviceInfo, activeApp, mediaPlayer, launch, sleep } from './device.js';
export { keypress, keySequence, typeText } from './input.js';
export { NO_DEV_CHANNEL, appUi, sgNodes, findNode, focusedNode } from './ui.js';
export { overlaps, deploy, deleteDevChannel } from './deploy.js';
export { screenshot } from './screenshot.js';
export {
  consoleConnect,
  consoleRead,
  consoleSend,
  consoleDisconnect,
  captureStart,
  consoleWait,
  captureStop,
  captureStatus,
  isCaptureActive,
} from './console.js';
export { editNode, setNodeVisible, moveNode, focusNode, removeNode, createNode, getValue, observeField } from './rta.js';
export { analyzeProfile, compareProfiles, readHeaderInfo } from './profiler.js';
export { perfettoEnable, perfettoStart, perfettoStop, analyzeTrace, compareTraces, queryTrace } from './perfetto.js';
export { diagnoseStream } from './stream.js';
export { listCloudDevices, cloudStatus, cloudStart, cloudStop } from './rce.js';

/** Binds default target options (host, rceDevice, password) to a function's options object. */
function bind<O extends object, R>(defaults: TargetParams, fn: (options: O) => R): (options?: Partial<TargetParams> & O) => R {
  return (options) => fn(withDefaults(defaults, options as O));
}

/**
 * A client whose device-facing calls default to one target, grouped by area:
 * `const roku = createRoku({ rceDevice: '400' }); await roku.input.keypress({ key: 'Home' });`
 */
export function createRoku(defaults: TargetParams = {}) {
  const b = <O extends object, R>(fn: (options: O) => R) => bind(defaults, fn);
  return {
    device: {
      discover: device.discover,
      info: b(device.deviceInfo),
      activeApp: b(device.activeApp),
      mediaPlayer: b(device.mediaPlayer),
      launch: b(device.launch),
      sleep: device.sleep,
    },
    input: { keypress: b(input.keypress), keySequence: b(input.keySequence), typeText: b(input.typeText) },
    ui: { appUi: b(ui.appUi), sgNodes: b(ui.sgNodes), findNode: b(ui.findNode), focusedNode: b(ui.focusedNode), screenshot: b(shots.screenshot) },
    app: { deploy: b(deployment.deploy), deleteDevChannel: b(deployment.deleteDevChannel) },
    console: {
      connect: b(consoleApi.consoleConnect),
      read: consoleApi.consoleRead,
      send: consoleApi.consoleSend,
      disconnect: consoleApi.consoleDisconnect,
      captureStart: b(consoleApi.captureStart),
      wait: consoleApi.consoleWait,
      captureStop: consoleApi.captureStop,
      captureStatus: consoleApi.captureStatus,
    },
    rta: {
      editNode: b(rtaApi.editNode),
      setNodeVisible: b(rtaApi.setNodeVisible),
      moveNode: b(rtaApi.moveNode),
      focusNode: b(rtaApi.focusNode),
      removeNode: b(rtaApi.removeNode),
      createNode: b(rtaApi.createNode),
      getValue: b(rtaApi.getValue),
      observeField: b(rtaApi.observeField),
    },
    profiler: { analyze: profiler.analyzeProfile, compare: profiler.compareProfiles, info: profiler.readHeaderInfo },
    perfetto: {
      enable: b(perfetto.perfettoEnable),
      start: b(perfetto.perfettoStart),
      stop: perfetto.perfettoStop,
      analyze: perfetto.analyzeTrace,
      compare: perfetto.compareTraces,
      query: perfetto.queryTrace,
    },
    stream: { diagnose: b(stream.diagnoseStream) },
    rce: {
      list: rce.listCloudDevices,
      status: (o: { rceDevice?: string } = {}) => rce.cloudStatus(withDefaults({ rceDevice: defaults.rceDevice }, o)),
      start: (o: rce.CloudStartOptions = {}) => rce.cloudStart(withDefaults({ rceDevice: defaults.rceDevice }, o)),
      stop: (o: { rceDevice?: string } = {}) => rce.cloudStop(withDefaults({ rceDevice: defaults.rceDevice }, o)),
    },
  };
}

export type RokuClient = ReturnType<typeof createRoku>;
