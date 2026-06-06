import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import fs from 'fs/promises';
import { resolveConfig, friendlyError } from '../roku-config.js';
import { normalizeRokuError, type NormalizedRokuError } from '../stream/error-info.js';
import { loadManifest, type ManifestSummary, type StreamFormat } from '../stream/manifest.js';
import { parseCharlesText, type CharlesSession } from '../stream/charles.js';
import { diagnose, type Diagnosis } from '../stream/diagnose.js';
import { captureLive } from '../stream/live.js';

/**
 * roku_diagnose_stream — correlation engine.
 *
 * Combines the evidence a developer already has (the Video-node errorInfo, the
 * manifest/URL, and optionally a Charles/HAR HTTP capture) into a Roku-specific
 * root cause + fix. No device is needed for the default path. When no errorInfo
 * is supplied and a device is available, `captureLive: true` deploys the bundled
 * StreamProbe harness to capture the error first.
 */

function manifestSummaryForReport(m: ManifestSummary) {
  return {
    format: m.format,
    isLive: m.isLive,
    container: m.container,
    muxed: m.muxed,
    videoCodecs: m.videoCodecs,
    audioCodecs: m.audioCodecs,
    drm: m.drm.map((d) => ({ system: d.system, hasPssh: d.hasPssh })),
    maxSegmentSeconds: m.maxSegmentSeconds,
    isMultivariant: m.isMultivariant,
    notes: m.notes,
  };
}

function httpFindingsForReport(c: CharlesSession) {
  return {
    format: c.format,
    totalEntries: c.entries.length,
    byKind: countBy(c.entries.map((e) => e.kind)),
    failing: c.failing.slice(0, 20).map((e) => ({
      kind: e.kind,
      method: e.method,
      status: e.status,
      url: e.url,
      contentType: e.mimeType,
    })),
    notes: c.notes,
  };
}

function countBy(items: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const i of items) out[i] = (out[i] ?? 0) + 1;
  return out;
}

export function registerStreamTools(server: McpServer): void {
  server.registerTool(
    'roku_diagnose_stream',
    {
      description:
        'Diagnose why an HLS/DASH stream fails on Roku specifically by correlating the evidence you already have. ' +
        'Provide any combination of: the Video node error the device reported (errorInfo, as JSON or pasted log text), ' +
        'the manifest (a url to fetch, or pasted m3u8/mpd content), and a Charles/HAR HTTP capture file. ' +
        'The tool cross-references them into ranked root-cause findings (e.g. "errorCode -6 DRM + a 403 license POST = license server rejected the Roku request"). ' +
        'No Roku device is required for this. Optionally set captureLive=true (with host+password) to deploy a bundled StreamProbe harness and capture the device error first when you do not have errorInfo yet.',
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
          .describe('When true and no errorInfo is provided, deploy the bundled StreamProbe harness to the device, play the stream, and capture the error. Requires host+password and a fetchable url.'),
        host: z.string().optional().describe('IP/hostname of the Roku device (only for captureLive).'),
        password: z.string().optional().describe('Developer password (only for captureLive).'),
      },
    },
    async (params) => {
      try {
        const hasManifestSource = !!(params.url || params.content);
        if (!params.errorInfo && !hasManifestSource && !params.charlesSessionPath && !params.captureLive) {
          return {
            content: [{ type: 'text', text: 'Provide at least one evidence source: `errorInfo`, a manifest (`url` or `content`), a `charlesSessionPath`, or `captureLive: true`.' }],
            isError: true,
          };
        }

        const reportNotes: string[] = [];

        // 1. Device error evidence.
        let error: NormalizedRokuError | undefined;
        if (params.errorInfo) {
          error = normalizeRokuError(params.errorInfo);
          if (error.empty) reportNotes.push('Could not extract recognizable fields from the provided errorInfo.');
        }

        // 2. Charles/HAR session.
        let charles: CharlesSession | undefined;
        if (params.charlesSessionPath) {
          try {
            const text = await fs.readFile(params.charlesSessionPath, 'utf-8');
            charles = parseCharlesText(text);
          } catch (e) {
            reportNotes.push(`Charles session could not be read/parsed: ${e instanceof Error ? e.message : String(e)}`);
          }
        }

        // 3. Manifest (pasted, fetched, or extracted from Charles).
        let manifest: ManifestSummary | undefined;
        let manifestContent = params.content;
        let manifestUrl = params.url;
        if (!manifestContent && !manifestUrl && charles) {
          const manEntry = charles.entries.find((e) => e.kind === 'manifest' && e.respBody);
          if (manEntry) {
            manifestContent = manEntry.respBody;
            manifestUrl = manEntry.url;
            reportNotes.push(`Manifest extracted from the Charles session: ${manEntry.url}`);
          }
        }
        if (manifestContent || manifestUrl) {
          try {
            manifest = await loadManifest({
              content: manifestContent,
              url: manifestUrl,
              format: params.format as StreamFormat | undefined,
            });
          } catch (e) {
            reportNotes.push(`Manifest could not be loaded/parsed: ${friendlyError(e)}`);
          }
        }

        // 4. Optional live capture when no errorInfo was provided.
        let liveCapture: Awaited<ReturnType<typeof captureLive>> | undefined;
        if (!error && params.captureLive) {
          if (!params.url) {
            reportNotes.push('captureLive was requested but no `url` was provided — a live playback test needs a fetchable stream URL. Skipped live capture.');
          } else {
            try {
              const config = await resolveConfig(params);
              liveCapture = await captureLive({
                host: config.host,
                password: config.password,
                url: params.url,
                format: (params.format as string | undefined) ?? manifest?.format,
                drm: params.drm,
              });
              error = liveCapture.error;
              reportNotes.push(`Live capture finished in state "${liveCapture.finalState}".`);
              if (error.empty) reportNotes.push('Live capture did not surface a Video error (the stream may have played, or RTA was unavailable).');
            } catch (e) {
              reportNotes.push(`Live capture failed: ${friendlyError(e)}`);
            }
          }
        }

        // 5. Correlate.
        const diagnosis: Diagnosis = diagnose({
          error: error && !error.empty ? error : undefined,
          manifest,
          charles,
          declaredDrm: params.drm,
        });

        const report = {
          verdict: diagnosis.verdict,
          findings: diagnosis.findings,
          deviceError: error && !error.empty ? error : undefined,
          manifestSummary: manifest ? manifestSummaryForReport(manifest) : undefined,
          httpFindings: charles ? httpFindingsForReport(charles) : undefined,
          liveCapture: liveCapture ? { finalState: liveCapture.finalState, raw: liveCapture.raw } : undefined,
          notes: reportNotes,
          specVersion: diagnosis.specVersion,
          specDisclaimer: diagnosis.specDisclaimer,
        };

        return { content: [{ type: 'text', text: JSON.stringify(report, null, 2) }] };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Diagnose stream failed: ${friendlyError(error)}` }],
          isError: true,
        };
      }
    }
  );
}
