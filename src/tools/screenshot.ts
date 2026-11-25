import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { rokuDeploy } from 'roku-deploy';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { WRITES, friendlyError, passwordParam, resolveTarget, targetParams } from '../roku-config.js';

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
        const target = await resolveTarget(params, { needPassword: true });
        let filePath: string;
        let imageBuffer: Buffer;
        if (target.rce) {
          const shot = await target.rce.instance.screenshot();
          const dir = params.outDir ?? os.tmpdir();
          await fs.mkdir(dir, { recursive: true });
          filePath = path.join(dir, `${params.outFile ?? `screenshot-${Date.now()}`}.${shot.extension}`);
          await fs.writeFile(filePath, shot.data);
          imageBuffer = shot.data;
        } else {
          const options: Record<string, unknown> = { host: target.host, password: target.password };
          if (params.outDir) options.outDir = params.outDir;
          if (params.outFile) options.outFile = params.outFile;
          filePath = await rokuDeploy.takeScreenshot(options as any);
          imageBuffer = await fs.readFile(filePath);
        }
        const ext = path.extname(filePath).toLowerCase();
        const mimeType = ext === '.png' ? 'image/png' : 'image/jpeg';
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
