/**
 * Fake Roku device services for the parity harness: ECP (HTTP), the debug console and the
 * RTA On-Device Component (TCP), and a stub Roku Cloud Emulator client. Every request the
 * fakes receive is appended to `calls`, so the harness can compare behaviour, not only text.
 */
import http from 'node:http';
import net from 'node:net';
import { Duplex } from 'node:stream';
import { RceError, type RceDevice } from 'roku-rce';
import type { RceClientLike } from '../../src/rce.js';

export const APP_UI = `<?xml version="1.0" encoding="UTF-8" ?>
<app-ui>
  <topscreen>
    <plugin id="dev" name="Parity"/>
    <screen focused="true" type="RoScreen">
      <MainScene name="MainScene" uiElementId="RTA_1" focused="true">
        <Label name="title" uiElementId="RTA_2" text="Hello" visible="true" bounds="{0, 0, 100, 20}"/>
        <Group id="menu" name="menu" uiElementId="RTA_3">
          <Button name="play" uiElementId="RTA_4" text="Play" focused="true"/>
          <Button name="info" uiElementId="RTA_5" text="Info"/>
        </Group>
      </MainScene>
    </screen>
  </topscreen>
</app-ui>`;

const ECP_BODIES: Record<string, string> = {
  'query/device-info': '<device-info><model-name>Roku Ultra</model-name><software-version>15.1.4</software-version><serial-number>X0001</serial-number></device-info>',
  'query/active-app': '<active-app><app id="dev" type="appl" version="1.0.0">Parity</app></active-app>',
  'query/app-ui': APP_UI,
  'query/sgnodes/all': '<sgnodes><All><MainScene/></All></sgnodes>',
  'query/sgnodes/roots': '<sgnodes><Roots><MainScene/><RTA_OnDeviceComponent/></Roots></sgnodes>',
  'query/sgnodes/nodes/RTA_2': '<sgnodes><Label name="title"/></sgnodes>',
  'query/media-player': '<player error="false" state="play"><format audio="aac" video="mpeg4 avc"/><position>1500 ms</position><duration>60000 ms</duration></player>',
  'perfetto/enable/dev': '<perfetto-enable><status>OK</status><enabled-channels><channel>dev</channel></enabled-channels><timestamp>1</timestamp></perfetto-enable>',
};

/** Shared, mutable scenario state for every fake. */
export class FakeWorld {
  calls: string[] = [];
  /** ECP path (no query string) -> HTTP status to answer instead of 200. */
  ecpStatus: Record<string, number> = {};
  /** ECP path (no query string) -> body to answer instead of the fixture. */
  ecpBody: Record<string, string> = {};
  /** When false, the RTA fake drops every connection. */
  rtaUp = true;
  /** RTA request types the fake never answers (to exercise timeouts). */
  rtaSilent = new Set<string>();
  /** Device ports the RCE stub answers with a closed-port error. */
  closedPorts = new Set<number>();
  /** Cloud Device ids whose Run never becomes ready. */
  readyFails = new Set<number>();
  /** Opt-in: start/stop change the stub devices' Run state, and startedHere tracks Runs it started. */
  trackRuns = false;
  /** With trackRuns: how long waitUntilReady takes. */
  readyDelayMs = 0;
  private consoles = new Set<{ push: (s: string) => void }>();

  log(entry: string): void {
    this.calls.push(entry);
  }

  /** Text every open console connection receives. */
  consoleEmit(text: string): void {
    for (const c of this.consoles) c.push(text);
  }

