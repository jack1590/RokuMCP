import net from 'net';
import type { Duplex } from 'stream';
import axios from 'axios';
import { z } from 'zod';
import { RceError, type RceDevice, type RceInstance } from 'roku-rce';
import { discoverFirstHost } from './discovery.js';
import { rceClient, rcePassword } from './rce.js';
import { RokuError } from './sdk/errors.js';

const HOST_VARS = ['ROKU_DEVICE_HOST', 'ROKU_IP', 'ROKU_HOST', 'ROKU_DEV_TARGET'];
const PASSWORD_VARS = ['ROKU_DEVICE_PASSWORD', 'ROKU_DEV_PASSWORD', 'ROKU_PASSWORD'];

/** First non-empty variable in order; canonical name is listed first so it wins. */
export function firstEnv(names: string[], env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const n of names) if (env[n]) return env[n];
  return undefined;
}
export const envHost = (env?: NodeJS.ProcessEnv) => firstEnv(HOST_VARS, env);
export const envPassword = (env?: NodeJS.ProcessEnv) => firstEnv(PASSWORD_VARS, env);

const HOST_HINT = 'set ROKU_DEVICE_HOST (aliases: ROKU_IP, ROKU_HOST, ROKU_DEV_TARGET) in your .env file';
const PASSWORD_HINT = 'set ROKU_DEVICE_PASSWORD (aliases: ROKU_DEV_PASSWORD, ROKU_PASSWORD) in your .env file';

/** ECP timeouts: the UI tree queries can be slow on large scenes. */
export const ECP_TIMEOUT_MS = 10_000;
export const ECP_TREE_TIMEOUT_MS = 30_000;
const ECP_MAX_BYTES = 32 * 1024 * 1024;

// Shared tool parameters for every device-facing tool.
export const targetParams = {
  host: z.string().optional().describe('IP address or hostname of a Roku device on the LAN. Takes precedence over rceDevice and ROKU_RCE_DEVICE.'),
  rceDevice: z
    .string()
    .optional()
    .describe('Roku Cloud Emulator Cloud Device id or exact name (defaults to ROKU_RCE_DEVICE). The device must have a running Run (see roku_rce_start).'),
};
export const passwordParam = z
  .string()
  .optional()
  .describe('Developer password. Defaults to ROKU_RCE_PASSWORD for a Cloud Device, and to ROKU_DEVICE_PASSWORD (or its aliases) otherwise.');

// Tool annotation presets (MCP defaults destructiveHint to true, so it is always set explicitly).
export const READ_ONLY = { readOnlyHint: true, destructiveHint: false } as const;
export const WRITES = { readOnlyHint: false, destructiveHint: false } as const;
export const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true } as const;

export interface TargetParams {
  host?: string;
  rceDevice?: string;
  password?: string;
}

export type TargetChoice = { kind: 'lan'; host?: string } | { kind: 'rce'; ref: string };

/** Precedence: host param > rceDevice param > ROKU_RCE_DEVICE > host env (+ aliases) > SSDP (host left undefined). */
export function pickTarget(params: TargetParams, env: NodeJS.ProcessEnv = process.env): TargetChoice {
  if (params.host) return { kind: 'lan', host: params.host };
  const ref = params.rceDevice || env.ROKU_RCE_DEVICE;
  if (ref) return { kind: 'rce', ref };
  return { kind: 'lan', host: envHost(env) };
}

/** Cloud Devices: param > ROKU_RCE_PASSWORD > device password env. LAN devices never read ROKU_RCE_PASSWORD. */
export function pickPassword(kind: 'lan' | 'rce', param?: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return kind === 'rce' ? rcePassword(param, env) : param || envPassword(env);
}

/** One resolved device, LAN or Roku Cloud Emulator, behind the same calls. */
export interface RokuTarget {
  kind: 'lan' | 'rce';
  /** Human-readable name for messages: the host, or "Cloud Device <id> (<name>)". */
  label: string;
  /** LAN only. */
  host?: string;
  password?: string;
  /** RCE only. */
  rce?: { device: RceDevice; instance: RceInstance };
  /** An ECP command; resolves with the response body. */
  ecp(path: string, options?: { method?: 'GET' | 'POST'; timeoutMs?: number }): Promise<string>;
  /** A remote key (ECP on LAN; the Instance API on RCE, because ECP keypress is 403 in Limited mode). */
  keypress(key: string): Promise<void>;
  /** A raw TCP stream to a device port (net.Socket on LAN; a WebSocket bridge on RCE). */
  connect(port: number, timeoutMs?: number): Promise<Duplex>;
}

/** Message for a tool that cannot run against a Cloud Device, or undefined when the target is not RCE. */
export function rceUnsupported(params: TargetParams, tool: string, alternative: string): string | undefined {
  return pickTarget(params).kind === 'rce'
    ? `${tool} is not supported on Roku Cloud Emulator devices. ${alternative}`
    : undefined;
}

let discoverHost: () => Promise<string | null> = discoverFirstHost;

/** Tests only: replace SSDP discovery of the default LAN host. */
export function setHostDiscovery(fn: () => Promise<string | null>): void {
  discoverHost = fn;
}

