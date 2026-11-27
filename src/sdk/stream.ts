/**
 * Stream diagnosis: combines the evidence a developer already has (the Video-node errorInfo, the
 * manifest or URL, and optionally a Charles/HAR HTTP capture) into a Roku-specific root cause and
 * fix. No device is needed for the default path. When no errorInfo is supplied and a device is
 * available, `captureLive: true` deploys the bundled StreamProbe harness to capture the error first.
 */
import fs from 'fs/promises';
import { friendlyError, rceUnsupported, resolveTarget, type TargetParams } from '../roku-config.js';
import { normalizeRokuError, type NormalizedRokuError } from '../stream/error-info.js';
import { loadManifest, type ManifestSummary, type StreamFormat } from '../stream/manifest.js';
import { parseCharlesText, type CharlesSession } from '../stream/charles.js';
import { diagnose, type Diagnosis } from '../stream/diagnose.js';
import { captureLive } from '../stream/live.js';
import { RokuError } from './errors.js';

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

export interface DiagnoseStreamOptions extends TargetParams {
  /** The Video-node error, as JSON or pasted log text. */
  errorInfo?: string;
  /** Manifest URL to fetch. */
  url?: string;
  /** Pasted m3u8 or mpd text. */
  content?: string;
  format?: 'hls' | 'dash';
  /** A Charles .chlsj or .har file on disk. */
  charlesSessionPath?: string;
  drm?: { keySystem?: string; licenseServerUrl?: string; licenseHeaders?: Record<string, string> };
  /** Deploy the StreamProbe harness to a LAN device and capture the error (needs url, no errorInfo). */
  captureLive?: boolean;
  /** Size and time limits on the session file and manifest fetches (roku_run sets them; the tool does not). */
  limits?: { maxBytes: number; timeoutMs: number };
}

/** Ranked root-cause findings plus the evidence summaries behind them. */
export async function diagnoseStream(params: DiagnoseStreamOptions) {
  const hasManifestSource = !!(params.url || params.content);
  if (!params.errorInfo && !hasManifestSource && !params.charlesSessionPath && !params.captureLive) {
    throw new RokuError('no_evidence', 'Provide at least one evidence source: `errorInfo`, a manifest (`url` or `content`), a `charlesSessionPath`, or `captureLive: true`.', { bare: true });
  }

  const unsupported =
    params.captureLive && !params.errorInfo
      ? rceUnsupported(params, 'roku_diagnose_stream captureLive', 'Pass host for a LAN device, or play the stream in your own channel on the Cloud Device and pass the reported error as errorInfo.')
      : undefined;
  if (unsupported) throw new RokuError('unsupported_target', unsupported, { bare: true });

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
      const size = params.limits ? (await fs.stat(params.charlesSessionPath)).size : 0;
      if (params.limits && size > params.limits.maxBytes) throw new Error(`the file is ${size} bytes; roku_run reads at most ${params.limits.maxBytes}`);
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
        limits: params.limits,
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
        const config = await resolveTarget(params, { needPassword: true });
        liveCapture = await captureLive({
          host: config.host!,
          password: config.password!,
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

  return report;
}
