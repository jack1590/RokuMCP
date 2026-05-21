import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import net from 'net';
import { resolveHost, friendlyError } from '../roku-config.js';

/**
 * Edit a running SceneGraph UI at runtime using the roku-test-automation (RTA)
 * On-Device Component, the same backend the SceneGraph Inspector in the
 * rokucommunity/vscode-brightscript-language extension uses.
 *
 * The RTA OnDeviceComponent listens on TCP port 9000 inside the channel and
 * speaks a simple length-prefixed JSON protocol. Each message looks like:
 *
 *   [ int32LE stringLength ][ int32LE binaryLength ][ utf-8 JSON payload ][ optional binary ]
 *
 * Requests are `{ id, type, args, isRecuring }`; responses come framed the same
 * way and we correlate by `id`. See the upstream source at
 * https://github.com/triwav/roku-test-automation/blob/master/client/src/OnDeviceComponent.ts
 *
 * Requirements on the device:
 *   - The channel must include the RTA OnDeviceComponent (either bundled by the
 *     channel, or injected at sideload time by roku-debug via
 *     `"injectRdbOnDeviceComponent": true` in launch.json plus the marker
 *     comment `' vscode_rdb_on_device_component_entry` after `screen.show()`).
 *   - A successful install logs `[RTA][INFO] OnDeviceComponent init` at launch.
 *
 * Node addressing:
 *   - `base: 'elementId'` + `keyPath: <uiElementId>` — most robust, uses the
 *     `uiElementId="RTA_*"` shown by `roku_query_sg_nodes`.
 *   - `base: 'scene'` + `keyPath: 'someId'` — works when the node has a real
 *     `id` field set in the BrightScript code.
 *   - `base: 'focusedNode'` — no keyPath, targets whatever is currently focused.
 *
 * The mutating tools below accept `nodeId` and try elementId first, then fall
 * back to scene-keyPath for convenience.
 */

const RTA_PORT = 9000;
const DEFAULT_TIMEOUT_MS = 5000;

const RTA_SETUP_HINT =
  '\n\nThis tool talks to the roku-test-automation (RTA) On-Device Component on TCP port 9000. ' +
  'If the connection is refused, the channel does not include RTA. To enable it, either bundle the RTA OnDeviceComponent in your channel ' +
  'OR (when sideloading via roku-debug) set `"injectRdbOnDeviceComponent": true` in launch.json and add the marker comment ' +
  '`\' vscode_rdb_on_device_component_entry` immediately after `screen.show()` inside `main()`. ' +
  'A successful install logs `[RTA][INFO] OnDeviceComponent init` at channel launch.';

type Base = 'global' | 'scene' | 'elementId' | 'focusedNode' | 'nodeRef' | 'appUI';
type FieldValue = string | number | boolean | number[];

interface RtaRequest {
  id: string;
  type: string;
  args: Record<string, unknown>;
  isRecuring: boolean;
}

interface PendingRequest {
  resolve: (json: any) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

const HEADER_SIZE = 8;

class RtaClient {
  private socket: net.Socket;
  private connected = false;
  private pending = new Map<string, PendingRequest>();
  private incoming: { stringLength: number; binaryLength: number; stringPayload: string; binaryReceived: number } | null = null;
  private leftover: Buffer = Buffer.alloc(0);

  private constructor(socket: net.Socket) {
    this.socket = socket;
    socket.on('data', (chunk: Buffer | string) => this.onData(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    socket.on('close', () => {
      this.connected = false;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error('RTA socket closed before response was received'));
      }
      this.pending.clear();
    });
    socket.on('error', () => { /* swallow; close handler handles cleanup */ });
  }

