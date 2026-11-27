import type { Duplex } from 'stream';
import { resolveTarget as resolveDevice, type RokuTarget, type TargetParams } from '../roku-config.js';
import { RokuError } from './errors.js';

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

export type Base = 'global' | 'scene' | 'elementId' | 'focusedNode' | 'nodeRef' | 'appUI';
export type FieldValue = string | number | boolean | number[];

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
const MAX_FRAME_BYTES = 16 * 1024 * 1024;

class RtaClient {
  private socket: Duplex;
  private connected = false;
  private pending = new Map<string, PendingRequest>();
  private incoming: { stringLength: number; binaryLength: number; stringPayload: string; binaryReceived: number } | null = null;
  private leftover: Buffer = Buffer.alloc(0);

  private constructor(socket: Duplex) {
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

  static async connect(target: RokuTarget, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<RtaClient> {
    const socket = await target.connect(RTA_PORT, timeoutMs);
    const client = new RtaClient(socket);
    client.connected = true;
    try {
      // Handshake: the RTA OnDeviceComponent expects an initial setSettings call.
      await client.send('setSettings', { logLevel: 'info' });
      return client;
    } catch (err) {
      socket.destroy();
      throw err;
    }
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
        const stringLength = buf.readInt32LE(0);
        const binaryLength = buf.readInt32LE(4);
        // A real reply is small; a bogus header must not make us buffer without bound.
        if (stringLength < 0 || binaryLength < 0 || stringLength + binaryLength > MAX_FRAME_BYTES) {
          this.socket.destroy();
          return;
        }
        this.incoming = {
          stringLength,
          binaryLength,
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
async function resolveNode(client: RtaClient, nodeId: string): Promise<{ base: Base; keyPath?: string; sceneKeyPath?: string }> {
  if (/^RTA_\d+$/i.test(nodeId)) {
    return { base: 'elementId', keyPath: nodeId };
  }
  return { base: 'scene', keyPath: nodeId };
}

async function withClient<T>(target: RokuTarget, fn: (client: RtaClient) => Promise<T>): Promise<T> {
  const client = await RtaClient.connect(target);
  try {
    return await fn(client);
  } finally {
    client.close();
  }
}

export function isRtaError(json: any): boolean {
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

/** An RTA response: the request id, `error` when it failed, and the request's result fields. */
export type RtaResponse = Record<string, any>;

const NEED_KEYPATH = 'Provide either `keyPath` or both `nodeId` and `field`.';

/** Resolves the device, connects to RTA, runs fn and closes the connection. */
async function rta<T>(options: TargetParams, fn: (client: RtaClient) => Promise<T>): Promise<T> {
  return withClient(await resolveDevice(options), fn);
}

/** keyPath args for getValue and onFieldChangeOnce from nodeId + field (elementId keeps field separate). */
function fieldArgs(node: { base: Base; keyPath?: string }, field: string, base: Base = node.base): Record<string, unknown> {
  if (base === 'elementId') return { base, keyPath: node.keyPath ?? '', field };
  return { base, keyPath: node.keyPath ? `${node.keyPath}.${field}` : field, field };
}

export interface NodeRef extends TargetParams {
  /** uiElementId (RTA_<digits>) or a BrightScript scene id. */
  nodeId: string;
}

/** One setValue per field, in order; each entry carries the RTA response. */
export async function editNode(options: NodeRef & { fields: Record<string, FieldValue> }): Promise<Array<{ field: string; value: FieldValue; response: RtaResponse }>> {
  const device = await resolveDevice(options);
  const entries = Object.entries(options.fields ?? {});
  if (entries.length === 0) throw new RokuError('bad_args', 'No fields provided.', { bare: true });
  return withClient(device, async (client) => {
    const node = await resolveNode(client, options.nodeId);
    const out: Array<{ field: string; value: FieldValue; response: RtaResponse }> = [];
    for (const [field, value] of entries) out.push({ field, value, response: await client.send('setValue', buildSetValueArgs(node, field, value)) });
    return out;
  });
}

export function setNodeVisible(options: NodeRef & { visible: boolean }): Promise<RtaResponse> {
  return rta(options, async (client) => client.send('setValue', buildSetValueArgs(await resolveNode(client, options.nodeId), 'visible', options.visible)));
}

export function moveNode(options: NodeRef & { x: number; y: number }): Promise<RtaResponse> {
  return rta(options, async (client) => client.send('setValue', buildSetValueArgs(await resolveNode(client, options.nodeId), 'translation', [options.x, options.y])));
}

export function focusNode(options: NodeRef & { on?: boolean }): Promise<RtaResponse> {
  return rta(options, async (client) => {
    const node = await resolveNode(client, options.nodeId);
    return client.send('focusNode', { base: node.base, keyPath: node.keyPath, on: options.on ?? true });
  });
}

export function removeNode(options: NodeRef): Promise<RtaResponse> {
  return rta(options, async (client) => {
    const node = await resolveNode(client, options.nodeId);
    return client.send('removeNode', { base: node.base, keyPath: node.keyPath });
  });
}

export interface CreateNodeOptions extends TargetParams {
  parentId: string;
  subtype: string;
  id?: string;
  fields?: Record<string, FieldValue>;
}

/** Appends a new child of `subtype` under parentId (createChild). */
export function createNode(options: CreateNodeOptions): Promise<RtaResponse> {
  return rta(options, async (client) => {
    const node = await resolveNode(client, options.parentId);
    const fields: Record<string, FieldValue> = { ...(options.fields ?? {}) };
    if (options.id) fields.id = options.id;
    return client.send('createChild', { base: node.base, keyPath: node.keyPath, subtype: options.subtype, fields });
  });
}

export interface FieldRef extends TargetParams {
  nodeId?: string;
  field?: string;
  /** A full RTA keyPath instead of nodeId + field. */
  keyPath?: string;
}

/** getValue; base defaults to the one inferred from nodeId, or "scene" with keyPath. */
export async function getValue(options: FieldRef & { base?: Base }): Promise<RtaResponse> {
  const device = await resolveDevice(options);
  if (!options.keyPath && !(options.nodeId && options.field)) throw new RokuError('bad_args', NEED_KEYPATH, { bare: true });
  return withClient(device, async (client) => {
    const args = options.keyPath
      ? { base: options.base ?? 'scene', keyPath: options.keyPath }
      : fieldArgs(await resolveNode(client, options.nodeId!), options.field!, options.base);
    return client.send('getValue', args);
  });
}

/** onFieldChangeOnce: resolves when the field changes (or equals match), or with the RTA timeout response. */
export async function observeField(options: FieldRef & { match?: string | number | boolean; timeoutMs?: number }): Promise<RtaResponse> {
  const device = await resolveDevice(options);
  if (!options.keyPath && !(options.nodeId && options.field)) throw new RokuError('bad_args', NEED_KEYPATH, { bare: true });
  const timeoutMs = options.timeoutMs ?? 10_000;
  return withClient(device, async (client) => {
    const baseArgs = options.keyPath ? { base: 'scene', keyPath: options.keyPath } : fieldArgs(await resolveNode(client, options.nodeId!), options.field!);
    const args: Record<string, unknown> = { ...baseArgs, observerFireTimeout: timeoutMs };
    if (options.match !== undefined) args.match = options.match;
    return client.send('onFieldChangeOnce', args, timeoutMs + 2000);
  });
}
