import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { READ_ONLY, WRITES, targetParams } from '../roku-config.js';
import * as sdk from '../sdk/index.js';
import { fail, ok } from './result.js';

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
        const devices = await sdk.discover({ timeoutMs: params.timeoutMs });
        if (devices.length === 0) {
          return ok('No Roku devices found on the network. SSDP discovery covers the LAN only; for Roku Cloud Emulator devices use roku_rce_list_devices.');
        }
        const list = devices.map((d, i) => `${i + 1}. ${d.host} (${d.location})`).join('\n');
        return ok(`Found ${devices.length} Roku device(s):\n${list}`);
      } catch (error) {
        return fail('Discovery failed', error);
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
        await sdk.keypress(params);
        return ok(`Key press sent: ${params.key}`);
      } catch (error) {
        return fail('Key press failed', error);
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
        await sdk.keySequence(params);
        return ok(`Key sequence sent: ${params.keys.join(', ')}`);
      } catch (error) {
        return fail('Key sequence failed', error);
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
    async (params) => {
      try {
        const { appId, label } = await sdk.launch(params);
        return ok(`Launched app ${appId} on ${label}`);
      } catch (error) {
        return fail('Launch failed', error);
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
        return ok(JSON.stringify(await sdk.deviceInfo(params), null, 2));
      } catch (error) {
        return fail('Query device info failed', error);
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
        return ok(JSON.stringify(await sdk.activeApp(params), null, 2));
      } catch (error) {
        return fail('Query active app failed', error);
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
        return ok(await sdk.appUi(params));
      } catch (error) {
        return fail('Query app UI failed', error);
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
        return ok(await sdk.sgNodes(params));
      } catch (error) {
        return fail('Query SG nodes failed', error);
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
        return ok(`Typed ${await sdk.typeText(params)} characters`);
      } catch (error) {
        return fail('Type text failed', error);
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
        return ok(JSON.stringify(await sdk.mediaPlayer(params), null, 2));
      } catch (error) {
        return fail('Query media player failed', error);
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
        const results = await sdk.findNode(params);
        if (results.length === 0) {
          const searchDesc = params.nodeId ? `id or name "${params.nodeId}"` : `${params.attr}="${params.value}"`;
          return ok(`No node found with ${searchDesc} in the current UI tree.`);
        }
        return ok(JSON.stringify(results.length === 1 ? results[0] : results, null, 2));
      } catch (error) {
        return fail('Find node failed', error);
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
        const focused = await sdk.focusedNode(params);
        return ok(focused ? JSON.stringify(focused, null, 2) : 'No focused node found in the current UI tree.');
      } catch (error) {
        return fail('Get focused node failed', error);
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
    async (params) => ok(`Waited ${await sdk.sleep(params)}ms`)
  );
}
