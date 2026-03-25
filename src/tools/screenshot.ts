import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { rokuDeploy } from 'roku-deploy';
import fs from 'fs/promises';
import path from 'path';
import { resolveConfig, friendlyError } from '../roku-config.js';

export function registerScreenshotTools(server: McpServer): void {
  server.registerTool(
    'roku_screenshot',
    {
      description: 'Capture a screenshot of the current screen on the Roku device. A sideloaded dev channel must be running. Returns the image as base64-encoded content and the file path where it was saved.',
      inputSchema: {
        host: z.string().optional().describe('IP address or hostname of the Roku device'),
        password: z.string().optional().describe('Developer password for the Roku device'),
        outDir: z.string().optional().describe('Directory to save the screenshot. Defaults to OS temp directory.'),
        outFile: z.string().optional().describe('Base filename (without extension). Defaults to timestamped name.'),
      },
    },
    async (params) => {
      try {
        const config = await resolveConfig(params);
        const options: Record<string, unknown> = {
          host: config.host,
          password: config.password,
        };

        if (params.outDir) {
          options.outDir = params.outDir;
        }
        if (params.outFile) {
          options.outFile = params.outFile;
        }

        const filePath = await rokuDeploy.takeScreenshot(options as any);
        const ext = path.extname(filePath).toLowerCase();
        const mimeType = ext === '.png' ? 'image/png' : 'image/jpeg';
        const imageBuffer = await fs.readFile(filePath);
        const base64 = imageBuffer.toString('base64');

        return {
          content: [
            {
              type: 'image' as const,
              data: base64,
              mimeType,
            },
            {
              type: 'text' as const,
              text: `Screenshot saved to: ${filePath}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Screenshot failed: ${friendlyError(error)}` }],
          isError: true,
        };
      }
    }
  );
}
