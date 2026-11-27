/**
 * One table of SDK operations for the CLI (rokuctl) and code mode. Each command reuses the
 * input schema of the MCP tool it mirrors, so the three surfaces validate the same way.
 */
import { z, type ZodRawShape } from 'zod';
import * as sdk from './sdk/index.js';
import { toolSpecs } from './tools/index.js';

export interface Command {
  /** "<group>.<name>", e.g. "input.keypress". */
  name: string;
  /** The MCP tool whose input schema and description this command shares. */
  tool?: string;
  summary?: string;
  /** Schema keys filled from positional CLI arguments, in order; a trailing "..." collects the rest as an array. */
  positional?: string[];
  /** Holds state in this process between calls (console session, capture, recording): code mode only. */
  session?: boolean;
  /** Extra input keys for commands that are not a single tool. */
  extraShape?: ZodRawShape;
  run(options: any): unknown;
}

const consoleCapture: Command = {
  name: 'console.capture',
  summary:
    'Record the debug console to a file until a line matches pattern (or timeoutMs), then stop. Returns the match (redacted preview) and the capture summary. The CLI form of roku_console_capture_start + roku_console_wait + roku_console_capture_stop.',
  positional: ['pattern'],
  async run(options) {
    await sdk.captureStart(options);
    let match;
    let capture;
    try {
      match = await sdk.consoleWait(options);
    } finally {
      capture = await sdk.captureStop();
    }
    return { match, capture };
  },
};

