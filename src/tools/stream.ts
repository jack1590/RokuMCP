import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { DESTRUCTIVE, passwordParam, targetParams } from '../roku-config.js';
import * as sdk from '../sdk/index.js';
import { fail, ok } from './result.js';

export function registerStreamTools(server: McpServer): void {
  server.registerTool(
    'roku_diagnose_stream',
    {
      title: 'Diagnose stream',
      annotations: DESTRUCTIVE, // captureLive replaces the installed dev channel
      description:
        'Diagnose why an HLS/DASH stream fails on Roku specifically by correlating the evidence you already have. ' +
        'Provide any combination of: the Video node error the device reported (errorInfo, as JSON or pasted log text), ' +
        'the manifest (a url to fetch, or pasted m3u8/mpd content), and a Charles/HAR HTTP capture file. ' +
        'The tool cross-references them into ranked root-cause findings (e.g. "errorCode -6 DRM + a 403 license POST = license server rejected the Roku request"). ' +
        'No Roku device is required for this. Optionally set captureLive=true to deploy a bundled StreamProbe harness (replacing the installed dev channel) and capture the device error first when you do not have errorInfo yet; host and password fall back to ROKU_DEVICE_HOST / ROKU_DEVICE_PASSWORD (or their aliases) and SSDP discovery. captureLive is not supported on Roku Cloud Emulator devices.',
      inputSchema: {
        errorInfo: z
          .string()
          .optional()
          .describe('The Video-node error the device reported. Accepts JSON (e.g. {"errorCode":-6,"errorInfo":{"category":"drm","drmerrcode":13}}) or loose pasted log text.'),
        url: z.string().optional().describe('URL of the HLS (.m3u8) or DASH (.mpd) manifest to fetch and analyze.'),
        content: z.string().optional().describe('Raw manifest text (m3u8 or mpd) pasted directly, when the URL is not fetchable (auth/token-gated).'),
        format: z.enum(['hls', 'dash']).optional().describe('Force the manifest format. Auto-detected from content/URL when omitted.'),
        charlesSessionPath: z
          .string()
          .optional()
          .describe('Path to a Charles ".chlsj" (JSON Session File) or ".har" capture on disk. Binary ".chls" is not supported.'),
        drm: z
          .object({
            keySystem: z.string().optional().describe('e.g. "Widevine" or "PlayReady"'),
            licenseServerUrl: z.string().optional(),
            licenseHeaders: z.record(z.string(), z.string()).optional(),
          })
          .optional()
          .describe('The DRM configuration you used (helps the live capture and DRM correlation).'),
        captureLive: z
          .boolean()
          .optional()
          .default(false)
          .describe('When true and no errorInfo is provided, deploy the bundled StreamProbe harness to a LAN device, play the stream, and capture the error. Requires a fetchable url; host and password fall back to the environment.'),
        ...targetParams,
        password: passwordParam,
      },
    },
    async (params) => {
      try {
        return ok(JSON.stringify(await sdk.diagnoseStream(params), null, 2));
      } catch (error) {
        return fail('Diagnose stream failed', error);
      }
    }
  );
}
