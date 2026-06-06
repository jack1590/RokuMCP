/**
 * Optional live-capture fallback for roku_diagnose_stream.
 *
 * Used only when the developer does NOT already have the Video-node errorInfo
 * and a device is available. It deploys the bundled StreamProbe harness,
 * deep-links the stream/DRM into it, waits for playback to settle or error, and
 * reads the probe fields back over the RTA On-Device Component (TCP 9000). The
 * captured error is then handed to diagnose.ts like any other evidence.
 *
 * This mirrors the RTA framing used by src/tools/edit-ui.ts, kept self-contained
 * so the diagnoser has no cross-tool import coupling.
 */

import net from 'net';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { rokuDeploy } from 'roku-deploy';
import axios from 'axios';
import type { NormalizedRokuError } from './error-info.js';
import { normalizeRokuError } from './error-info.js';

const RTA_PORT = 9000;
const HEADER_SIZE = 8;
const DEFAULT_TIMEOUT_MS = 5000;

interface PendingRequest {
  resolve: (json: any) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

class RtaClient {
  private socket: net.Socket;
  private connected = false;
  private pending = new Map<string, PendingRequest>();
  private incoming: { stringLength: number; binaryLength: number; stringPayload: string; binaryReceived: number } | null = null;
  private leftover: Buffer = Buffer.alloc(0);

  private constructor(socket: net.Socket) {
    this.socket = socket;
    socket.on('data', (chunk: Buffer | string) => this.onData(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    socket.on('close', () => {
      this.connected = false;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error('RTA socket closed before response was received'));
      }
      this.pending.clear();
    });
    socket.on('error', () => { /* close handler cleans up */ });
  }

