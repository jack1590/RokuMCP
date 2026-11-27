import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { WRITES, passwordParam, targetParams } from '../roku-config.js';
import * as sdk from '../sdk/index.js';
import { fail } from './result.js';

export function registerScreenshotTools(server: McpServer): void {
  server.registerTool(
    'roku_screenshot',
    {
      title: 'Take screenshot',
      annotations: WRITES, // writes the image to a local file
      description: 'Capture a screenshot of the current screen on the Roku device. A sideloaded dev channel must be running. Returns the image as base64-encoded content and the file path where it was saved.',
      inputSchema: {
        ...targetParams,
        password: passwordParam,
        outDir: z.string().optional().describe('Directory to save the screenshot. Defaults to OS temp directory.'),
        outFile: z.string().optional().describe('Base filename (without extension). Defaults to timestamped name.'),
      },
    },
    async (params) => {
      try {
        const shot = await sdk.screenshot(params);
        return {
          content: [
            { type: 'image' as const, data: shot.data.toString('base64'), mimeType: shot.mimeType },
            { type: 'text' as const, text: `Screenshot saved to: ${shot.filePath}` },
          ],
        };
      } catch (error) {
        return fail('Screenshot failed', error);
      }
    }
  );
}
