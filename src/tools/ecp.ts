import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { XMLParser } from 'fast-xml-parser';
import { ECP_TREE_TIMEOUT_MS, READ_ONLY, WRITES, friendlyError, resolveTarget, targetParams } from '../roku-config.js';
import { discoverRokuDevices } from '../discovery.js';

const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

const NO_DEV_CHANNEL = 'No dev channel is running (the device answered 404 to query/app-ui). Deploy one with roku_deploy first.';

export function registerEcpTools(server: McpServer): void {
  server.registerTool(
    'roku_discover',
    {
      title: 'Discover LAN devices',
      annotations: READ_ONLY,
      description: 'Scan the local network for Roku devices using SSDP discovery. Returns a list of all found devices with their IP addresses. LAN only: for Roku Cloud Emulator devices use roku_rce_list_devices.',
      inputSchema: {
        timeoutMs: z.number().optional().default(3000).describe('How long to scan in milliseconds (default 3000)'),
      },
    },
    async (params) => {
      try {
        const devices = await discoverRokuDevices(params.timeoutMs ?? 3000);
        if (devices.length === 0) {
          return {
            content: [{ type: 'text', text: 'No Roku devices found on the network. SSDP discovery covers the LAN only; for Roku Cloud Emulator devices use roku_rce_list_devices.' }],
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
      title: 'Press key',
      annotations: WRITES,
      description: 'Send a single key press to the Roku device (via ECP on a LAN device, via the Instance API on a Roku Cloud Emulator device). Common keys: Home, Rev, Fwd, Play, Select, Left, Right, Down, Up, Back, InstantReplay, Info, Backspace, Search, Enter, Lit_<character>',
      inputSchema: {
        ...targetParams,
        key: z.string().describe('The key to press (e.g. Home, Select, Up, Down, Left, Right, Back, Lit_a)'),
      },
    },
    async (params) => {
      try {
        const target = await resolveTarget(params);
        await target.keypress(params.key);
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
      title: 'Press key sequence',
      annotations: WRITES,
      description: 'Send a sequence of key presses to the Roku device with an optional delay between each press.',
      inputSchema: {
        ...targetParams,
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
        const target = await resolveTarget(params);
        const delay = params.delayMs ?? 100;
        for (const key of params.keys) {
          await target.keypress(key);
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
      title: 'Launch channel',
      annotations: WRITES,
      description: 'Launch or deep-link into a channel on the Roku device. Use appId "dev" for the sideloaded developer channel.',
      inputSchema: {
        ...targetParams,
        appId: z.string().describe('Application ID to launch (use "dev" for the sideloaded channel)'),
        params: z
          .record(z.string(), z.string())
          .optional()
          .describe('Optional launch parameters for deep linking (key-value pairs)'),
        restart: z
          .boolean()
          .optional()
          .default(false)
          .describe('Exit the app first (ECP exit-app, falling back to Home) and wait ~1.5s. Channels with sdk_instant_resume only suspend on exit and will resume, not cold-start; use roku_deploy for a guaranteed cold start'),
      },
    },
    async (toolParams) => {
      try {
        const target = await resolveTarget(toolParams);
        if (toolParams.restart) {
          await target
            .ecp(`exit-app/${encodeURIComponent(toolParams.appId)}`, { method: 'POST' })
            .catch(() => target.keypress('Home'));
          await new Promise((r) => setTimeout(r, 1500));
        }
        const queryString = toolParams.params
          ? '?' + new URLSearchParams(toolParams.params as Record<string, string>).toString()
          : '';
        await target.ecp(`launch/${encodeURIComponent(toolParams.appId)}${queryString}`, { method: 'POST' });
        return {
          content: [{ type: 'text', text: `Launched app ${toolParams.appId} on ${target.label}` }],
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
      title: 'Query device info',
      annotations: READ_ONLY,
      description: 'Query the Roku device for its info: model, firmware version, serial number, network info, etc.',
      inputSchema: {
        ...targetParams,
      },
    },
    async (params) => {
      try {
        const target = await resolveTarget(params);
        const parsed = xmlParser.parse(await target.ecp('query/device-info'));
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
      title: 'Query active app',
      annotations: READ_ONLY,
      description: 'Query the currently active (foreground) app on the Roku device.',
      inputSchema: {
        ...targetParams,
      },
    },
    async (params) => {
      try {
        const target = await resolveTarget(params);
        const parsed = xmlParser.parse(await target.ecp('query/active-app'));
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
      title: 'Query app UI tree',
      annotations: READ_ONLY,
      description: 'Get the current app UI tree as XML. Only works when a sideloaded dev channel is running. On a Roku Cloud Emulator device in the default "Limited" ECP mode this query is refused (403); the error explains how to switch the device to Permissive.',
      inputSchema: {
        ...targetParams,
      },
    },
    async (params) => {
      try {
        const target = await resolveTarget(params);
        const xml = await target.ecp('query/app-ui', { timeoutMs: ECP_TREE_TIMEOUT_MS });
        return {
          content: [{ type: 'text', text: xml }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Query app UI failed: ${friendlyError(error, { notFound: NO_DEV_CHANNEL })}` }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'roku_query_sg_nodes',
    {
      title: 'Query SceneGraph nodes',
      annotations: READ_ONLY,
      description: 'Query SceneGraph nodes on the Roku device. Use type "all" for all nodes, "roots" for root nodes, or "node" with a nodeId to inspect a specific node. On a Roku Cloud Emulator device in the default "Limited" ECP mode this query is refused (403); the error explains how to switch the device to Permissive.',
      inputSchema: {
        ...targetParams,
        type: z.enum(['all', 'roots', 'node']).describe('Type of query: "all", "roots", or "node"'),
        nodeId: z.string().optional().describe('Node ID to inspect (required when type is "node")'),
      },
    },
    async (params) => {
      try {
        const target = await resolveTarget(params);
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

        const xml = await target.ecp(path, { timeoutMs: ECP_TREE_TIMEOUT_MS });
        return {
          content: [{ type: 'text', text: xml }],
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
      title: 'Type text',
      annotations: WRITES,
      description: 'Type a text string into the currently focused text field on the Roku device. Each character is sent as an individual Lit_ keypress. Use this for search fields, email inputs, password fields, etc. The result reports only the number of characters typed, never the text.',
      inputSchema: {
        ...targetParams,
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
        const target = await resolveTarget(params);
        const delay = params.delayMs ?? 50;
        for (const char of params.text) {
          await target.keypress('Lit_' + char);
          if (delay > 0) {
            await new Promise((r) => setTimeout(r, delay));
          }
        }
        return {
          content: [{ type: 'text', text: `Typed ${[...params.text].length} characters` }],
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
      title: 'Query media player',
      annotations: READ_ONLY,
      description: 'Query the media player state on the Roku device. Returns playback state (play, pause, buffer, stop, none), position, duration, and error info. Use this to verify video playback in tests. On a Roku Cloud Emulator device in the default "Limited" ECP mode this query is refused (403); the error explains how to switch the device to Permissive.',
      inputSchema: {
        ...targetParams,
      },
    },
    async (params) => {
      try {
        const target = await resolveTarget(params);
        const parsed = xmlParser.parse(await target.ecp('query/media-player'));
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
      title: 'Find UI node',
      annotations: READ_ONLY,
      description: 'Search the app UI tree for a node. nodeId matches a node whose id or name attribute equals the value; alternatively pass attr and value to match any attribute. Returns the matching node with all its properties (text, visible, focused, subtype, bounds, etc.). Only works when a sideloaded dev channel is running. On a Roku Cloud Emulator device in the default "Limited" ECP mode this query is refused (403); the error explains how to switch the device to Permissive.',
      inputSchema: {
        ...targetParams,
        nodeId: z.string().optional().describe('Matches the node id or name attribute (e.g. "emailBox", "settingsTabs")'),
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
        const target = await resolveTarget(params);
        const parsed = xmlParser.parse(await target.ecp('query/app-ui', { timeoutMs: ECP_TREE_TIMEOUT_MS }));

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
          const searchDesc = params.nodeId ? `id or name "${params.nodeId}"` : `${params.attr}="${params.value}"`;
          return {
            content: [{ type: 'text', text: `No node found with ${searchDesc} in the current UI tree.` }],
          };
        }

        return {
          content: [{ type: 'text', text: JSON.stringify(results.length === 1 ? results[0] : results, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Find node failed: ${friendlyError(error, { notFound: NO_DEV_CHANNEL })}` }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'roku_get_focused_node',
    {
      title: 'Get focused node',
      annotations: READ_ONLY,
      description: 'Get the currently focused node in the app UI tree. Returns the node with all its properties (id, subtype, text, bounds, etc.). Only works when a sideloaded dev channel is running. On a Roku Cloud Emulator device in the default "Limited" ECP mode this query is refused (403); the error explains how to switch the device to Permissive.',
      inputSchema: {
        ...targetParams,
      },
    },
    async (params) => {
      try {
        const target = await resolveTarget(params);
        const parsed = xmlParser.parse(await target.ecp('query/app-ui', { timeoutMs: ECP_TREE_TIMEOUT_MS }));

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
          content: [{ type: 'text', text: `Get focused node failed: ${friendlyError(error, { notFound: NO_DEV_CHANNEL })}` }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'roku_sleep',
    {
      title: 'Sleep',
      annotations: READ_ONLY,
      description: 'Wait for a specified duration. Use this between navigation steps to allow the UI to render, animations to complete, or content to load. The duration is clamped to 0..30000 ms.',
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
