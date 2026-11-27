import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { RceError } from 'roku-rce';
import { DESTRUCTIVE, READ_ONLY, WRITES, targetParams } from '../roku-config.js';
import * as sdk from '../sdk/index.js';
import { isRtaError, type RtaResponse } from '../sdk/rta.js';
import { RokuError } from '../sdk/errors.js';
import { errorText, failure, type ToolResult } from './result.js';

const RTA_SETUP_HINT =
  '\n\nThis tool talks to the roku-test-automation (RTA) On-Device Component on TCP port 9000. ' +
  'If the connection is refused, the channel does not include RTA. To enable it, either bundle the RTA OnDeviceComponent in your channel ' +
  'OR (when sideloading via roku-debug) set `"injectRdbOnDeviceComponent": true` in launch.json and add the marker comment ' +
  '`\' vscode_rdb_on_device_component_entry` immediately after `screen.show()` inside `main()`. ' +
  'A successful install logs `[RTA][INFO] OnDeviceComponent init` at channel launch.';

const RCE_PORT_9000 =
  'Port 9000 did not answer through the Roku Cloud Emulator bridge (RCE answered with a closed-port status). ' +
  'Either the running channel does not include the RTA On-Device Component, or RCE does not bridge port 9000 ' +
  '(RCE documents bridges for 8080, 8081, 8082, 8085, 8087, 9999 and 49152-65535). This path is unverified on RCE.';

/** One error text for every edit-UI tool; RCE closed-port errors get their own explanation. */
function rtaFailure(prefix: string, error: unknown): ToolResult {
  if (error instanceof RceError && error.code === 'port_closed') return failure(`${prefix}: ${RCE_PORT_9000}`);
  if (error instanceof RokuError) return failure(errorText(prefix, error));
  return failure(`${errorText(prefix, error)}${RTA_SETUP_HINT}`);
}

const EDIT_UI_RULE =
  ' Address nodes by their uiElementId (RTA_<digits>) from roku_query_app_ui; a name attribute is not addressable and returns OK while changing nothing. ' +
  'Verify every change with roku_get_value: OK alone is not proof. On a Roku Cloud Emulator device port 9000 is reached through an RCE bridge, which is unverified.';

function summarizeResponse(json: RtaResponse): string {
  if (!json) return '(no response)';
  if (json.error) return `RTA error: ${typeof json.error === 'string' ? json.error : JSON.stringify(json.error)}`;
  const { id: _id, timeTaken: _t, ...rest } = json;
  void _id; void _t;
  const trimmed = JSON.stringify(rest);
  return trimmed === '{}' ? 'OK' : trimmed;
}

const rtaResult = (what: string, json: RtaResponse): ToolResult => ({
  content: [{ type: 'text', text: `${what} -> ${summarizeResponse(json)}` }],
  isError: isRtaError(json) || undefined,
});

