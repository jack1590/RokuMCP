import test from 'node:test';
import assert from 'node:assert/strict';
import { overlaps } from '../src/sdk/deploy.js';

test('deploy staging guard: rejects the same folder, either inside the other, and case variants', () => {
  assert.equal(overlaps('/p/app/dist', '/p/app/dist'), true);
  assert.equal(overlaps('/p/app/dist/staging', '/p/app/dist'), true);
  assert.equal(overlaps('/p/app', '/p/app/dist'), true);
  assert.equal(overlaps('/P/App/Dist/x', '/p/app/dist'), true);
  assert.equal(overlaps('/', '/p/app'), true);
  assert.equal(overlaps('/tmp/roku-mcp-staging-1', '/p/app/dist'), false);
  assert.equal(overlaps('/p/app/dist-staging', '/p/app/dist'), false);
  assert.equal(overlaps('/p/..dist', '/p/app'), false);
});
