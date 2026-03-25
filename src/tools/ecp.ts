import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import axios from 'axios';
import { XMLParser } from 'fast-xml-parser';
import { resolveHost } from '../roku-config.js';

const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

function ecpUrl(host: string, path: string): string {
  return `http://${host}:8060/${path}`;
}

export function registerEcpTools(server: McpServer): void {
  server.registerTool(
    'roku_keypress',
    {
      description: 'Send a single key press to the Roku device via ECP. Common keys: Home, Rev, Fwd, Play, Select, Left, Right, Down, Up, Back, InstantReplay, Info, Backspace, Search, Enter, Lit_<character>',
      inputSchema: {
        host: z.string().optional().describe('IP address or hostname of the Roku device'),
        key: z.string().describe('The key to press (e.g. Home, Select, Up, Down, Left, Right, Back, Lit_a)'),
      },
    },
    async (params) => {
      try {
        const host = resolveHost(params);
        await axios.post(ecpUrl(host, `keypress/${encodeURIComponent(params.key)}`));
        return {
          content: [{ type: 'text', text: `Key press sent: ${params.key}` }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text', text: `Key press failed: ${message}` }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'roku_keypress_sequence',
    {
      description: 'Send a sequence of key presses to the Roku device with an optional delay between each press.',
      inputSchema: {
        host: z.string().optional().describe('IP address or hostname of the Roku device'),
        keys: z.array(z.string()).describe('Array of keys to press in order'),
        delayMs: z
          .number()
          .optional()
          .default(100)
          .describe('Delay in milliseconds between each key press (default 100)'),
      },
    },
    async (params) => {
      try {
        const host = resolveHost(params);
        const delay = params.delayMs ?? 100;
        for (const key of params.keys) {
          await axios.post(ecpUrl(host, `keypress/${encodeURIComponent(key)}`));
          if (delay > 0) {
            await new Promise((r) => setTimeout(r, delay));
          }
        }
        return {
          content: [{ type: 'text', text: `Key sequence sent: ${params.keys.join(', ')}` }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text', text: `Key sequence failed: ${message}` }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'roku_launch',
    {
      description: 'Launch or deep-link into a channel on the Roku device. Use appId "dev" for the sideloaded developer channel.',
      inputSchema: {
        host: z.string().optional().describe('IP address or hostname of the Roku device'),
        appId: z.string().describe('Application ID to launch (use "dev" for the sideloaded channel)'),
        params: z
          .record(z.string(), z.string())
          .optional()
          .describe('Optional launch parameters for deep linking (key-value pairs)'),
      },
    },
    async (toolParams) => {
      try {
        const host = resolveHost(toolParams);
        const queryString = toolParams.params
          ? '?' + new URLSearchParams(toolParams.params as Record<string, string>).toString()
          : '';
        await axios.post(ecpUrl(host, `launch/${encodeURIComponent(toolParams.appId)}${queryString}`));
        return {
          content: [{ type: 'text', text: `Launched app ${toolParams.appId} on ${host}` }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text', text: `Launch failed: ${message}` }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'roku_query_device_info',
    {
      description: 'Query the Roku device for its info: model, firmware version, serial number, network info, etc.',
      inputSchema: {
        host: z.string().optional().describe('IP address or hostname of the Roku device'),
      },
    },
    async (params) => {
      try {
        const host = resolveHost(params);
        const response = await axios.get(ecpUrl(host, 'query/device-info'));
        const parsed = xmlParser.parse(response.data);
        return {
          content: [{ type: 'text', text: JSON.stringify(parsed, null, 2) }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text', text: `Query device info failed: ${message}` }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'roku_query_active_app',
    {
      description: 'Query the currently active (foreground) app on the Roku device.',
      inputSchema: {
        host: z.string().optional().describe('IP address or hostname of the Roku device'),
      },
    },
    async (params) => {
      try {
        const host = resolveHost(params);
        const response = await axios.get(ecpUrl(host, 'query/active-app'));
        const parsed = xmlParser.parse(response.data);
        return {
          content: [{ type: 'text', text: JSON.stringify(parsed, null, 2) }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text', text: `Query active app failed: ${message}` }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'roku_query_app_ui',
    {
      description: 'Get the current app UI tree as XML. Only works when a sideloaded dev channel is running.',
      inputSchema: {
        host: z.string().optional().describe('IP address or hostname of the Roku device'),
      },
    },
    async (params) => {
      try {
        const host = resolveHost(params);
        const response = await axios.get(ecpUrl(host, 'query/app-ui'));
        return {
          content: [{ type: 'text', text: response.data }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text', text: `Query app UI failed: ${message}` }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'roku_query_sg_nodes',
    {
      description: 'Query SceneGraph nodes on the Roku device. Use type "all" for all nodes, "roots" for root nodes, or "node" with a nodeId to inspect a specific node.',
      inputSchema: {
        host: z.string().optional().describe('IP address or hostname of the Roku device'),
        type: z.enum(['all', 'roots', 'node']).describe('Type of query: "all", "roots", or "node"'),
        nodeId: z.string().optional().describe('Node ID to inspect (required when type is "node")'),
      },
    },
    async (params) => {
      try {
        const host = resolveHost(params);
        let path: string;

        if (params.type === 'node') {
          if (!params.nodeId) {
            return {
              content: [{ type: 'text', text: 'nodeId is required when type is "node"' }],
              isError: true,
            };
          }
          path = `query/sgnodes/nodes/${encodeURIComponent(params.nodeId)}`;
        } else {
          path = `query/sgnodes/${params.type}`;
        }

        const response = await axios.get(ecpUrl(host, path));
        return {
          content: [{ type: 'text', text: response.data }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text', text: `Query SG nodes failed: ${message}` }],
          isError: true,
        };
      }
    }
  );
}
