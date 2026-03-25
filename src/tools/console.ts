import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import net from 'net';
import { resolveHost, friendlyError } from '../roku-config.js';

interface ConsoleSession {
  socket: net.Socket;
  buffer: string;
  host: string;
  connected: boolean;
}

let session: ConsoleSession | null = null;

export function registerConsoleTools(server: McpServer): void {
  server.registerTool(
    'roku_console_connect',
    {
      description: 'Open a persistent TCP connection to the BrightScript debug console on port 8085. Only one connection is active at a time.',
      inputSchema: {
        host: z.string().optional().describe('IP address or hostname of the Roku device'),
        port: z.number().optional().default(8085).describe('Debug console port (default 8085)'),
      },
    },
    async (params) => {
      try {
        if (session?.connected) {
          return {
            content: [{ type: 'text', text: `Already connected to ${session.host}. Disconnect first to connect to a different device.` }],
          };
        }

        const host = await resolveHost(params);
        const port = params.port ?? 8085;

        return await new Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }>((resolve) => {
          const socket = new net.Socket();
          const newSession: ConsoleSession = {
            socket,
            buffer: '',
            host,
            connected: false,
          };

          const timeout = setTimeout(() => {
            socket.destroy();
            resolve({
              content: [{ type: 'text', text: `Connection to ${host}:${port} timed out — make sure the Roku device is on the same network and has a sideloaded dev channel running.` }],
              isError: true,
            });
          }, 10_000);

          socket.connect(port, host, () => {
            clearTimeout(timeout);
            newSession.connected = true;
            session = newSession;
            resolve({
              content: [{ type: 'text', text: `Connected to BrightScript debug console at ${host}:${port}` }],
            });
          });

          socket.on('data', (data) => {
            if (session === newSession) {
              session.buffer += data.toString();
            }
          });

          socket.on('close', () => {
            if (session === newSession) {
              session.connected = false;
            }
          });

          socket.on('error', (err) => {
            clearTimeout(timeout);
            if (session === newSession) {
              session.connected = false;
            }
            if (!newSession.connected) {
              resolve({
                content: [{ type: 'text', text: `Console connection failed: ${friendlyError(err)}` }],
                isError: true,
              });
            }
          });
        });
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
      description: 'Read buffered output from the BrightScript debug console since the last read. Automatically disconnects after reading.',
    },
    async () => {
      if (!session?.connected) {
        return {
          content: [{ type: 'text', text: 'No active console connection. Use roku_console_connect first.' }],
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
      description: 'Send a command to the BrightScript debug console and return the response. Automatically disconnects after receiving the response. Common commands: bt (backtrace), var (variables), cont (continue), step, over, out, exit, print <expr>.',
      inputSchema: {
        command: z.string().describe('Command to send to the debug console'),
      },
    },
    async (params) => {
      if (!session?.connected) {
        return {
          content: [{ type: 'text', text: 'No active console connection. Use roku_console_connect first.' }],
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
