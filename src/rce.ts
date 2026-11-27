import { RceClient } from 'roku-rce';
import { envPassword } from './roku-config.js';
import { RokuError } from './sdk/errors.js';

/** The Core/Instance API surface roku-mcp uses; RceClient satisfies it, tests pass a stub. */
export type RceClientLike = Pick<
  RceClient,
  'listDevices' | 'findDevice' | 'listSnapshots' | 'start' | 'stop' | 'waitUntilReady' | 'waitUntilShutdown' | 'startedHere' | 'stopStartedRuns' | 'instance'
>;

export const RCE_BILLING =
  'Billing: a Roku Cloud Emulator Run costs $0.20 per hour, billed per minute from the start request. ' +
  'RCE never stops an idle Run (only the max runtime cap ends it), so always call roku_rce_stop when you are done.';

const TOKEN_HINT = 'Roku Cloud Emulator needs ROKU_RCE_TOKEN (an RCE personal access token) in the environment or the .env file.';

type Factory = (devPassword: string | undefined) => RceClientLike;
let factory: Factory = (devPassword) => {
  const token = process.env.ROKU_RCE_TOKEN;
  if (!token) throw new RokuError('no_token', TOKEN_HINT);
  return new RceClient({ token, devPassword });
};
const clients = new Map<string, RceClientLike>();

/** Tests only: replace how clients are built (no network). */
export function setRceClientFactory(f: Factory): void {
  factory = f;
  clients.clear();
}

/** The default password for Cloud Devices: ROKU_RCE_PASSWORD, then the LAN device password env. */
export function rcePassword(param?: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return param || env.ROKU_RCE_PASSWORD || envPassword(env);
}

/**
 * The client that starts and tracks Runs is the one built with the default password; a `password`
 * tool parameter gets its own client (same token) so installer calls use it.
 */
export function rceClient(passwordParam?: string): RceClientLike {
  const key = rcePassword(passwordParam) ?? '';
  let c = clients.get(key);
  if (!c) {
    c = factory(key || undefined);
    clients.set(key, c);
  }
  return c;
}

/** The client that owns started Runs (used by start/stop/status and shutdown cleanup). */
export const rceCore = () => rceClient();

/** Best-effort stop of every Run this server started. Safe to call when RCE was never used. */
export async function stopStartedRuns(timeoutMs = 3500) {
  const core = clients.get(rcePassword() ?? '');
  return core ? core.stopStartedRuns({ timeoutMs }) : { stopped: [], ended: [], failed: [] };
}
