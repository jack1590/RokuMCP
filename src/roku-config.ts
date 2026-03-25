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
      'Roku device host is required. Provide it as a tool parameter, set ROKU_DEVICE_HOST environment variable, or ensure a Roku device is discoverable on the network.'
    );
  }
  if (!password) {
    throw new Error(
      'Roku device password is required. Provide it as a tool parameter or set ROKU_DEVICE_PASSWORD environment variable.'
    );
  }

  return { host, password };
}

export async function resolveHost(params: { host?: string }): Promise<string> {
  const host = params.host || process.env.ROKU_DEVICE_HOST || await discoverFirstHost();
  if (!host) {
    throw new Error(
      'Roku device host is required. Provide it as a tool parameter, set ROKU_DEVICE_HOST environment variable, or ensure a Roku device is discoverable on the network.'
    );
  }
  return host;
}
