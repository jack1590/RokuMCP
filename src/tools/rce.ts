import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { runCost, type RceDevice } from 'roku-rce';
import { DESTRUCTIVE, READ_ONLY, friendlyError } from '../roku-config.js';
import { RCE_BILLING, rceCore } from '../rce.js';

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

const deviceParam = z
  .string()
  .optional()
  .describe('Cloud Device id or exact name. Defaults to ROKU_RCE_DEVICE.');

const ok = (value: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });
const fail = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });

function deviceRef(param?: string): string {
  const ref = param || process.env.ROKU_RCE_DEVICE;
  if (!ref) throw new Error('No Cloud Device given. Pass rceDevice (an id or exact name from roku_rce_list_devices) or set ROKU_RCE_DEVICE.');
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

export function registerRceTools(server: McpServer): void {
  server.registerTool(
    'roku_rce_list_devices',
    {
      title: 'List RCE Cloud Devices',
      annotations: READ_ONLY,
      description:
        'List the Roku Cloud Emulator (RCE) Cloud Devices of the account behind ROKU_RCE_TOKEN, with their status and any current Run (its cost so far and auto-stop time). ' +
        'Listing is free. ' + RCE_BILLING,
    },
    async (): Promise<ToolResult> => {
      try {
        return ok((await rceCore().listDevices()).map(deviceSummary));
      } catch (error) {
        return fail(`List Cloud Devices failed: ${friendlyError(error)}`);
      }
    }
  );

  server.registerTool(
    'roku_rce_start',
    {
      title: 'Start RCE Run (billed)',
      annotations: DESTRUCTIVE, // spends money
      description:
        'Start a Run on a Roku Cloud Emulator Cloud Device and wait until it takes input (about 35-50 seconds). THIS COSTS MONEY. ' +
        'The call can block for up to about 5 minutes (up to 60 s for RCE to show the Run, then up to 240 s for it to take input), so the client tool timeout must be longer than that. ' +
        RCE_BILLING + ' ' +
        'Refuses a Cloud Device that already has a Run. After it returns, pass rceDevice (or set ROKU_RCE_DEVICE) to the usual roku_* tools.',
      inputSchema: {
        rceDevice: deviceParam,
        snapshotId: z.number().int().optional().describe("Snapshot to boot (see roku_rce_status). Defaults to the device's live Snapshot."),
        maxRuntimeMinutes: z
          .number()
          .int()
          .positive()
          .max(240)
          .optional()
          .default(60)
          .describe('RCE ends the Run on its own after this many minutes (default 60, at most 240). This cap is the only automatic stop.'),
      },
    },
    async (params): Promise<ToolResult> => {
      try {
        const core = rceCore();
        const device = await core.findDevice(deviceRef(params.rceDevice));
        if (device.status !== 'shutdown') {
          return fail(
            `Cloud Device ${device.id} (${device.name}) already has a Run (status ${device.status}). Nothing was started. ` +
              'Inspect it with roku_rce_status, or end it with roku_rce_stop.'
          );
        }
        const minutes = params.maxRuntimeMinutes ?? 60;
        await core.start(device.id, { snapshotId: params.snapshotId, maxRuntime: minutes * 60 });
        try {
          const ready = await core.waitUntilReady(device.id, { timeoutMs: 240_000 });
          return ok({ started: true, device: deviceSummary(ready), billing: RCE_BILLING });
        } catch (error) {
          return fail(
            `The Run on Cloud Device ${device.id} was started and is billing, but it did not become ready: ${friendlyError(error)}. ` +
              'Check it with roku_rce_status, and end it with roku_rce_stop if you do not need it.'
          );
        }
      } catch (error) {
        return fail(`Start Run failed: ${friendlyError(error)}`);
      }
    }
  );

  server.registerTool(
    'roku_rce_stop',
    {
      title: 'Stop RCE Run',
      annotations: DESTRUCTIVE, // can end another person's session
      description:
        "Stop the current Run of a Roku Cloud Emulator Cloud Device and wait until it reports shutdown. This ends billing for that Run. " +
        'It stops the Run even when another person or client started it, which ends their session (the result says whether this server started it). ' +
        'Only the Run current when this tool reads the device is stopped; a Run started in between is left alone. ' +
        RCE_BILLING,
      inputSchema: { rceDevice: deviceParam },
    },
    async (params): Promise<ToolResult> => {
      try {
        const core = rceCore();
        const device = await core.findDevice(deviceRef(params.rceDevice));
        const run = runSummary(device);
        if (!run) return ok({ stopped: false, message: `Cloud Device ${device.id} (${device.name}) has no Run.`, device: deviceSummary(device) });
        await core.stop(device.id, { runId: run.runId });
        const after = await core.waitUntilShutdown(device.id, { timeoutMs: 240_000 });
        return ok({ stopped: true, runId: run.runId, startedByThisServer: run.startedByThisServer, billedMinutesAtStop: run.billedMinutes, costUsdAtStop: run.costUsd, device: deviceSummary(after) });
      } catch (error) {
        return fail(`Stop Run failed: ${friendlyError(error)}. Check the device with roku_rce_status: a Run that is still up keeps billing.`);
      }
    }
  );

  server.registerTool(
    'roku_rce_status',
    {
      title: 'RCE Cloud Device status',
      annotations: READ_ONLY,
      description:
        'Show a Roku Cloud Emulator Cloud Device: Run state, cost so far, auto-stop time, whether this server started the Run, and its Snapshots. Free to call. ' +
        RCE_BILLING,
      inputSchema: { rceDevice: deviceParam },
    },
    async (params): Promise<ToolResult> => {
      try {
        const core = rceCore();
        const device = await core.findDevice(deviceRef(params.rceDevice));
        const snapshots = (await core.listSnapshots(device.id)).map((s) => ({ id: s.id, name: s.name, createdAt: s.created_at, ready: s.ready, live: s.live, base: s.base }));
        return ok({ ...deviceSummary(device), snapshots });
      } catch (error) {
        return fail(`Cloud Device status failed: ${friendlyError(error)}`);
      }
    }
  );
}