export const COMMANDS: Command[] = [
  { name: 'device.discover', tool: 'roku_discover', run: sdk.discover },
  { name: 'device.info', tool: 'roku_query_device_info', run: sdk.deviceInfo },
  { name: 'device.active-app', tool: 'roku_query_active_app', run: sdk.activeApp },
  { name: 'device.media-player', tool: 'roku_query_media_player', run: sdk.mediaPlayer },
  { name: 'device.launch', tool: 'roku_launch', positional: ['appId'], run: sdk.launch },
  { name: 'device.sleep', tool: 'roku_sleep', positional: ['durationMs'], run: sdk.sleep },
  { name: 'input.keypress', tool: 'roku_keypress', positional: ['key'], run: sdk.keypress },
  { name: 'input.keys', tool: 'roku_keypress_sequence', positional: ['keys...'], run: sdk.keySequence },
  { name: 'input.type', tool: 'roku_type_text', positional: ['text'], run: sdk.typeText },
  { name: 'ui.app-ui', tool: 'roku_query_app_ui', run: sdk.appUi },
  { name: 'ui.sg-nodes', tool: 'roku_query_sg_nodes', positional: ['type', 'nodeId'], run: sdk.sgNodes },
  { name: 'ui.find', tool: 'roku_find_node', positional: ['nodeId'], run: sdk.findNode },
  { name: 'ui.focused', tool: 'roku_get_focused_node', run: sdk.focusedNode },
  { name: 'ui.screenshot', tool: 'roku_screenshot', run: sdk.screenshot },
  { name: 'app.deploy', tool: 'roku_deploy', positional: ['rootDir'], run: sdk.deploy },
  { name: 'app.delete', tool: 'roku_delete_dev_channel', run: sdk.deleteDevChannel },
  { name: 'console.connect', tool: 'roku_console_connect', session: true, run: sdk.consoleConnect },
  { name: 'console.read', tool: 'roku_console_read', session: true, run: sdk.consoleRead },
  { name: 'console.send', tool: 'roku_console_send', session: true, run: sdk.consoleSend },
  { name: 'console.disconnect', tool: 'roku_console_disconnect', session: true, run: sdk.consoleDisconnect },
  { name: 'console.capture-start', tool: 'roku_console_capture_start', session: true, run: sdk.captureStart },
  { name: 'console.wait', tool: 'roku_console_wait', session: true, run: sdk.consoleWait },
  { name: 'console.capture-stop', tool: 'roku_console_capture_stop', session: true, run: sdk.captureStop },
  { name: 'console.capture-status', tool: 'roku_console_capture_status', session: true, run: sdk.captureStatus },
  consoleCapture,
  { name: 'rta.edit', tool: 'roku_edit_node', positional: ['nodeId'], run: sdk.editNode },
  { name: 'rta.visible', tool: 'roku_set_node_visible', positional: ['nodeId', 'visible'], run: sdk.setNodeVisible },
  { name: 'rta.move', tool: 'roku_move_node', positional: ['nodeId', 'x', 'y'], run: sdk.moveNode },
  { name: 'rta.focus', tool: 'roku_focus_node', positional: ['nodeId'], run: sdk.focusNode },
  { name: 'rta.remove', tool: 'roku_remove_node', positional: ['nodeId'], run: sdk.removeNode },
  { name: 'rta.create', tool: 'roku_create_node', positional: ['parentId', 'subtype'], run: sdk.createNode },
  { name: 'rta.get', tool: 'roku_get_value', positional: ['nodeId', 'field'], run: sdk.getValue },
  { name: 'rta.observe', tool: 'roku_observe_field', positional: ['nodeId', 'field'], run: sdk.observeField },
  { name: 'profile.analyze', tool: 'analyze_bsprof', positional: ['filePath', 'mode'], run: sdk.analyzeProfile },
  { name: 'profile.compare', tool: 'compare_bsprof', positional: ['beforePath', 'afterPath'], run: sdk.compareProfiles },
  { name: 'profile.info', tool: 'bsprof_info', positional: ['filePath'], run: (o: { filePath: string }) => sdk.readHeaderInfo(o.filePath) },
  { name: 'perfetto.enable', tool: 'roku_perfetto_enable', run: sdk.perfettoEnable },
  { name: 'perfetto.start', tool: 'roku_perfetto_start', session: true, run: sdk.perfettoStart },
  { name: 'perfetto.stop', tool: 'roku_perfetto_stop', session: true, run: sdk.perfettoStop },
  { name: 'perfetto.analyze', tool: 'analyze_perfetto', positional: ['filePath', 'mode'], run: sdk.analyzeTrace },
  { name: 'perfetto.compare', tool: 'compare_perfetto', positional: ['beforePath', 'afterPath'], run: sdk.compareTraces },
  { name: 'perfetto.query', tool: 'query_perfetto', positional: ['filePath', 'sql'], run: sdk.queryTrace },
  { name: 'stream.diagnose', tool: 'roku_diagnose_stream', run: sdk.diagnoseStream },
  { name: 'rce.list', tool: 'roku_rce_list_devices', run: sdk.listCloudDevices },
  { name: 'rce.status', tool: 'roku_rce_status', positional: ['rceDevice'], run: sdk.cloudStatus },
  { name: 'rce.start', tool: 'roku_rce_start', positional: ['rceDevice'], run: sdk.cloudStart },
  { name: 'rce.stop', tool: 'roku_rce_stop', positional: ['rceDevice'], run: sdk.cloudStop },
];

export function findCommand(name: string): Command | undefined {
  return COMMANDS.find((c) => c.name === name);
}

/** The command's input shape: its tool's schema, or for composites the union of the tools it chains. */
export function commandShape(command: Command): ZodRawShape {
  if (command.tool) return toolSpecs().get(command.tool)!.inputSchema;
  if (command === consoleCapture) {
    const specs = toolSpecs();
    return { ...specs.get('roku_console_capture_start')!.inputSchema, ...specs.get('roku_console_wait')!.inputSchema };
  }
  return command.extraShape ?? {};
}

export function commandSummary(command: Command): string {
  return command.summary ?? toolSpecs().get(command.tool!)?.description ?? '';
}

/** Validates and applies defaults exactly as the MCP tool would. */
export function parseCommandInput(command: Command, input: unknown) {
  return z.object(commandShape(command)).safeParse(input);
}