export async function resolveTarget(params: TargetParams, options: { needPassword?: boolean } = {}): Promise<RokuTarget> {
  const choice = pickTarget(params);
  const password = pickPassword(choice.kind, params.password);

  if (choice.kind === 'rce') {
    if (options.needPassword && !password) {
      throw new RokuError('password_required', 'The Cloud Device developer password is required. Pass `password` or set ROKU_RCE_PASSWORD in your .env file.');
    }
    const client = rceClient(params.password);
    const device = await client.findDevice(choice.ref);
    const instance = client.instance(device);
    return {
      kind: 'rce',
      label: `Cloud Device ${device.id} (${device.name})`,
      password,
      rce: { device, instance },
      ecp: (path, o) => instance.ecp(path, o?.method ?? 'GET', { timeoutMs: o?.timeoutMs ?? ECP_TIMEOUT_MS }),
      // Roku wants the character after Lit_ URL-encoded; roku-rce leaves '%' as is, so encode it here.
      keypress: (key) => instance.keypress(key.replace(/%/g, '%25')),
      connect: (port, timeoutMs) => instance.openBridge(port, { timeoutMs }),
    };
  }

  const host = choice.host || (await discoverHost());
  if (!host) {
    throw new RokuError(
      'no_device',
      `No Roku device found. Please provide the device IP as a parameter, ${HOST_HINT}, set ROKU_RCE_DEVICE (or pass rceDevice) for a Roku Cloud Emulator device, or make sure a Roku device is powered on and connected to the same network.`
    );
  }
  if (options.needPassword && !password) {
    throw new RokuError('password_required', `Roku developer password is required. Please provide the password as a parameter or ${PASSWORD_HINT}.`);
  }
  const ecp: RokuTarget['ecp'] = async (path, o) => {
    const timeout = o?.timeoutMs ?? ECP_TIMEOUT_MS;
    let response;
    try {
      response = await axios.request({
        url: `http://${host}:8060/${path}`,
        method: o?.method ?? 'GET',
        timeout,
        // axios's timeout is an idle timeout (a host that drips bytes never trips it): the signal is a
        // wall-clock backstop a little later, and no ECP reply is anywhere near 32 MiB.
        signal: AbortSignal.timeout(timeout + 1000),
        maxContentLength: ECP_MAX_BYTES,
      });
    } catch (error) {
      // Report the backstop like axios's own timeout, so the messages stay as before.
      if (axios.isCancel(error)) throw Object.assign(new Error(`timeout of ${timeout}ms exceeded`), { code: 'ECONNABORTED' });
      throw error;
    }
    return typeof response.data === 'string' ? response.data : String(response.data ?? '');
  };
  return {
    kind: 'lan',
    label: host,
    host,
    password,
    ecp,
    keypress: async (key) => {
      await ecp(`keypress/${encodeURIComponent(key)}`, { method: 'POST' });
    },
    connect: (port, timeoutMs = 10_000) =>
      new Promise((resolve, reject) => {
        const socket = net.connect(port, host);
        const timer = setTimeout(() => {
          socket.destroy();
          reject(new Error(`Connection to ${host}:${port} timed out`));
        }, timeoutMs);
        socket.once('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
        socket.once('connect', () => {
          clearTimeout(timer);
          resolve(socket);
        });
      }),
  };
}

const PORT_SERVICES: Record<string, string> = {
  '80': 'developer web installer, port 80',
  '8060': 'ECP, port 8060',
  '8080': 'port 8080',
  '8085': 'BrightScript debug console, port 8085',
  '9000': 'RTA On-Device Component, port 9000',
};

/** Whether the device answered 404 (ECP over HTTP on LAN, the Instance API on RCE). */
export function isNotFound(error: unknown): boolean {
  if (error instanceof RceError) return error.status === 404;
  const raw = error instanceof Error ? error.message : String(error);
  return (axios.isAxiosError(error) && error.response?.status === 404) || /status code 404/.test(raw);
}

export function friendlyError(error: unknown, options: { notFound?: string } = {}): string {
  if (options.notFound && isNotFound(error)) return options.notFound;
  if (error instanceof RceError) {
    // roku-rce messages are written for people and never carry the token.
    if (error.code === 'not_running') return `${error.message}. Check it with roku_rce_status, or start a Run with roku_rce_start.`;
    return `${error.message}${error.code ? ` (RCE: ${error.code})` : ''}`;
  }
  const raw = error instanceof Error ? error.message : String(error);
  const status = axios.isAxiosError(error) ? error.response?.status : undefined;
  if (status === 401 || /401|unauthorized/i.test(raw)) {
    return 'Authentication failed — the Roku developer password is incorrect. Please provide the correct password.';
  }
  if (status === 403 || /403|forbidden/i.test(raw)) {
    return 'Access denied by the Roku device. Make sure Developer Mode is enabled and the password is correct.';
  }
  const refused = raw.match(/ECONNREFUSED\s+(\S+?):(\d+)/);
  if (refused || /ECONNREFUSED/i.test(raw)) {
    const where = refused ? ` at ${refused[1]} (${PORT_SERVICES[refused[2]] ?? `port ${refused[2]}`})` : '';
    return `Connection refused${where} — the service is not listening. Verify the IP address is correct, the device is powered on, and the service is enabled.`;
  }
  if (/ETIMEDOUT|ESOCKETTIMEDOUT|time(d )?out/i.test(raw)) {
    return 'Connection timed out — the Roku device did not respond. Check that it is on the same network and not blocked by a firewall.';
  }
  if (/ENOTFOUND|getaddrinfo/i.test(raw)) {
    return `Could not resolve the Roku device hostname. Verify the host address is correct.`;
  }
  if (/No screen shot url/i.test(raw)) {
    return 'Screenshot failed — no sideloaded dev channel is currently running on the device. Deploy an app first.';
  }

  return raw;
}
