import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { DESTRUCTIVE, passwordParam, targetParams } from '../roku-config.js';
import * as sdk from '../sdk/index.js';
import { fail, ok } from './result.js';

export function registerDeployTools(server: McpServer): void {
  server.registerTool(
    'roku_deploy',
    {
      title: 'Deploy dev channel',
      annotations: DESTRUCTIVE,
      description: 'Sideload (deploy) a Roku application to the device. Packages the files in rootDir into a zip and uploads it, which replaces the installed dev channel and cold-starts it. Works on LAN devices and on Roku Cloud Emulator devices (rceDevice).',
      inputSchema: {
        ...targetParams,
        password: passwordParam,
        rootDir: z.string().describe('Absolute path to the project root directory containing the manifest file'),
        files: z
          .array(z.string())
          .optional()
          .describe('Glob patterns for files to include. Defaults to all files in rootDir (**/*).'),
        stagingDir: z
          .string()
          .optional()
          .describe('Scratch folder roku-deploy empties, fills and deletes. Defaults to a unique temp folder; must not be rootDir, inside it, or contain it.'),
      },
    },
    async (params) => {
      try {
        const result = await sdk.deploy(params);
        const note = result.identical ? ' (the device reported the package as identical to the installed one)' : '';
        return ok(`Successfully deployed app from ${result.rootDir} to ${result.label}${note}`);
      } catch (error) {
        return fail('Deploy failed', error);
      }
    }
  );

  server.registerTool(
    'roku_delete_dev_channel',
    {
      title: 'Delete dev channel',
      annotations: DESTRUCTIVE,
      description: 'Delete the currently sideloaded developer channel from the Roku device (LAN or Roku Cloud Emulator).',
      inputSchema: {
        ...targetParams,
        password: passwordParam,
      },
    },
    async (params) => {
      try {
        const { label } = await sdk.deleteDevChannel(params);
        return ok(`Successfully deleted dev channel from ${label}`);
      } catch (error) {
        return fail('Delete dev channel failed', error);
      }
    }
  );
}
