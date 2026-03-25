import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { rokuDeploy } from 'roku-deploy';
import { resolveConfig, friendlyError } from '../roku-config.js';

export function registerDeployTools(server: McpServer): void {
  server.registerTool(
    'roku_deploy',
    {
      description: 'Sideload (deploy) a Roku application to the device. Packages all files in the project directory and uploads them. A dev channel must not already be running, or it will be replaced.',
      inputSchema: {
        host: z.string().optional().describe('IP address or hostname of the Roku device'),
        password: z.string().optional().describe('Developer password for the Roku device'),
        rootDir: z.string().describe('Absolute path to the project root directory containing the manifest file'),
        files: z
          .array(z.string())
          .optional()
          .describe('Glob patterns for files to include. Defaults to all files in rootDir (**/*).'),
      },
    },
    async (params) => {
      try {
        const manifestPath = path.join(params.rootDir, 'manifest');
        try {
          await fs.access(manifestPath);
        } catch {
          return {
            content: [{ type: 'text', text: `Deploy failed: No manifest file found at ${manifestPath}. The rootDir must point to the Roku project directory that contains the manifest file.` }],
            isError: true,
          };
        }

        const config = await resolveConfig(params);
        const outDir = path.join(os.tmpdir(), 'roku-mcp-deploy');
        const deployOptions: Record<string, unknown> = {
          host: config.host,
          password: config.password,
          rootDir: params.rootDir,
          outDir,
          files: params.files && params.files.length > 0 ? params.files : ['**/*'],
          retainStagingDir: false,
        };

        await rokuDeploy.deploy(deployOptions);
        return {
          content: [{ type: 'text', text: `Successfully deployed app from ${params.rootDir} to ${config.host}` }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Deploy failed: ${friendlyError(error)}` }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'roku_delete_dev_channel',
    {
      description: 'Delete the currently sideloaded developer channel from the Roku device.',
      inputSchema: {
        host: z.string().optional().describe('IP address or hostname of the Roku device'),
        password: z.string().optional().describe('Developer password for the Roku device'),
      },
    },
    async (params) => {
      try {
        const config = await resolveConfig(params);
        await rokuDeploy.deleteInstalledChannel({
          host: config.host,
          password: config.password,
        });
        return {
          content: [{ type: 'text', text: `Successfully deleted dev channel from ${config.host}` }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Delete dev channel failed: ${friendlyError(error)}` }],
          isError: true,
        };
      }
    }
  );
}
