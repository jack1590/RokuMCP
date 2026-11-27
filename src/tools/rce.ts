import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { DESTRUCTIVE, READ_ONLY } from '../roku-config.js';
import { RCE_BILLING } from '../rce.js';
import * as sdk from '../sdk/index.js';
import { errorText, fail, failure, ok, type ToolResult } from './result.js';

const deviceParam = z
  .string()
  .optional()
  .describe('Cloud Device id or exact name. Defaults to ROKU_RCE_DEVICE.');

const json = (value: unknown): ToolResult => ok(JSON.stringify(value, null, 2));

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
        return json(await sdk.listCloudDevices());
      } catch (error) {
        return fail('List Cloud Devices failed', error);
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
        return json(await sdk.cloudStart(params));
      } catch (error) {
        return fail('Start Run failed', error);
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
        return json(await sdk.cloudStop(params));
      } catch (error) {
        return failure(`${errorText('Stop Run failed', error)}. Check the device with roku_rce_status: a Run that is still up keeps billing.`);
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
        return json(await sdk.cloudStatus(params));
      } catch (error) {
        return fail('Cloud Device status failed', error);
      }
    }
  );
}
