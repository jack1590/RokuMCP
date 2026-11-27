import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { READ_ONLY, WRITES, targetParams } from '../roku-config.js';
import * as sdk from '../sdk/index.js';
import { fail, ok } from './result.js';

export function registerConsoleTools(server: McpServer): void {
  server.registerTool(
    'roku_console_connect',
    {
      title: 'Connect debug console',
      annotations: WRITES,
      description: 'Open a connection to the BrightScript debug console on port 8085 (a WebSocket bridge on a Roku Cloud Emulator device) for ONE follow-up call: the next roku_console_read or roku_console_send closes it. To stream the console or wait for a log line, use roku_console_capture_start and roku_console_wait instead.',
      inputSchema: {
        ...targetParams,
        port: z.number().optional().default(8085).describe('Debug console port (default 8085)'),
      },
    },
    async (params) => {
      try {
        const result = await sdk.consoleConnect(params);
        if ('alreadyConnected' in result) return ok(`Already connected to ${result.label}. Disconnect first to connect to a different device.`);
        return ok(`Connected to BrightScript debug console at ${result.label}:${result.port}. The next roku_console_read or roku_console_send closes this connection.`);
      } catch (error) {
        return fail('Console connect failed', error);
      }
    }
  );

  server.registerTool(
    'roku_console_read',
    {
      title: 'Read debug console',
      annotations: READ_ONLY,
      description: 'Read the output buffered since roku_console_connect, then close the connection (single-shot: call roku_console_connect again before the next read). For streaming, use roku_console_capture_start and roku_console_wait.',
    },
    async () => {
      try {
        const { output, label } = await sdk.consoleRead();
        return ok(output.length === 0 ? `(no new output) — disconnected from ${label}` : output + `\n\n--- disconnected from ${label} ---`);
      } catch (error) {
        return fail('Console read failed', error);
      }
    }
  );

  server.registerTool(
    'roku_console_send',
    {
      title: 'Send console command',
      annotations: WRITES,
      description: 'Send one command to the BrightScript debug console opened by roku_console_connect, return the output received within 500 ms, then close the connection (single-shot). Common commands: bt (backtrace), var (variables), cont (continue), step, over, out, exit, print <expr>.',
      inputSchema: {
        command: z.string().describe('Command to send to the debug console'),
      },
    },
    async (params) => {
      try {
        const { output, label } = await sdk.consoleSend(params);
        return ok((output || '(command sent, no output received)') + `\n\n--- disconnected from ${label} ---`);
      } catch (error) {
        return fail('Console send failed', error);
      }
    }
  );

  server.registerTool(
    'roku_console_disconnect',
    {
      title: 'Disconnect debug console',
      annotations: WRITES,
      description: 'Close the active BrightScript debug console connection.',
    },
    async () => {
      const result = sdk.consoleDisconnect();
      return ok(result ? `Disconnected from ${result.label}` : 'No active console connection to disconnect.');
    }
  );
}
