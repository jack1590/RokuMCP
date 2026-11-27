import os from 'os';
import path from 'path';
import { PerfettoClient, comparePerfetto, openTrace } from 'roku-perfetto';
import type { AnalysisMode } from 'roku-perfetto';
import { rceUnsupported, resolveTarget, type TargetParams } from '../roku-config.js';
import { RokuError } from './errors.js';

const PERFETTO_ALTERNATIVE =
  'roku-perfetto talks to port 8060 and a plain WebSocket on the device directly, which RCE does not expose. Use a LAN Roku device (pass host), or profile with a .bsprof capture (analyze_bsprof).';

/** Perfetto needs direct LAN access; returns the host or throws a one-line error for Cloud Devices. */
async function lanHost(params: TargetParams, tool: string): Promise<string> {
  const unsupported = rceUnsupported(params, tool, PERFETTO_ALTERNATIVE);
  if (unsupported) throw new Error(unsupported);
  return (await resolveTarget(params)).host!;
}

let client: PerfettoClient | null = null;
let clientHost: string | null = null;

/** Enables tracing for a channel (Roku OS 15.1+, LAN only); relaunch the channel before perfettoStart. */
export async function perfettoEnable(options: TargetParams & { channelId?: string } = {}) {
  const host = await lanHost(options, 'roku_perfetto_enable');
  client = new PerfettoClient(host);
  clientHost = host;
  return client.enable(options.channelId ?? 'dev');
}

export interface PerfettoStartOptions extends TargetParams {
  channelId?: string;
  /** Folder for the .trace file; defaults to the OS temp folder. */
  outDir?: string;
  /** File name without extension; defaults to a timestamped name. */
  outFile?: string;
}

/** Starts streaming a trace to a local file; one recording at a time. */
export async function perfettoStart(options: PerfettoStartOptions = {}): Promise<{ host: string; filePath: string }> {
  const host = await lanHost(options, 'roku_perfetto_start');
  if (!client || clientHost !== host) {
    client = new PerfettoClient(host);
    clientHost = host;
  }
  const dir = options.outDir ?? os.tmpdir();
  const name = options.outFile ?? `roku-perfetto-${Date.now()}`;
  const session = await client.startRecording(path.join(dir, `${name}.trace`), options.channelId ?? 'dev');
  return { host: session.host, filePath: session.filePath };
}

/** Stops the recording; resolves with the file path, duration and size. */
export async function perfettoStop() {
  if (!client || !client.isRecording()) {
    throw new RokuError('not_recording', 'No active Perfetto recording. Use roku_perfetto_start first.', { bare: true });
  }
  return client.stopRecording();
}

export type TraceMode = 'summary' | 'frame-drops' | 'key-events' | 'observers' | 'rendezvous' | 'set-fields' | 'threads';

/** Analyzes a .trace file with trace_processor (downloaded on first use). */
export async function analyzeTrace(options: { filePath: string; mode: TraceMode; top?: number; threshold?: number }): Promise<unknown> {
  const opts = { top: options.top ?? 20, threshold: options.threshold };
  const analyzer = await openTrace(options.filePath);
  try {
    switch (options.mode as AnalysisMode) {
      case 'summary':
        return await analyzer.performanceSummary(opts);
      case 'frame-drops':
        return await analyzer.analyzeFrameDrops(opts);
      case 'key-events':
        return await analyzer.analyzeKeyEvents(opts);
      case 'observers':
        return await analyzer.analyzeObservers(opts);
      case 'rendezvous':
        return await analyzer.analyzeRendezvous(opts);
      case 'set-fields':
        return await analyzer.analyzeSetFields(opts);
      case 'threads':
        return await analyzer.analyzeThreads(opts);
    }
    return undefined;
  } finally {
    await analyzer.close();
  }
}

/** Metric deltas between two .trace files. */
export function compareTraces(options: { beforePath: string; afterPath: string; top?: number }): Promise<unknown> {
  return comparePerfetto(options.beforePath, options.afterPath, { top: options.top ?? 20 });
}

/** A raw PerfettoSQL query against a .trace file. */
export async function queryTrace(options: { filePath: string; sql: string }): Promise<unknown> {
  const analyzer = await openTrace(options.filePath);
  try {
    return await analyzer.query(options.sql);
  } finally {
    await analyzer.close();
  }
}
