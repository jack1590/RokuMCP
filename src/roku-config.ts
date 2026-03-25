export interface RokuDeviceConfig {
  host: string;
  password: string;
}

export function resolveConfig(params: { host?: string; password?: string }): RokuDeviceConfig {
  const host = params.host || process.env.ROKU_DEVICE_HOST;
  const password = params.password || process.env.ROKU_DEVICE_PASSWORD;

  if (!host) {
    throw new Error(
      'Roku device host is required. Provide it as a tool parameter or set ROKU_DEVICE_HOST environment variable.'
    );
  }
  if (!password) {
    throw new Error(
      'Roku device password is required. Provide it as a tool parameter or set ROKU_DEVICE_PASSWORD environment variable.'
    );
  }

  return { host, password };
}

export function resolveHost(params: { host?: string }): string {
  const host = params.host || process.env.ROKU_DEVICE_HOST;
  if (!host) {
    throw new Error(
      'Roku device host is required. Provide it as a tool parameter or set ROKU_DEVICE_HOST environment variable.'
    );
  }
  return host;
}