  ecpAnswer(method: string, rawPath: string): { status: number; body: string } {
    const p = rawPath.replace(/^\//, '');
    this.log(`ecp ${method} ${p}`);
    const bare = p.split('?')[0];
    if (this.ecpStatus[bare]) return { status: this.ecpStatus[bare], body: '' };
    if (this.ecpBody[bare] !== undefined) return { status: 200, body: this.ecpBody[bare] };
    if (method === 'POST') return { status: 200, body: ECP_BODIES[bare] ?? '' };
    return ECP_BODIES[bare] !== undefined ? { status: 200, body: ECP_BODIES[bare] } : { status: 404, body: '' };
  }

  /** Wires a console endpoint: replays one old line on connect, answers `bt`. */
  attachConsole(label: string, write: (s: string) => void, onClose: (fn: () => void) => void): (chunk: Buffer) => void {
    const handle = { push: write };
    this.consoles.add(handle);
    onClose(() => this.consoles.delete(handle));
    this.log(`console ${label} connect`);
    write('old session line\n');
    return (chunk) => {
      const cmd = chunk.toString().trim();
      this.log(`console ${label} recv ${JSON.stringify(cmd)}`);
      if (cmd === 'bt') write('Backtrace:\n#0  Function main() As Void\n');
    };
  }

  /** Wires an RTA endpoint speaking the length-prefixed JSON protocol. */
  attachRta(label: string, write: (b: Buffer) => void, destroy: () => void): (chunk: Buffer) => void {
    if (!this.rtaUp) {
      this.log(`rta ${label} refused`);
      setImmediate(destroy);
      return () => {};
    }
    let buf = Buffer.alloc(0);
    return (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 8) {
        const len = buf.readInt32LE(0);
        const bin = buf.readInt32LE(4);
        if (buf.length < 8 + len + bin) return;
        const req = JSON.parse(buf.subarray(8, 8 + len).toString('utf8'));
        buf = buf.subarray(8 + len + bin);
        this.log(`rta ${label} ${req.type} ${JSON.stringify(req.args)}`);
        if (this.rtaSilent.has(req.type)) continue;
        const body = JSON.stringify({ id: req.id, ...rtaResponse(req.type, req.args) });
        const header = Buffer.alloc(8);
        header.writeInt32LE(Buffer.byteLength(body), 0);
        header.writeInt32LE(0, 4);
        write(Buffer.concat([header, Buffer.from(body)]));
      }
    };
  }
}

function rtaResponse(type: string, args: Record<string, unknown>): Record<string, unknown> {
  if (String(args.keyPath ?? '').includes('missing')) return { error: { message: `No node at ${args.keyPath}` } };
  switch (type) {
    case 'getValue':
      return { found: true, value: 'Hello', timeTaken: 3 };
    case 'onFieldChangeOnce':
      return { observerFired: true, value: args.match ?? 'changed', timeTaken: 5 };
    default:
      return { timeTaken: 1 };
  }
}

/** An in-memory socket: what the code writes goes to `onWrite`; `push` delivers device data. */
function memorySocket(onWrite: (chunk: Buffer) => void): Duplex {
  return new Duplex({
    read() {},
    write(chunk, _enc, cb) {
      onWrite(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      cb();
    },
  });
}

export interface LanFakes {
  close(): Promise<void>;
}

/** ECP on 127.0.0.1:8060, console on 8085 and RTA on 9000. Port 80 stays closed on purpose. */
export async function startLanFakes(world: FakeWorld): Promise<LanFakes> {
  const ecp = http.createServer((req, res) => {
    const { status, body } = world.ecpAnswer(req.method ?? 'GET', req.url ?? '/');
    res.writeHead(status, { 'content-type': 'text/xml' });
    res.end(body);
  });
  const consoleServer = net.createServer((s) => {
    const onData = world.attachConsole('lan', (t) => s.write(t), (fn) => s.on('close', fn));
    s.on('data', onData);
    s.on('error', () => {});
  });
  const rta = net.createServer((s) => {
    const onData = world.attachRta('lan', (b) => s.write(b), () => s.destroy());
    s.on('data', onData);
    s.on('error', () => {});
  });
  const servers: Array<[http.Server | net.Server, number]> = [[ecp, 8060], [consoleServer, 8085], [rta, 9000]];
  for (const [server, port] of servers) {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => resolve());
    });
  }
  return {
    close: () =>
      Promise.all(
        servers.map(([s]) => new Promise<void>((r) => {
          (s as net.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
          s.close(() => r());
        }))
      ).then(() => undefined),
  };
}

const RUN = {
  id: 9001,
  created_at: '2026-01-01T00:00:00.000Z',
  started_at: '2026-01-01T00:00:10.000Z',
  running_at: '2026-01-01T00:00:30.000Z',
  snapshot_id: 1126,
  snapshot_name: 'dev-mode',
  max_runtime: 3600,
};

