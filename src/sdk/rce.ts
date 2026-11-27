import { runCost, type RceDevice } from 'roku-rce';
import { friendlyError } from '../roku-config.js';
import { RCE_BILLING, rceCore } from '../rce.js';
import { RokuError } from './errors.js';

function deviceRef(param?: string): string {
  const ref = param || process.env.ROKU_RCE_DEVICE;
  if (!ref) throw new RokuError('no_cloud_device', 'No Cloud Device given. Pass rceDevice (an id or exact name from roku_rce_list_devices) or set ROKU_RCE_DEVICE.');
  return ref;
}

function runSummary(device: RceDevice) {
  const run = device.running_device;
  if (!run || device.status === 'shutdown') return null;
  return {
    runId: run.id,
    status: device.status,
    snapshotId: run.snapshot_id,
    snapshotName: run.snapshot_name ?? null,
    createdAt: run.created_at,
    startedByThisServer: rceCore().startedHere(device),
    ...runCost(run),
  };
}

function deviceSummary(device: RceDevice) {
  return {
    id: device.id,
    name: device.name,
    deviceType: device.device_type,
    status: device.status,
    firmware: device.firmware_version_display_name ?? device.firmware_version_id ?? null,
    lastSnapshot: device.last_snapshot_id ? { id: device.last_snapshot_id, name: device.last_snapshot_name ?? null } : null,
    run: runSummary(device),
  };
}

export type CloudDeviceSummary = ReturnType<typeof deviceSummary>;

/** Every Cloud Device of the account behind ROKU_RCE_TOKEN, with any current Run and its cost so far. Free. */
export async function listCloudDevices(): Promise<CloudDeviceSummary[]> {
  return (await rceCore().listDevices()).map(deviceSummary);
}

/** One Cloud Device: Run state, cost so far, auto-stop time and Snapshots. Free. */
export async function cloudStatus(options: { rceDevice?: string } = {}) {
  const core = rceCore();
  const device = await core.findDevice(deviceRef(options.rceDevice));
  const snapshots = (await core.listSnapshots(device.id)).map((s) => ({ id: s.id, name: s.name, createdAt: s.created_at, ready: s.ready, live: s.live, base: s.base }));
  return { ...deviceSummary(device), snapshots };
}

export interface CloudStartOptions {
  rceDevice?: string;
  snapshotId?: number;
  /** RCE ends the Run on its own after this many minutes (default 60); the only automatic stop. */
  maxRuntimeMinutes?: number;
}

/** Starts a billed Run and waits until it takes input. Refuses a device that already has a Run. */
export async function cloudStart(options: CloudStartOptions = {}) {
  const core = rceCore();
  const device = await core.findDevice(deviceRef(options.rceDevice));
  if (device.status !== 'shutdown') {
    throw new RokuError(
      'run_exists',
      `Cloud Device ${device.id} (${device.name}) already has a Run (status ${device.status}). Nothing was started. ` +
        'Inspect it with roku_rce_status, or end it with roku_rce_stop.',
      { bare: true }
    );
  }
  const minutes = options.maxRuntimeMinutes ?? 60;
  try {
    await core.start(device.id, { snapshotId: options.snapshotId, maxRuntime: minutes * 60 });
  } catch (error) {
    // The request went out: RCE may have created a Run even though the call failed.
    if (error && typeof error === 'object') Object.assign(error, { startRequested: true });
    throw error;
  }
  try {
    const ready = await core.waitUntilReady(device.id, { timeoutMs: 240_000 });
    return { started: true, device: deviceSummary(ready), billing: RCE_BILLING };
  } catch (error) {
    throw new RokuError(
      'not_ready',
      `The Run on Cloud Device ${device.id} was started and is billing, but it did not become ready: ${friendlyError(error)}. ` +
        'Check it with roku_rce_status, and end it with roku_rce_stop if you do not need it.',
      { bare: true }
    );
  }
}

/**
 * Cleanup after a killed roku_run script: requests a stop (no wait for shutdown) of the Run that
 * script's start created, and nothing else. With the start's runId, only that Run while it is
 * still current; without it (the start failed after the request), only a Run this server started
 * whose creation is no older than the request.
 */
export async function stopScriptRun(rceDevice: string | undefined, known: { runId?: number; requestedAt: number }): Promise<{ deviceId: number; stopped: boolean; runId?: number }> {
  const core = rceCore();
  const device = await core.findDevice(deviceRef(rceDevice));
  const run = device.running_device;
  if (!run || !core.startedHere(device)) return { deviceId: device.id, stopped: false };
  const ours = known.runId !== undefined ? run.id === known.runId : Date.parse(run.created_at) >= known.requestedAt - 30_000;
  if (!ours) return { deviceId: device.id, stopped: false };
  await core.stop(device.id, { runId: run.id }); // refuses if that Run is no longer current
  return { deviceId: device.id, stopped: true, runId: run.id };
}

/** Stops the device's current Run (even one another client started) and waits for shutdown. */
export async function cloudStop(options: { rceDevice?: string } = {}) {
  const core = rceCore();
  const device = await core.findDevice(deviceRef(options.rceDevice));
  const run = runSummary(device);
  if (!run) return { stopped: false, message: `Cloud Device ${device.id} (${device.name}) has no Run.`, device: deviceSummary(device) };
  await core.stop(device.id, { runId: run.runId });
  const after = await core.waitUntilShutdown(device.id, { timeoutMs: 240_000 });
  return { stopped: true, runId: run.runId, startedByThisServer: run.startedByThisServer, billedMinutesAtStop: run.billedMinutes, costUsdAtStop: run.costUsd, device: deviceSummary(after) };
}
