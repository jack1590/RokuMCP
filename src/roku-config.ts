import { discoverFirstHost } from './discovery.js';

export interface RokuDeviceConfig {
  host: string;
  password: string;
}

export async function resolveConfig(params: { host?: string; password?: string }): Promise<RokuDeviceConfig> {
  const host = params.host || process.env.ROKU_DEVICE_HOST || await discoverFirstHost();
  const password = params.password || process.env.ROKU_DEVICE_PASSWORD;

  if (!host) {
    throw new Error(
      'No Roku device found. Please provide the device IP as a parameter, set ROKU_DEVICE_HOST in your .env file, or make sure a Roku device is powered on and connected to the same network.'
    );
  }
  if (!password) {
    throw new Error(
      'Roku developer password is required. Please provide the password as a parameter or set ROKU_DEVICE_PASSWORD in your .env file.'
    );
  }

  return { host, password };
}

export async function resolveHost(params: { host?: string }): Promise<string> {
  const host = params.host || process.env.ROKU_DEVICE_HOST || await discoverFirstHost();
  if (!host) {
    throw new Error(
      'No Roku device found. Please provide the device IP as a parameter, set ROKU_DEVICE_HOST in your .env file, or make sure a Roku device is powered on and connected to the same network.'
    );
  }
  return host;
}

export function friendlyError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);

  if (/401|unauthorized/i.test(raw)) {
    return 'Authentication failed — the Roku developer password is incorrect. Please provide the correct password.';
  }
  if (/403|forbidden/i.test(raw)) {
    return 'Access denied by the Roku device. Make sure Developer Mode is enabled and the password is correct.';
  }
  if (/ECONNREFUSED/i.test(raw)) {
    return `Connection refused — the Roku device is not reachable. Verify the IP address is correct and the device is powered on.`;
  }
  if (/ETIMEDOUT|ESOCKETTIMEDOUT|timeout/i.test(raw)) {
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
