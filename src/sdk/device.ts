import { XMLParser } from 'fast-xml-parser';
import { discoverRokuDevices, type DiscoveredDevice } from '../discovery.js';
import { resolveTarget, type TargetParams } from '../roku-config.js';

export const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** SSDP scan of the LAN (Cloud Devices are not found this way). */
export function discover(options: { timeoutMs?: number } = {}): Promise<DiscoveredDevice[]> {
  return discoverRokuDevices(options.timeoutMs ?? 3000);
}

/** query/device-info, parsed from XML. */
export async function deviceInfo(target: TargetParams = {}): Promise<Record<string, unknown>> {
  return xmlParser.parse(await (await resolveTarget(target)).ecp('query/device-info'));
}

/** query/active-app, parsed from XML. */
export async function activeApp(target: TargetParams = {}): Promise<Record<string, unknown>> {
  return xmlParser.parse(await (await resolveTarget(target)).ecp('query/active-app'));
}

/** query/media-player, parsed from XML: state, position, duration, error. */
export async function mediaPlayer(target: TargetParams = {}): Promise<Record<string, unknown>> {
  return xmlParser.parse(await (await resolveTarget(target)).ecp('query/media-player'));
}

export interface LaunchOptions extends TargetParams {
  appId: string;
  params?: Record<string, string>;
  /** Exit the app first (exit-app, falling back to Home) and wait about 1.5 s. */
  restart?: boolean;
}

/** Launches or deep-links a channel; resolves with the device label. */
export async function launch(options: LaunchOptions): Promise<{ appId: string; label: string }> {
  const target = await resolveTarget(options);
  if (options.restart) {
    await target.ecp(`exit-app/${encodeURIComponent(options.appId)}`, { method: 'POST' }).catch(() => target.keypress('Home'));
    await wait(1500);
  }
  const query = options.params ? '?' + new URLSearchParams(options.params).toString() : '';
  await target.ecp(`launch/${encodeURIComponent(options.appId)}${query}`, { method: 'POST' });
  return { appId: options.appId, label: target.label };
}

/** Waits durationMs clamped to 0..30000 and resolves with the time actually waited. */
export async function sleep(options: { durationMs: number }): Promise<number> {
  const ms = Math.min(Math.max(options.durationMs, 0), 30_000);
  await wait(ms);
  return ms;
}