export function registerEditUiTools(server: McpServer): void {
  server.registerTool(
    'roku_edit_node',
    {
      title: 'Edit node fields',
      annotations: WRITES,
      description:
        'Edit a SceneGraph node on the running dev channel at runtime by setting one or more fields. ' +
        'Uses the roku-test-automation (RTA) On-Device Component on TCP port 9000 — the same backend the SceneGraph Inspector in the vscode-brightscript-language extension uses. ' +
        'Requires RTA to be present in the running channel (see README "Runtime UI Editing"). ' +
        'nodeId can be either a `uiElementId` like "RTA_1773" (as shown by roku_query_sg_nodes) or a BrightScript scene-level `id`. ' +
        'Common fields: visible (boolean), translation ([x,y]), text (string), color (hex like "0xRRGGBBAA"), opacity (number 0..1).' + EDIT_UI_RULE,
      inputSchema: {
        ...targetParams,
        nodeId: z.string().describe('uiElementId (e.g. "RTA_1773") or BrightScript scene id of the node to edit'),
        fields: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.number())]))
          .describe('Map of field name -> new value. Each field becomes one setValue request.'),
      },
    },
    async (params) => {
      try {
        const results = await sdk.editNode(params);
        const lines = results.map((r) => `${r.field} = ${JSON.stringify(r.value)} -> ${summarizeResponse(r.response)}`);
        return {
          content: [{ type: 'text', text: `Updated node "${params.nodeId}":\n${lines.join('\n')}` }],
          isError: results.some((r) => isRtaError(r.response)) || undefined,
        };
      } catch (error) {
        return rtaFailure('Edit node failed', error);
      }
    }
  );

  server.registerTool(
    'roku_set_node_visible',
    {
      title: 'Set node visibility',
      annotations: WRITES,
      description: 'Show or hide a SceneGraph node by id via RTA setValue on the `visible` field.' + EDIT_UI_RULE,
      inputSchema: {
        ...targetParams,
        nodeId: z.string().describe('uiElementId (e.g. "RTA_1773") or BrightScript scene id of the node'),
        visible: z.boolean().describe('true to show, false to hide'),
      },
    },
    async (params) => {
      try {
        return rtaResult(`${params.visible ? 'Showed' : 'Hid'} "${params.nodeId}"`, await sdk.setNodeVisible(params));
      } catch (error) {
        return rtaFailure('Set visible failed', error);
      }
    }
  );

  server.registerTool(
    'roku_move_node',
    {
      title: 'Move node',
      annotations: WRITES,
      description: 'Move a SceneGraph node to a new position by setting its `translation` field to [x, y].' + EDIT_UI_RULE,
      inputSchema: {
        ...targetParams,
        nodeId: z.string().describe('uiElementId or scene id of the node to move'),
        x: z.number().describe('Target x coordinate in pixels'),
        y: z.number().describe('Target y coordinate in pixels'),
      },
    },
    async (params) => {
      try {
        return rtaResult(`Moved "${params.nodeId}" to [${params.x}, ${params.y}]`, await sdk.moveNode(params));
      } catch (error) {
        return rtaFailure('Move node failed', error);
      }
    }
  );

  server.registerTool(
    'roku_focus_node',
    {
      title: 'Focus node',
      annotations: WRITES,
      description: 'Set focus on a SceneGraph node by id via RTA focusNode.' + EDIT_UI_RULE,
      inputSchema: {
        ...targetParams,
        nodeId: z.string().describe('uiElementId or scene id of the node to focus'),
        on: z.boolean().optional().describe('true to set focus (default), false to remove'),
      },
    },
    async (params) => {
      try {
        return rtaResult(`Focus(${params.on ?? true}) "${params.nodeId}"`, await sdk.focusNode(params));
      } catch (error) {
        return rtaFailure('Focus node failed', error);
      }
    }
  );

  server.registerTool(
    'roku_remove_node',
    {
      title: 'Remove node',
      annotations: DESTRUCTIVE,
      description: 'Remove a SceneGraph node from its parent at runtime via RTA removeNode.' + EDIT_UI_RULE,
      inputSchema: {
        ...targetParams,
        nodeId: z.string().describe('uiElementId or scene id of the node to remove'),
      },
    },
    async (params) => {
      try {
        return rtaResult(`Removed "${params.nodeId}"`, await sdk.removeNode(params));
      } catch (error) {
        return rtaFailure('Remove node failed', error);
      }
    }
  );

  server.registerTool(
    'roku_create_node',
    {
      title: 'Create node',
      annotations: WRITES,
      description:
        'Create a new SceneGraph node at runtime and append it as a child of an existing node via RTA createChild. ' +
        'Subtype must be a SceneGraph node type registered for the running scene (e.g. Label, Rectangle, Poster, Group).' + EDIT_UI_RULE,
      inputSchema: {
        ...targetParams,
        parentId: z.string().describe('uiElementId or scene id of the parent node'),
        subtype: z.string().describe('SceneGraph subtype to create (Label, Rectangle, Poster, Group, ...)'),
        id: z.string().optional().describe('Optional id to set on the new node'),
        fields: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.number())]))
          .optional()
          .describe('Optional initial fields to set on the new node'),
      },
    },
    async (params) => {
      try {
        return rtaResult(`Created <${params.subtype}>${params.id ? ` id="${params.id}"` : ''} under "${params.parentId}"`, await sdk.createNode(params));
      } catch (error) {
        return rtaFailure('Create node failed', error);
      }
    }
  );

  server.registerTool(
    'roku_get_value',
    {
      title: 'Get node field value',
      annotations: READ_ONLY,
      description:
        'Read a field value from a SceneGraph node at runtime via RTA getValue. Returns the value as JSON. ' +
        'Pass either nodeId+field, or a full keyPath like "MainScene.rowList.0.title".' + EDIT_UI_RULE,
      inputSchema: {
        ...targetParams,
        nodeId: z.string().optional().describe('uiElementId or scene id of the node (combined with `field`)'),
        field: z.string().optional().describe('Field name on the node (used with nodeId)'),
        keyPath: z.string().optional().describe('Full RTA keyPath instead of nodeId+field (e.g. "MainScene.rowList.focusedRow.title.text")'),
        base: z.enum(['global', 'scene', 'elementId', 'focusedNode', 'nodeRef', 'appUI']).optional().describe('RTA base (default inferred from nodeId, or "scene" when using keyPath)'),
      },
    },
    async (params) => {
      try {
        const json = await sdk.getValue(params);
        return { content: [{ type: 'text', text: JSON.stringify(json, null, 2) }], isError: isRtaError(json) || undefined };
      } catch (error) {
        return rtaFailure('Get value failed', error);
      }
    }
  );

  server.registerTool(
    'roku_observe_field',
    {
      title: 'Observe node field',
      annotations: READ_ONLY,
      description:
        'Wait for a SceneGraph field to change (or match a specific value) via RTA onFieldChangeOnce. ' +
        'Returns when the observer fires or the timeout elapses. Great for "wait until video starts playing" style assertions.' + EDIT_UI_RULE,
      inputSchema: {
        ...targetParams,
        nodeId: z.string().optional().describe('uiElementId or scene id of the node'),
        keyPath: z.string().optional().describe('Full RTA keyPath (alternative to nodeId+field)'),
        field: z.string().optional().describe('Field name to observe (used with nodeId)'),
        match: z
          .union([z.string(), z.number(), z.boolean()])
          .optional()
          .describe('Optional value to wait for. If omitted, fires on any change.'),
        timeoutMs: z.number().optional().default(10_000).describe('How long to wait before giving up (default 10000)'),
      },
    },
    async (params) => {
      try {
        const json = await sdk.observeField(params);
        return { content: [{ type: 'text', text: JSON.stringify(json, null, 2) }], isError: isRtaError(json) || undefined };
      } catch (error) {
        return rtaFailure('Observe field failed', error);
      }
    }
  );
}
