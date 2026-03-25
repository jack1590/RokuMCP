import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { rokuDeploy } from 'roku-deploy';
import { resolveConfig } from '../roku-config.js';

export function registerDeployTools(server: McpServer): void {
  server.registerTool(
    'roku_deploy',
    {
      description: 'Sideload (deploy) a Roku application to the device. A dev channel must not already be running, or it will be replaced.',
      inputSchema: {
        host: z.string().optional().describe('IP address or hostname of the Roku device'),
        password: z.string().optional().describe('Developer password for the Roku device'),
        rootDir: z.string().describe('Absolute path to the project root directory containing the manifest file'),
        files: z
          .array(z.string())
          .optional()
          .describe('Glob patterns for files to include. Defaults to source/**/*, components/**/*, images/**/*, manifest'),
      },
    },
    async (params) => {
      try {
        const config = resolveConfig(params);
        const deployOptions: Record<string, unknown> = {
          host: config.host,
          password: config.password,
          rootDir: params.rootDir,
        };

        if (params.files && params.files.length > 0) {
          deployOptions.files = params.files;
        }

        await rokuDeploy.deploy(deployOptions);
        return {
          content: [{ type: 'text', text: `Successfully deployed app from ${params.rootDir} to ${config.host}` }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text', text: `Deploy failed: ${message}` }],
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
        const config = resolveConfig(params);
        await rokuDeploy.deleteInstalledChannel({
          host: config.host,
          password: config.password,
        });
        return {
          content: [{ type: 'text', text: `Successfully deleted dev channel from ${config.host}` }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text', text: `Delete dev channel failed: ${message}` }],
          isError: true,
        };
      }
    }
  );
}
