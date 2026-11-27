import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { READ_ONLY, WRITES, targetParams } from '../roku-config.js';
import * as sdk from '../sdk/index.js';
import { fail, ok, type ToolResult } from './result.js';

export function registerConsoleCaptureTools(server: McpServer): void {
  server.registerTool(
    'roku_console_capture_start',
    {
      title: 'Start console capture',
      annotations: WRITES,
      description:
        'Start recording the BrightScript debug console (port 8085) to a file, keeping the connection open until roku_console_capture_stop. ' +
        'Output from before the capture (the console replays the previous session on connect) is skipped. Console text is never returned; use roku_console_wait to detect lines. ' +
        'Port 8085 accepts a single client: detach the VS Code BrightScript debugger first. On a Roku Cloud Emulator device the console is reached through an RCE WebSocket bridge.',
      inputSchema: {
        ...targetParams,
        file: z.string().optional().describe('Absolute or cwd-relative log path. Defaults to ./logs/<YYYY-MM-DDTHH∶MM∶SS>-rokuDevice.log'),
        append: z.boolean().optional().default(false).describe('Append to the file instead of truncating it'),
        settleMs: z.number().optional().default(2000).describe('Discard console output received during this window after connecting (replay of the previous session)'),
      },
    },
    async (params): Promise<ToolResult> => {
      try {
        const r = await sdk.captureStart(params);
        const note = r.replayReceived
          ? ''
          : ' No console output received yet; if nothing arrives after launching, port 8085 may be held by another client (e.g. the VS Code BrightScript debugger).';
        return ok(`Capturing ${r.label}:${r.port} to ${r.file}.${note}`);
      } catch (error) {
        return fail('Console capture failed', error);
      }
    }
  );

  server.registerTool(
    'roku_console_wait',
    {
      title: 'Wait for console line',
      annotations: READ_ONLY,
      description:
        'Wait until a console line matching a regex appears in the active capture (see roku_console_capture_start). ' +
        'Returns line number, timestamp and a short redacted preview; the full line is in the capture file. ' +
        'Resolves early with reason "waiting_for_debugger" if the channel is blocked waiting for the VS Code debugger (redeploy it with roku_deploy).',
      inputSchema: {
        pattern: z.string().describe('JavaScript regular expression tested against each console line'),
        timeoutMs: z.number().optional().default(120_000).describe('Maximum time to wait (default 120000)'),
        predicate: z.enum(['jwtValid']).optional().describe('jwtValid: only accept lines whose "Authorization: Bearer <jwt>" has a future exp'),
        sinceCaptureStart: z.boolean().optional().default(true).describe('Also match lines already captured; false = only lines arriving after this call'),
      },
    },
    async (params): Promise<ToolResult> => {
      try {
        return ok(JSON.stringify(await sdk.consoleWait(params)));
      } catch (error) {
        return fail('Console wait failed', error);
      }
    }
  );

  server.registerTool(
    'roku_console_capture_stop',
    {
      title: 'Stop console capture',
      annotations: WRITES,
      description: 'Stop the active console capture, flush and close the file. Returns file path, bytes and line count.',
    },
    async (): Promise<ToolResult> => {
      const result = await sdk.captureStop();
      return ok(result ? JSON.stringify(result) : 'No active capture.');
    }
  );

  server.registerTool(
    'roku_console_capture_status',
    {
      title: 'Console capture status',
      annotations: READ_ONLY,
      description: 'Report whether a console capture is active, its file, bytes and line count.',
    },
    async (): Promise<ToolResult> => ok(JSON.stringify(sdk.captureStatus()))
  );
}
