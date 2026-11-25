import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The plugins launch the published package by exact version; a stale pin ships the old server.
test('plugin launchers pin the package.json version', () => {
  const read = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
  const pin = `roku-mcp@${read('package.json').version}`;
  for (const file of ['plugin/.mcp.json', 'mcp.json']) {
    assert.deepEqual(read(file).mcpServers.roku.args, ['-y', pin], file);
  }
  assert.equal(read('plugin/.claude-plugin/plugin.json').version, read('package.json').version);
});