  static connect(host: string, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<RtaClient> {
    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`Timed out connecting to RTA on ${host}:${RTA_PORT}`));
      }, timeoutMs);
      socket.once('error', (err) => { clearTimeout(timer); reject(err); });
      socket.connect(RTA_PORT, host, async () => {
        clearTimeout(timer);
        const client = new RtaClient(socket);
        client.connected = true;
        try {
          await client.send('setSettings', { logLevel: 'info' });
          resolve(client);
        } catch (err) {
          socket.destroy();
          reject(err);
        }
      });
    });
  }

  close(): void {
    try { this.socket.destroy(); } catch { /* ignore */ }
    this.connected = false;
  }

  private onData(chunk: Buffer): void {
    let buf = Buffer.concat([this.leftover, chunk]);
    this.leftover = Buffer.alloc(0);
    while (buf.length > 0) {
      if (!this.incoming) {
        if (buf.length < HEADER_SIZE) { this.leftover = buf; return; }
        this.incoming = {
          stringLength: buf.readInt32LE(0),
          binaryLength: buf.readInt32LE(4),
          stringPayload: '',
          binaryReceived: 0,
        };
        buf = buf.slice(HEADER_SIZE);
      }
      const needString = this.incoming.stringLength - Buffer.byteLength(this.incoming.stringPayload, 'utf-8');
      if (needString > 0) {
        const take = Math.min(needString, buf.length);
        this.incoming.stringPayload += buf.slice(0, take).toString('utf-8');
        buf = buf.slice(take);
        if (Buffer.byteLength(this.incoming.stringPayload, 'utf-8') < this.incoming.stringLength) { this.leftover = buf; return; }
      }
      const needBinary = this.incoming.binaryLength - this.incoming.binaryReceived;
      if (needBinary > 0) {
        const take = Math.min(needBinary, buf.length);
        this.incoming.binaryReceived += take;
        buf = buf.slice(take);
        if (this.incoming.binaryReceived < this.incoming.binaryLength) { this.leftover = buf; return; }
      }
      try {
        const json = JSON.parse(this.incoming.stringPayload);
        const id = json.id as string | undefined;
        if (id && this.pending.has(id)) {
          const p = this.pending.get(id)!;
          this.pending.delete(id);
          clearTimeout(p.timer);
          p.resolve(json);
        }
      } catch { /* ignore malformed */ }
      this.incoming = null;
    }
  }

  send(type: string, args: Record<string, unknown>, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<any> {
    if (!this.connected) return Promise.reject(new Error('RTA client not connected'));
    const id = Math.random().toString(36).slice(2, 14);
    const request = { id, type, args, isRecuring: false };
    const stringPayload = JSON.stringify(request).replace(/[\x00-\x08\x0E-\x1F\x7F-\uFFFF]/g, '');
    const header = Buffer.alloc(HEADER_SIZE);
    header.writeInt32LE(Buffer.byteLength(stringPayload, 'utf-8'), 0);
    header.writeInt32LE(0, 4);
    const body = Buffer.from(stringPayload, 'utf-8');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RTA request \`${type}\` timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(Buffer.concat([header, body]), (err) => {
        if (err) { this.pending.delete(id); clearTimeout(timer); reject(err); }
      });
    });
  }
}

/** Locate the bundled StreamProbe channel directory (ships in dist/assets). */
export function streamProbeDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // here = .../dist/stream ; assets ship to .../dist/assets/streamprobe
  return path.join(here, '..', 'assets', 'streamprobe');
}

export interface LiveCaptureParams {
  host: string;
  password: string;
  url: string;
  format?: string;
  drm?: { keySystem?: string; licenseServerUrl?: string; licenseHeaders?: Record<string, string> };
  /** How long to wait for the stream to error or settle. */
  timeoutMs?: number;
}

export interface LiveCaptureResult {
  error: NormalizedRokuError;
  finalState: string;
  raw: { probeState?: string; probeErrorCode?: number; probeErrorMsg?: string; probeErrorInfo?: string };
}

function getValue(json: any): any {
  if (json && typeof json === 'object') {
    if ('value' in json) return json.value;
    if (json.result && 'value' in json.result) return json.result.value;
  }
  return undefined;
}

/**
 * Deploy StreamProbe, deep-link the stream, and capture the resulting error.
 */
export async function captureLive(params: LiveCaptureParams): Promise<LiveCaptureResult> {
  const timeoutMs = params.timeoutMs ?? 20_000;
  const rootDir = streamProbeDir();

  // 1. Deploy the harness (replaces any running dev channel).
  await rokuDeploy.deploy({
    host: params.host,
    password: params.password,
    rootDir,
    outDir: path.join(os.tmpdir(), 'roku-mcp-streamprobe'),
    files: ['**/*'],
    retainStagingDir: false,
  });

  // 2. Deep-link the stream/DRM into the channel via ECP launch params.
  const launchParams: Record<string, string> = {
    input_url: params.url,
    input_format: params.format ?? 'hls',
  };
  if (params.drm?.keySystem) {
    launchParams.input_drm = params.drm.keySystem;
    if (params.drm.licenseServerUrl) launchParams.input_license_url = params.drm.licenseServerUrl;
    if (params.drm.licenseHeaders) {
      const [name, value] = Object.entries(params.drm.licenseHeaders)[0] ?? [];
      if (name) {
        launchParams.input_license_header_name = name;
        launchParams.input_license_header_value = value ?? '';
      }
    }
  }
  const qs = new URLSearchParams(launchParams).toString();
  await axios.post(`http://${params.host}:8060/launch/dev?${qs}`);

  // 3. Give the channel time to boot + RTA to come up.
  await new Promise((r) => setTimeout(r, 5000));

  // 4. Poll the probe fields until error or timeout.
  const client = await RtaClient.connect(params.host, 8000);
  const raw: LiveCaptureResult['raw'] = {};
  let finalState = 'unknown';
  try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const stateResp = await readField(client, 'probeState');
      const state = typeof stateResp === 'string' ? stateResp : String(stateResp ?? '');
      raw.probeState = state;
      finalState = state || finalState;
      if (state === 'error') {
        raw.probeErrorCode = numberOf(await readField(client, 'probeErrorCode'));
        raw.probeErrorMsg = stringOf(await readField(client, 'probeErrorMsg'));
        raw.probeErrorInfo = stringOf(await readField(client, 'probeErrorInfo'));
        break;
      }
      if (state === 'playing' || state === 'finished') break;
      await new Promise((r) => setTimeout(r, 1000));
    }
  } finally {
    client.close();
  }

  // 5. Normalize the captured error into the shared shape.
  const combined: Record<string, unknown> = {};
  if (raw.probeErrorCode !== undefined) combined.errorCode = raw.probeErrorCode;
  if (raw.probeErrorMsg) combined.errorMsg = raw.probeErrorMsg;
  let errorInfoObj: Record<string, unknown> | undefined;
  if (raw.probeErrorInfo) {
    try { errorInfoObj = JSON.parse(raw.probeErrorInfo); } catch { /* keep as text below */ }
  }
  if (errorInfoObj) combined.errorInfo = errorInfoObj;

  const error = Object.keys(combined).length > 0
    ? normalizeRokuError(combined)
    : normalizeRokuError(raw.probeErrorInfo ?? '');

  return { error, finalState, raw };
}

async function readField(client: RtaClient, field: string): Promise<unknown> {
  const json = await client.send('getValue', { base: 'scene', keyPath: field, field });
  return getValue(json);
}

function numberOf(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
function stringOf(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  return typeof v === 'string' ? v : String(v);
}
