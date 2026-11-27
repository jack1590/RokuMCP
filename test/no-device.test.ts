import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { setHostDiscovery } from '../src/roku-config.js';
import { buildServer } from '../src/index.js';

const RTA_HINT = '\n\nThis tool talks to the roku-test-automation (RTA) On-Device Component on TCP port 9000.';
const NO_DEVICE = 'No Roku device found. Please provide the device IP as a parameter, set ROKU_DEVICE_HOST';

test('no device found: same texts as v1.9.0, RTA tools keep their setup hint', async () => {
  const keys = ['ROKU_DEVICE_HOST', 'ROKU_IP', 'ROKU_HOST', 'ROKU_DEV_TARGET', 'ROKU_RCE_DEVICE', 'ROKU_RCE_TOKEN'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  setHostDiscovery(async () => null);
  const server = buildServer();
  const client = new Client({ name: 'no-device', version: '0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const text = async (name: string, args: Record<string, unknown>) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
    assert.equal(r.isError, true, name);
    return r.content[0].text;
  };
  try {
    assert.ok((await text('roku_keypress', { key: 'Home' })).startsWith(`Key press failed: ${NO_DEVICE}`));
    for (const [tool, args, prefix] of [
      ['roku_get_value', { keyPath: 'a.b' }, 'Get value failed'],
      ['roku_edit_node', { nodeId: 'RTA_1', fields: { text: 'x' } }, 'Edit node failed'],
      ['roku_observe_field', { keyPath: 'a.b' }, 'Observe field failed'],
    ] as const) {
      const t = await text(tool, args);
      assert.ok(t.startsWith(`${prefix}: ${NO_DEVICE}`), t);
      assert.ok(t.includes(RTA_HINT), `${tool} lost the RTA hint`);
    }
    // Missing token for a Cloud Device: the message as before, plus the RTA hint on RTA tools.
    process.env.ROKU_RCE_DEVICE = '400';
    const t = await text('roku_get_value', { keyPath: 'a.b' });
    assert.ok(t.startsWith('Get value failed: Roku Cloud Emulator needs ROKU_RCE_TOKEN'), t);
    assert.ok(t.includes(RTA_HINT));
  } finally {
    await client.close();
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});
