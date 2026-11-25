import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Duplex } from 'stream';
import { READ_ONLY, WRITES, friendlyError, resolveTarget, targetParams } from '../roku-config.js';
import { isCaptureActive } from './console-capture.js';

interface ConsoleSession {
  socket: Duplex;
  buffer: string;
  host: string;
  connected: boolean;
}

let session: ConsoleSession | null = null;

const CAPTURE_ACTIVE =
  'A console capture is active and holds port 8085 (single client). Use roku_console_wait, or read the capture file; stop it with roku_console_capture_stop to use the single-shot console tools again.';

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
        if (isCaptureActive()) {
          return {
            content: [{ type: 'text', text: CAPTURE_ACTIVE }],
            isError: true,
          };
        }
        if (session?.connected) {
          return {
            content: [{ type: 'text', text: `Already connected to ${session.host}. Disconnect first to connect to a different device.` }],
          };
        }

        const target = await resolveTarget(params);
        const port = params.port ?? 8085;
        const socket = await target.connect(port, 10_000);
        const newSession: ConsoleSession = { socket, buffer: '', host: target.label, connected: true };
        session = newSession;
        socket.on('data', (data) => {
          if (session === newSession) session.buffer += data.toString();
        });
        socket.on('close', () => {
          if (session === newSession) session.connected = false;
        });
        socket.on('error', () => {
          if (session === newSession) session.connected = false;
        });
        return {
          content: [{ type: 'text', text: `Connected to BrightScript debug console at ${target.label}:${port}. The next roku_console_read or roku_console_send closes this connection.` }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Console connect failed: ${friendlyError(error)}` }],
          isError: true,
        };
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
      if (!session?.connected) {
        return {
          content: [{ type: 'text', text: isCaptureActive() ? CAPTURE_ACTIVE : 'No active console connection. Use roku_console_connect first.' }],
          isError: true,
        };
      }

      await new Promise((r) => setTimeout(r, 200));

      const output = session.buffer;
      session.buffer = '';
      const host = session.host;
      session.socket.destroy();
      session = null;

      if (output.length === 0) {
        return {
          content: [{ type: 'text', text: `(no new output) — disconnected from ${host}` }],
        };
      }

      return {
        content: [{ type: 'text', text: output + `\n\n--- disconnected from ${host} ---` }],
      };
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
      if (!session?.connected) {
        return {
          content: [{ type: 'text', text: isCaptureActive() ? CAPTURE_ACTIVE : 'No active console connection. Use roku_console_connect first.' }],
          isError: true,
        };
      }

      try {
        return await new Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }>((resolve) => {
          session!.buffer = '';
          session!.socket.write(params.command + '\r\n', (err) => {
            if (err) {
              const host = session?.host ?? 'unknown';
              if (session) { session.socket.destroy(); session = null; }
              resolve({
                content: [{ type: 'text', text: `Failed to send command: ${err.message} — disconnected from ${host}` }],
                isError: true,
              });
              return;
            }

            setTimeout(() => {
              const output = session!.buffer;
              session!.buffer = '';
              const host = session!.host;
              session!.socket.destroy();
              session = null;
              resolve({
                content: [{ type: 'text', text: (output || '(command sent, no output received)') + `\n\n--- disconnected from ${host} ---` }],
              });
            }, 500);
          });
        });
      } catch (error) {
        if (session) { session.socket.destroy(); session = null; }
        return {
          content: [{ type: 'text', text: `Console send failed: ${friendlyError(error)}` }],
          isError: true,
        };
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
      if (!session) {
        return {
          content: [{ type: 'text', text: 'No active console connection to disconnect.' }],
        };
      }

      const host = session.host;
      session.socket.destroy();
      session = null;

      return {
        content: [{ type: 'text', text: `Disconnected from ${host}` }],
      };
    }
  );
}
