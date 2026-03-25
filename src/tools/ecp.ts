import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import axios from 'axios';
import { XMLParser } from 'fast-xml-parser';
import { resolveHost, friendlyError } from '../roku-config.js';
import { discoverRokuDevices } from '../discovery.js';

const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

function ecpUrl(host: string, path: string): string {
  return `http://${host}:8060/${path}`;
}

export function registerEcpTools(server: McpServer): void {
  server.registerTool(
    'roku_discover',
    {
      description: 'Scan the local network for Roku devices using SSDP discovery. Returns a list of all found devices with their IP addresses.',
      inputSchema: {
        timeoutMs: z.number().optional().default(3000).describe('How long to scan in milliseconds (default 3000)'),
      },
    },
    async (params) => {
      try {
        const devices = await discoverRokuDevices(params.timeoutMs ?? 3000);
        if (devices.length === 0) {
          return {
            content: [{ type: 'text', text: 'No Roku devices found on the network.' }],
          };
        }
        const list = devices.map((d, i) => `${i + 1}. ${d.host} (${d.location})`).join('\n');
        return {
          content: [{ type: 'text', text: `Found ${devices.length} Roku device(s):\n${list}` }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Discovery failed: ${friendlyError(error)}` }],
          isError: true,
        };
      }
    }
  );

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
        const host = await resolveHost(params);
        await axios.post(ecpUrl(host, `keypress/${encodeURIComponent(params.key)}`));
        return {
          content: [{ type: 'text', text: `Key press sent: ${params.key}` }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Key press failed: ${friendlyError(error)}` }],
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
        const host = await resolveHost(params);
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
        return {
          content: [{ type: 'text', text: `Key sequence failed: ${friendlyError(error)}` }],
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
        const host = await resolveHost(toolParams);
        const queryString = toolParams.params
          ? '?' + new URLSearchParams(toolParams.params as Record<string, string>).toString()
          : '';
        await axios.post(ecpUrl(host, `launch/${encodeURIComponent(toolParams.appId)}${queryString}`));
        return {
          content: [{ type: 'text', text: `Launched app ${toolParams.appId} on ${host}` }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Launch failed: ${friendlyError(error)}` }],
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
        const host = await resolveHost(params);
        const response = await axios.get(ecpUrl(host, 'query/device-info'));
        const parsed = xmlParser.parse(response.data);
        return {
          content: [{ type: 'text', text: JSON.stringify(parsed, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Query device info failed: ${friendlyError(error)}` }],
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
        const host = await resolveHost(params);
        const response = await axios.get(ecpUrl(host, 'query/active-app'));
        const parsed = xmlParser.parse(response.data);
        return {
          content: [{ type: 'text', text: JSON.stringify(parsed, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Query active app failed: ${friendlyError(error)}` }],
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
        const host = await resolveHost(params);
        const response = await axios.get(ecpUrl(host, 'query/app-ui'));
        return {
          content: [{ type: 'text', text: response.data }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Query app UI failed: ${friendlyError(error)}` }],
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
        const host = await resolveHost(params);
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
        return {
          content: [{ type: 'text', text: `Query SG nodes failed: ${friendlyError(error)}` }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'roku_type_text',
    {
      description: 'Type a text string into the currently focused text field on the Roku device. Each character is sent as an individual Lit_ keypress. Use this for search fields, email inputs, password fields, etc.',
      inputSchema: {
        host: z.string().optional().describe('IP address or hostname of the Roku device'),
        text: z.string().describe('The text string to type'),
        delayMs: z
          .number()
          .optional()
          .default(50)
          .describe('Delay in milliseconds between each character (default 50)'),
      },
    },
    async (params) => {
      try {
        const host = await resolveHost(params);
        const delay = params.delayMs ?? 50;
        for (const char of params.text) {
          await axios.post(ecpUrl(host, `keypress/${encodeURIComponent('Lit_' + char)}`));
          if (delay > 0) {
            await new Promise((r) => setTimeout(r, delay));
          }
        }
        return {
          content: [{ type: 'text', text: `Typed ${params.text.length} characters: "${params.text}"` }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Type text failed: ${friendlyError(error)}` }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'roku_query_media_player',
    {
      description: 'Query the media player state on the Roku device. Returns playback state (play, pause, buffer, stop, none), position, duration, and error info. Use this to verify video playback in tests.',
      inputSchema: {
        host: z.string().optional().describe('IP address or hostname of the Roku device'),
      },
    },
    async (params) => {
      try {
        const host = await resolveHost(params);
        const response = await axios.get(ecpUrl(host, 'query/media-player'));
        const parsed = xmlParser.parse(response.data);
        return {
          content: [{ type: 'text', text: JSON.stringify(parsed, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Query media player failed: ${friendlyError(error)}` }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'roku_find_node',
    {
      description: 'Search the app UI tree for a node by its ID or attribute value. Returns the matching node with all its properties (text, visible, focused, subtype, bounds, etc.). Only works when a sideloaded dev channel is running.',
      inputSchema: {
        host: z.string().optional().describe('IP address or hostname of the Roku device'),
        nodeId: z.string().optional().describe('The ID of the node to find (e.g. "emailBox", "settingsTabs")'),
        attr: z.string().optional().describe('Attribute name to search by (e.g. "subtype", "text", "name")'),
        value: z.string().optional().describe('Attribute value to match (e.g. "AccountSettingsScreen")'),
      },
    },
    async (params) => {
      try {
        if (!params.nodeId && (!params.attr || !params.value)) {
          return {
            content: [{ type: 'text', text: 'Provide either nodeId, or both attr and value to search for a node.' }],
            isError: true,
          };
        }
        const host = await resolveHost(params);
        const response = await axios.get(ecpUrl(host, 'query/app-ui'));
        const parsed = xmlParser.parse(response.data);

        const results: Record<string, unknown>[] = [];

        function searchNode(node: unknown): void {
          if (!node || typeof node !== 'object') return;
          const n = node as Record<string, unknown>;

          let match = false;
          if (params.nodeId) {
            match = n['@_id'] === params.nodeId || n['@_name'] === params.nodeId;
          } else if (params.attr && params.value) {
            const attrKey = params.attr.startsWith('@_') ? params.attr : `@_${params.attr}`;
            match = String(n[attrKey] ?? '') === params.value;
          }

          if (match) {
            const attrs: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(n)) {
              if (k.startsWith('@_')) {
                attrs[k.slice(2)] = v;
              }
            }
            results.push(attrs);
          }

          for (const v of Object.values(n)) {
            if (Array.isArray(v)) {
              v.forEach(searchNode);
            } else if (typeof v === 'object' && v !== null) {
              searchNode(v);
            }
          }
        }

        searchNode(parsed);

        if (results.length === 0) {
          const searchDesc = params.nodeId ? `id="${params.nodeId}"` : `${params.attr}="${params.value}"`;
          return {
            content: [{ type: 'text', text: `No node found with ${searchDesc} in the current UI tree.` }],
          };
        }

        return {
          content: [{ type: 'text', text: JSON.stringify(results.length === 1 ? results[0] : results, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Find node failed: ${friendlyError(error)}` }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'roku_get_focused_node',
    {
      description: 'Get the currently focused node in the app UI tree. Returns the node with all its properties (id, subtype, text, bounds, etc.). Only works when a sideloaded dev channel is running.',
      inputSchema: {
        host: z.string().optional().describe('IP address or hostname of the Roku device'),
      },
    },
    async (params) => {
      try {
        const host = await resolveHost(params);
        const response = await axios.get(ecpUrl(host, 'query/app-ui'));
        const parsed = xmlParser.parse(response.data);

        let focused: Record<string, unknown> | null = null;

        function findFocused(node: unknown): void {
          if (focused || !node || typeof node !== 'object') return;
          const n = node as Record<string, unknown>;

          if (n['@_focused'] === 'true' || n['@_focused'] === true) {
            const attrs: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(n)) {
              if (k.startsWith('@_')) {
                attrs[k.slice(2)] = v;
              }
            }
            focused = attrs;
            return;
          }

          for (const v of Object.values(n)) {
            if (focused) return;
            if (Array.isArray(v)) {
              v.forEach(findFocused);
            } else if (typeof v === 'object' && v !== null) {
              findFocused(v);
            }
          }
        }

        findFocused(parsed);

        if (!focused) {
          return {
            content: [{ type: 'text', text: 'No focused node found in the current UI tree.' }],
          };
        }

        return {
          content: [{ type: 'text', text: JSON.stringify(focused, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Get focused node failed: ${friendlyError(error)}` }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'roku_sleep',
    {
      description: 'Wait for a specified duration. Use this between navigation steps to allow the UI to render, animations to complete, or content to load.',
      inputSchema: {
        durationMs: z.number().describe('Duration to wait in milliseconds (e.g. 1000 for 1 second, 5000 for 5 seconds)'),
      },
    },
    async (params) => {
      const ms = Math.min(Math.max(params.durationMs, 0), 30_000);
      await new Promise((r) => setTimeout(r, ms));
      return {
        content: [{ type: 'text', text: `Waited ${ms}ms` }],
      };
    }
  );
}