export function rceDevices(): RceDevice[] {
  return [
    { id: 400, name: 'Parity_1', device_type: 'stb', status: 'running', running_device: { ...RUN }, last_snapshot_id: 1126, last_snapshot_name: 'dev-mode', firmware_version_display_name: '15.1.4' },
    { id: 401, name: 'Parity_2', device_type: 'tv', status: 'shutdown', running_device: null, last_snapshot_id: 1128, last_snapshot_name: null, firmware_version_id: 'fw-1' },
    { id: 402, name: 'Parity_3', device_type: 'stb', status: 'shutdown', running_device: null },
  ];
}

/** A stub RceClientLike: the Instance API answers from the same FakeWorld as the LAN fakes. */
export function stubRce(world: FakeWorld): RceClientLike {
  const devices = rceDevices();
  const started = new Set<number>();
  const find = (ref: string | number) => {
    const d = devices.find((x) => String(x.id) === String(ref) || x.name === ref);
    if (!d) throw new RceError(`No Cloud Device matches "${ref}"`, { code: 'not_found' });
    return d;
  };
  const instance = (device: RceDevice) => ({
    ecp: async (p: string, method: string, o?: { timeoutMs?: number }) => {
      const { status, body } = world.ecpAnswer(method, p);
      world.log(`rce ecp timeout ${o?.timeoutMs}`);
      if (status === 403) throw new RceError('ECP command not allowed in Limited mode.', { status, code: 'ecp_forbidden' });
      if (status !== 200) throw new RceError(`ECP ${p} answered ${status}`, { status });
      return body;
    },
    keypress: async (key: string) => world.log(`rce keypress ${key}`),
    openBridge: async (port: number) => {
      world.log(`rce bridge ${device.id} ${port}`);
      if (world.closedPorts.has(port)) throw new RceError(`nothing listens on device port ${port}`, { status: 502, code: 'port_closed' });
      let onData: (c: Buffer) => void = () => {};
      const socket = memorySocket((c) => onData(c));
      if (port === 8085) onData = world.attachConsole('rce', (t) => socket.push(t), (fn) => socket.on('close', fn));
      else if (port === 9000) onData = world.attachRta('rce', (b) => socket.push(b), () => socket.destroy());
      return socket;
    },
    install: async (zip: Buffer, name?: string) => {
      world.log(`rce install ${name} ${zip.length > 0 ? 'zip' : 'empty'}`);
      return { outcome: device.id === 402 ? 'identical' : 'installed', messages: [] };
    },
    deleteDevChannel: async () => {
      world.log('rce delete');
      return [];
    },
    screenshot: async () => {
      world.log('rce screenshot');
      return { data: Buffer.from('89504e470d0a1a0a', 'hex'), extension: 'png', contentType: 'image/png' };
    },
  });
  return {
    listDevices: async () => devices,
    findDevice: async (ref: string | number) => find(ref),
    listSnapshots: async (id: number) => [
      { id: 1126, name: 'dev-mode', created_at: '2026-01-01T00:00:00Z', ready: true, live: id === 400, base: false },
      { id: 1, name: 'base', created_at: '2025-01-01T00:00:00Z', ready: true, live: false, base: true },
    ],
    start: async (id: number, o: unknown) => {
      world.log(`rce start ${id} ${JSON.stringify(o)}`);
      if (world.trackRuns) {
        const d = find(id);
        const run = { ...RUN, id: 9500 + id, created_at: new Date().toISOString() };
        Object.assign(d, { status: 'running', running_device: run });
        started.add(run.id);
      }
      return {} as never;
    },
    stop: async (id: number, o: unknown) => {
      world.log(`rce stop ${id} ${JSON.stringify(o)}`);
      if (world.trackRuns) Object.assign(find(id), { status: 'shutdown', running_device: null });
    },
    waitUntilReady: async (id: number) => {
      if (world.trackRuns) {
        await new Promise((r) => setTimeout(r, world.readyDelayMs));
        return find(id);
      }
      if (world.readyFails.has(id)) throw new RceError('Run did not take input within 240 s', { code: 'timeout' });
      const d = find(id);
      return { ...d, status: 'running', running_device: { ...RUN, id: 9100 + id } };
    },
    waitUntilShutdown: async (id: number) => ({ ...find(id), status: 'shutdown', running_device: null }),
    startedHere: (d: RceDevice) => (world.trackRuns ? !!d.running_device && started.has(d.running_device.id) : d.id === 401),
    stopStartedRuns: async () => ({ stopped: [], ended: [], failed: [] }),
    instance: (d: RceDevice) => instance(d),
  } as unknown as RceClientLike;
}
