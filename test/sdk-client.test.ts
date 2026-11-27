import test from 'node:test';
import assert from 'node:assert/strict';
import { setRceClientFactory } from '../src/rce.js';
import { createRoku, RokuError } from '../src/sdk/index.js';
import { FakeWorld, stubRce } from './helpers/fakes.js';

test('createRoku binds the default target and returns data, not MCP text', async () => {
  const saved = process.env.ROKU_RCE_DEVICE;
  delete process.env.ROKU_RCE_DEVICE;
  const world = new FakeWorld();
  setRceClientFactory(() => stubRce(world));
  try {
    const roku = createRoku({ rceDevice: '400' });
    await roku.input.keypress({ key: 'Home' });
    assert.deepEqual(world.calls, ['rce keypress Home']);

    const nodes = await roku.ui.findNode({ attr: 'text', value: 'Play' });
    assert.deepEqual(nodes, [{ name: 'play', uiElementId: 'RTA_4', text: 'Play', focused: 'true' }]);

    // A per-call target overrides the default.
    const other = await roku.rce.status({ rceDevice: '401' });
    assert.equal(other.id, 401);
    assert.equal((await roku.rce.status()).id, 400);

    await assert.rejects(roku.ui.findNode({}), (e: unknown) => e instanceof RokuError && e.code === 'bad_args' && e.bare);
    world.ecpStatus['query/app-ui'] = 404;
    await assert.rejects(roku.ui.appUi(), (e: unknown) => e instanceof RokuError && e.code === 'no_dev_channel');
  } finally {
    if (saved !== undefined) process.env.ROKU_RCE_DEVICE = saved;
  }
});
