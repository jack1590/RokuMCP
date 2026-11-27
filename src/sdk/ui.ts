import { ECP_TREE_TIMEOUT_MS, isNotFound, resolveTarget, type RokuTarget, type TargetParams } from '../roku-config.js';
import { RokuError } from './errors.js';
import { xmlParser } from './device.js';

export const NO_DEV_CHANNEL = 'No dev channel is running (the device answered 404 to query/app-ui). Deploy one with roku_deploy first.';

export type NodeAttributes = Record<string, unknown>;

/** Runs fn and reports any 404 (from resolving the device too, as before) as no dev channel. */
async function onDevChannel<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (isNotFound(error)) throw new RokuError('no_dev_channel', NO_DEV_CHANNEL);
    throw error;
  }
}

const appUiXml = (target: RokuTarget) => target.ecp('query/app-ui', { timeoutMs: ECP_TREE_TIMEOUT_MS });

/** The node's XML attributes without the parser's "@_" prefix. */
function attributes(n: Record<string, unknown>): NodeAttributes {
  const attrs: NodeAttributes = {};
  for (const [k, v] of Object.entries(n)) if (k.startsWith('@_')) attrs[k.slice(2)] = v;
  return attrs;
}

/** The app UI tree as XML (needs a running dev channel). */
export function appUi(target: TargetParams = {}): Promise<string> {
  return onDevChannel(async () => appUiXml(await resolveTarget(target)));
}

/** query/sgnodes: "all", "roots", or "node" with nodeId. Returns XML. */
export async function sgNodes(options: TargetParams & { type: 'all' | 'roots' | 'node'; nodeId?: string }): Promise<string> {
  const target = await resolveTarget(options);
  let path: string;
  if (options.type === 'node') {
    if (!options.nodeId) throw new RokuError('bad_args', 'nodeId is required when type is "node"', { bare: true });
    path = `query/sgnodes/nodes/${encodeURIComponent(options.nodeId)}`;
  } else {
    path = `query/sgnodes/${options.type}`;
  }
  return target.ecp(path, { timeoutMs: ECP_TREE_TIMEOUT_MS });
}

export interface FindNodeOptions extends TargetParams {
  /** Matches the id or name attribute. */
  nodeId?: string;
  attr?: string;
  value?: string;
}

/** Every node in the app UI tree that matches, as attribute maps, in document order. */
export async function findNode(options: FindNodeOptions): Promise<NodeAttributes[]> {
  if (!options.nodeId && (!options.attr || !options.value)) {
    throw new RokuError('bad_args', 'Provide either nodeId, or both attr and value to search for a node.', { bare: true });
  }
  const parsed = await onDevChannel(async () => xmlParser.parse(await appUiXml(await resolveTarget(options))));
  const results: NodeAttributes[] = [];

  const search = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const n = node as Record<string, unknown>;
    let match = false;
    if (options.nodeId) {
      match = n['@_id'] === options.nodeId || n['@_name'] === options.nodeId;
    } else if (options.attr && options.value) {
      const attrKey = options.attr.startsWith('@_') ? options.attr : `@_${options.attr}`;
      match = String(n[attrKey] ?? '') === options.value;
    }
    if (match) results.push(attributes(n));
    for (const v of Object.values(n)) {
      if (Array.isArray(v)) v.forEach(search);
      else if (typeof v === 'object' && v !== null) search(v);
    }
  };

  search(parsed);
  return results;
}

/** The first node with focused="true" in the app UI tree, or null. */
export async function focusedNode(target: TargetParams = {}): Promise<NodeAttributes | null> {
  const parsed = await onDevChannel(async () => xmlParser.parse(await appUiXml(await resolveTarget(target))));
  let focused: NodeAttributes | null = null;

  const find = (node: unknown): void => {
    if (focused || !node || typeof node !== 'object') return;
    const n = node as Record<string, unknown>;
    if (n['@_focused'] === 'true' || n['@_focused'] === true) {
      focused = attributes(n);
      return;
    }
    for (const v of Object.values(n)) {
      if (focused) return;
      if (Array.isArray(v)) v.forEach(find);
      else if (typeof v === 'object' && v !== null) find(v);
    }
  };

  find(parsed);
  return focused;
}
