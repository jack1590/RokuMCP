import dgram from 'dgram';

export interface DiscoveredDevice {
  host: string;
  location: string;
  usn: string;
}

const SSDP_ADDRESS = '239.255.255.250';
const SSDP_PORT = 1900;
const SEARCH_TARGET = 'roku:ecp';

const M_SEARCH =
  `M-SEARCH * HTTP/1.1\r\n` +
  `HOST: ${SSDP_ADDRESS}:${SSDP_PORT}\r\n` +
  `MAN: "ssdp:discover"\r\n` +
  `ST: ${SEARCH_TARGET}\r\n` +
  `MX: 3\r\n\r\n`;

let cachedHost: string | null = null;

function parseLocation(response: string): string | null {
  const match = /^LOCATION:\s*(.+)/im.exec(response);
  return match ? match[1].trim() : null;
}

function parseUsn(response: string): string {
  const match = /^USN:\s*(.+)/im.exec(response);
  return match ? match[1].trim() : '';
}

function extractHost(locationUrl: string): string {
  try {
    const url = new URL(locationUrl);
    return url.hostname;
  } catch {
    const match = /\/\/([^:/]+)/i.exec(locationUrl);
    return match ? match[1] : locationUrl;
  }
}

export async function discoverRokuDevices(timeoutMs = 3000): Promise<DiscoveredDevice[]> {
  return new Promise((resolve) => {
    const devices: DiscoveredDevice[] = [];
    const seen = new Set<string>();
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    const timeout = setTimeout(() => {
      socket.close();
      resolve(devices);
    }, timeoutMs);

    socket.on('message', (msg) => {
      const response = msg.toString();
      if (!response.toLowerCase().includes('roku')) return;

      const location = parseLocation(response);
      if (!location) return;

      const host = extractHost(location);
      if (seen.has(host)) return;
      seen.add(host);

      devices.push({
        host,
        location,
        usn: parseUsn(response),
      });
    });

    socket.on('error', () => {
      clearTimeout(timeout);
      socket.close();
      resolve(devices);
    });

    socket.bind(() => {
      const message = Buffer.from(M_SEARCH);
      socket.send(message, 0, message.length, SSDP_PORT, SSDP_ADDRESS);
    });
  });
}

export async function discoverFirstHost(): Promise<string | null> {
  if (cachedHost) return cachedHost;

  const devices = await discoverRokuDevices();
  if (devices.length > 0) {
    cachedHost = devices[0].host;
    return cachedHost;
  }
  return null;
}

export function clearDiscoveryCache(): void {
  cachedHost = null;
}