  static connect(host: string, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<RtaClient> {
    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`Timed out connecting to RTA on ${host}:${RTA_PORT}`));
      }, timeoutMs);
      socket.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      socket.connect(RTA_PORT, host, async () => {
        clearTimeout(timer);
        const client = new RtaClient(socket);
        client.connected = true;
        try {
          // Handshake: the RTA OnDeviceComponent expects an initial setSettings call.
          await client.send('setSettings', { logLevel: 'info' });
          resolve(client);
        } catch (err) {
          socket.destroy();
          reject(err);
        }
      });
    });
  }

  close(): void {
    try { this.socket.destroy(); } catch { /* ignore */ }
    this.connected = false;
  }

  private onData(chunk: Buffer): void {
    let buf = Buffer.concat([this.leftover, chunk]);
    this.leftover = Buffer.alloc(0);

    while (buf.length > 0) {
      if (!this.incoming) {
        if (buf.length < HEADER_SIZE) {
          this.leftover = buf;
          return;
        }
        this.incoming = {
          stringLength: buf.readInt32LE(0),
          binaryLength: buf.readInt32LE(4),
          stringPayload: '',
          binaryReceived: 0,
        };
        buf = buf.slice(HEADER_SIZE);
      }

      const needString = this.incoming.stringLength - Buffer.byteLength(this.incoming.stringPayload, 'utf-8');
      if (needString > 0) {
        const take = Math.min(needString, buf.length);
        this.incoming.stringPayload += buf.slice(0, take).toString('utf-8');
        buf = buf.slice(take);
        if (Buffer.byteLength(this.incoming.stringPayload, 'utf-8') < this.incoming.stringLength) {
          this.leftover = buf;
          return;
        }
      }

      const needBinary = this.incoming.binaryLength - this.incoming.binaryReceived;
      if (needBinary > 0) {
        const take = Math.min(needBinary, buf.length);
        this.incoming.binaryReceived += take;
        buf = buf.slice(take);
        if (this.incoming.binaryReceived < this.incoming.binaryLength) {
          this.leftover = buf;
          return;
        }
      }

      try {
        const json = JSON.parse(this.incoming.stringPayload);
        const id = json.id as string | undefined;
        if (id && this.pending.has(id)) {
          const p = this.pending.get(id)!;
          this.pending.delete(id);
          clearTimeout(p.timer);
          p.resolve(json);
        }
      } catch {
        // ignore malformed responses
      }
      this.incoming = null;
    }
  }

  send(type: string, args: Record<string, unknown>, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<any> {
    if (!this.connected) return Promise.reject(new Error('RTA client not connected'));
    const id = Math.random().toString(36).slice(2, 14);
    const request: RtaRequest = { id, type, args, isRecuring: false };
    const stringPayload = JSON.stringify(request).replace(/[\x00-\x08\x0E-\x1F\x7F-\uFFFF]/g, '');
    const header = Buffer.alloc(HEADER_SIZE);
    header.writeInt32LE(Buffer.byteLength(stringPayload, 'utf-8'), 0);
    header.writeInt32LE(0, 4);
    const body = Buffer.from(stringPayload, 'utf-8');

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RTA request \`${type}\` timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(Buffer.concat([header, body]), (err) => {
        if (err) {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(err);
        }
      });
    });
  }
}

/**
 * Determine the best `base`/`keyPath` pair for a given user-supplied node
 * identifier. We try elementId first because it always works against the
 * `uiElementId="RTA_*"` ids RTA assigns to every node, then fall back to
 * scene-relative lookup so callers can pass a real BrightScript `id` too.
 */
async function resolveTarget(client: RtaClient, nodeId: string): Promise<{ base: Base; keyPath?: string; sceneKeyPath?: string }> {
  if (/^RTA_\d+$/i.test(nodeId)) {
    return { base: 'elementId', keyPath: nodeId };
  }
  return { base: 'scene', keyPath: nodeId };
}

async function withClient<T>(host: string, fn: (client: RtaClient) => Promise<T>): Promise<T> {
  const client = await RtaClient.connect(host);
  try {
    return await fn(client);
  } finally {
    client.close();
  }
}

function summarizeResponse(json: any): string {
  if (!json) return '(no response)';
  if (json.error) return `RTA error: ${typeof json.error === 'string' ? json.error : JSON.stringify(json.error)}`;
  const { id: _id, timeTaken: _t, ...rest } = json;
  void _id; void _t;
  const trimmed = JSON.stringify(rest);
  return trimmed === '{}' ? 'OK' : trimmed;
}

function isRtaError(json: any): boolean {
  return !!(json && json.error);
}

/**
 * Build the `setValue` args for a node+field pair, matching how the VS Code
 * SceneGraph Inspector formats requests.
 *
 * - When `base` is `elementId`, the `keyPath` must be the bare elementId and
 *   the field name goes in the separate `field` arg. Appending `.field` to
 *   the elementId makes the OnDeviceComponent treat the whole string as a
 *   non-existent elementId, so the write silently no-ops while still
 *   returning a 200-style response. (Verified against firmware behavior.)
 * - When `base` is `scene` (or any other base), the field name is the last
 *   segment of the dotted keyPath, e.g. `MainScene.subtitle.text`.
 */
function buildSetValueArgs(
  target: { base: Base; keyPath?: string },
  field: string,
  value: unknown
): Record<string, unknown> {
  if (target.base === 'elementId') {
    return {
      base: 'elementId',
      keyPath: target.keyPath ?? '',
      field,
      value,
    };
  }
  const keyPath = target.keyPath ? `${target.keyPath}.${field}` : field;
  return {
    base: target.base,
    keyPath,
    field,
    value,
  };
}

export function registerEditUiTools(server: McpServer): void {
  server.registerTool(
    'roku_edit_node',
    {
      description:
        'Edit a SceneGraph node on the running dev channel at runtime by setting one or more fields. ' +
        'Uses the roku-test-automation (RTA) On-Device Component on TCP port 9000 — the same backend the SceneGraph Inspector in the vscode-brightscript-language extension uses. ' +
        'Requires RTA to be present in the running channel (see README "Runtime UI Editing"). ' +
        'nodeId can be either a `uiElementId` like "RTA_1773" (as shown by roku_query_sg_nodes) or a BrightScript scene-level `id`. ' +
        'Common fields: visible (boolean), translation ([x,y]), text (string), color (hex like "0xRRGGBBAA"), opacity (number 0..1).',
      inputSchema: {
        host: z.string().optional().describe('IP address or hostname of the Roku device'),
        nodeId: z.string().describe('uiElementId (e.g. "RTA_1773") or BrightScript scene id of the node to edit'),
        fields: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.number())]))
          .describe('Map of field name -> new value. Each field becomes one setValue request.'),
      },
    },
    async (params) => {
      try {
        const host = await resolveHost(params);
        const entries = Object.entries(params.fields ?? {});
        if (entries.length === 0) {
          return { content: [{ type: 'text', text: 'No fields provided.' }], isError: true };
        }

        const { lines, anyError } = await withClient(host, async (client) => {
          const target = await resolveTarget(client, params.nodeId);
          const out: string[] = [];
          let err = false;
          for (const [field, value] of entries) {
            const args = buildSetValueArgs(target, field, value);
            const json = await client.send('setValue', args);
            if (isRtaError(json)) err = true;
            out.push(`${field} = ${JSON.stringify(value)} -> ${summarizeResponse(json)}`);
          }
          return { lines: out, anyError: err };
        });

        return {
          content: [{ type: 'text', text: `Updated node "${params.nodeId}":\n${lines.join('\n')}` }],
          isError: anyError || undefined,
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Edit node failed: ${friendlyError(error)}${RTA_SETUP_HINT}` }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'roku_set_node_visible',
    {
      description: 'Show or hide a SceneGraph node by id via RTA setValue on the `visible` field.',
      inputSchema: {
        host: z.string().optional().describe('IP address or hostname of the Roku device'),
        nodeId: z.string().describe('uiElementId (e.g. "RTA_1773") or BrightScript scene id of the node'),
        visible: z.boolean().describe('true to show, false to hide'),
      },
    },
    async (params) => {
      try {
        const host = await resolveHost(params);
        const json = await withClient(host, async (client) => {
          const target = await resolveTarget(client, params.nodeId);
          return client.send('setValue', buildSetValueArgs(target, 'visible', params.visible));
        });
        return {
          content: [{ type: 'text', text: `${params.visible ? 'Showed' : 'Hid'} "${params.nodeId}" -> ${summarizeResponse(json)}` }],
          isError: isRtaError(json) || undefined,
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Set visible failed: ${friendlyError(error)}${RTA_SETUP_HINT}` }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'roku_move_node',
    {
      description: 'Move a SceneGraph node to a new position by setting its `translation` field to [x, y].',
      inputSchema: {
        host: z.string().optional().describe('IP address or hostname of the Roku device'),
        nodeId: z.string().describe('uiElementId or scene id of the node to move'),
        x: z.number().describe('Target x coordinate in pixels'),
        y: z.number().describe('Target y coordinate in pixels'),
      },
    },
    async (params) => {
      try {
        const host = await resolveHost(params);
        const json = await withClient(host, async (client) => {
          const target = await resolveTarget(client, params.nodeId);
          return client.send('setValue', buildSetValueArgs(target, 'translation', [params.x, params.y]));
        });
        return {
          content: [{ type: 'text', text: `Moved "${params.nodeId}" to [${params.x}, ${params.y}] -> ${summarizeResponse(json)}` }],
          isError: isRtaError(json) || undefined,
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Move node failed: ${friendlyError(error)}${RTA_SETUP_HINT}` }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'roku_focus_node',
    {
      description: 'Set focus on a SceneGraph node by id via RTA focusNode.',
      inputSchema: {
        host: z.string().optional().describe('IP address or hostname of the Roku device'),
        nodeId: z.string().describe('uiElementId or scene id of the node to focus'),
        on: z.boolean().optional().describe('true to set focus (default), false to remove'),
      },
    },
    async (params) => {
      try {
        const host = await resolveHost(params);
        const json = await withClient(host, async (client) => {
          const target = await resolveTarget(client, params.nodeId);
          return client.send('focusNode', {
            base: target.base,
            keyPath: target.keyPath,
            on: params.on ?? true,
          });
        });
        return {
          content: [{ type: 'text', text: `Focus(${params.on ?? true}) "${params.nodeId}" -> ${summarizeResponse(json)}` }],
          isError: isRtaError(json) || undefined,
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Focus node failed: ${friendlyError(error)}${RTA_SETUP_HINT}` }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'roku_remove_node',
    {
      description: 'Remove a SceneGraph node from its parent at runtime via RTA removeNode.',
      inputSchema: {
        host: z.string().optional().describe('IP address or hostname of the Roku device'),
        nodeId: z.string().describe('uiElementId or scene id of the node to remove'),
      },
    },
    async (params) => {
      try {
        const host = await resolveHost(params);
        const json = await withClient(host, async (client) => {
          const target = await resolveTarget(client, params.nodeId);
          return client.send('removeNode', {
            base: target.base,
            keyPath: target.keyPath,
          });
        });
        return {
          content: [{ type: 'text', text: `Removed "${params.nodeId}" -> ${summarizeResponse(json)}` }],
          isError: isRtaError(json) || undefined,
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Remove node failed: ${friendlyError(error)}${RTA_SETUP_HINT}` }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'roku_create_node',
    {
      description:
        'Create a new SceneGraph node at runtime and append it as a child of an existing node via RTA createChild. ' +
        'Subtype must be a SceneGraph node type registered for the running scene (e.g. Label, Rectangle, Poster, Group).',
      inputSchema: {
        host: z.string().optional().describe('IP address or hostname of the Roku device'),
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
        const host = await resolveHost(params);
        const json = await withClient(host, async (client) => {
          const target = await resolveTarget(client, params.parentId);
          const fields = { ...(params.fields ?? {}) };
          if (params.id) fields.id = params.id;
          return client.send('createChild', {
            base: target.base,
            keyPath: target.keyPath,
            subtype: params.subtype,
            fields,
          });
        });
        return {
          content: [{ type: 'text', text: `Created <${params.subtype}>${params.id ? ` id="${params.id}"` : ''} under "${params.parentId}" -> ${summarizeResponse(json)}` }],
          isError: isRtaError(json) || undefined,
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Create node failed: ${friendlyError(error)}${RTA_SETUP_HINT}` }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'roku_get_value',
    {
      description:
        'Read a field value from a SceneGraph node at runtime via RTA getValue. Returns the value as JSON. ' +
        'Pass either nodeId+field, or a full keyPath like "MainScene.rowList.0.title".',
      inputSchema: {
        host: z.string().optional().describe('IP address or hostname of the Roku device'),
        nodeId: z.string().optional().describe('uiElementId or scene id of the node (combined with `field`)'),
        field: z.string().optional().describe('Field name on the node (used with nodeId)'),
        keyPath: z.string().optional().describe('Full RTA keyPath instead of nodeId+field (e.g. "MainScene.rowList.focusedRow.title.text")'),
        base: z.enum(['global', 'scene', 'elementId', 'focusedNode', 'nodeRef', 'appUI']).optional().describe('RTA base (default inferred from nodeId, or "scene" when using keyPath)'),
      },
    },
    async (params) => {
      try {
        const host = await resolveHost(params);
        if (!params.keyPath && !(params.nodeId && params.field)) {
          return { content: [{ type: 'text', text: 'Provide either `keyPath` or both `nodeId` and `field`.' }], isError: true };
        }
        const json = await withClient(host, async (client) => {
          let args: Record<string, unknown>;
          if (params.keyPath) {
            args = { base: params.base ?? 'scene', keyPath: params.keyPath };
          } else {
            const target = await resolveTarget(client, params.nodeId!);
            const base = (params.base as Base) ?? target.base;
            if (base === 'elementId') {
              args = { base, keyPath: target.keyPath ?? '', field: params.field };
            } else {
              args = {
                base,
                keyPath: target.keyPath ? `${target.keyPath}.${params.field}` : params.field,
                field: params.field,
              };
            }
          }
          return client.send('getValue', args);
        });
        return { content: [{ type: 'text', text: JSON.stringify(json, null, 2) }], isError: isRtaError(json) || undefined };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Get value failed: ${friendlyError(error)}${RTA_SETUP_HINT}` }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'roku_observe_field',
    {
      description:
        'Wait for a SceneGraph field to change (or match a specific value) via RTA onFieldChangeOnce. ' +
        'Returns when the observer fires or the timeout elapses. Great for "wait until video starts playing" style assertions.',
      inputSchema: {
        host: z.string().optional().describe('IP address or hostname of the Roku device'),
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
        const host = await resolveHost(params);
        if (!params.keyPath && !(params.nodeId && params.field)) {
          return { content: [{ type: 'text', text: 'Provide either `keyPath` or both `nodeId` and `field`.' }], isError: true };
        }
        const timeoutMs = params.timeoutMs ?? 10_000;
        const json = await withClient(host, async (client) => {
          let baseArgs: Record<string, unknown>;
          if (params.keyPath) {
            baseArgs = { base: 'scene', keyPath: params.keyPath };
          } else {
            const target = await resolveTarget(client, params.nodeId!);
            if (target.base === 'elementId') {
              baseArgs = { base: 'elementId', keyPath: target.keyPath ?? '', field: params.field };
            } else {
              baseArgs = {
                base: target.base,
                keyPath: target.keyPath ? `${target.keyPath}.${params.field}` : params.field!,
                field: params.field,
              };
            }
          }
          const args: Record<string, unknown> = { ...baseArgs, observerFireTimeout: timeoutMs };
          if (params.match !== undefined) args.match = params.match;
          return client.send('onFieldChangeOnce', args, timeoutMs + 2000);
        });
        return { content: [{ type: 'text', text: JSON.stringify(json, null, 2) }], isError: isRtaError(json) || undefined };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Observe field failed: ${friendlyError(error)}${RTA_SETUP_HINT}` }],
          isError: true,
        };
      }
    }
  );
}
