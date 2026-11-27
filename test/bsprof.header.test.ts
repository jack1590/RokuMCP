/**
 * Regression test for the large-file bsprof fast paths.
 *
 * A real .bsprof can be 600+ MB / 70M+ entries, where a full parse takes minutes.
 * bsprof_info now reads ONLY the header (readHeaderInfo) and analyze/compare cache
 * the parsed profile (getProfile). This test builds a tiny but format-valid .bsprof
 * and asserts that:
 *   1. readHeaderInfo (header-only) reports the same header fields as a full parse.
 *   2. getProfile returns the SAME object instance on a repeat call (cache hit).
 *
 * No device or fixture file is needed — the bytes are synthesized here.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { parseBsprof, buildHeaderInfo } from 'bsprof-cli';
import { readHeaderInfo, getProfile } from '../src/sdk/profiler.js';
import { buildBsprof } from './helpers/bsprof-fixture.js';

test('readHeaderInfo (header-only) matches a full parse on header fields', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bsprof-'));
  const file = path.join(dir, 'tiny.bsprof');
  writeFileSync(file, buildBsprof());

  const fast = readHeaderInfo(file);
  const full = buildHeaderInfo(parseBsprof(buildBsprof()));

  for (const k of ['targetName', 'targetVersion', 'device', 'firmware', 'formatVersion'] as const) {
    assert.equal(fast[k], full[k], `header field ${k} should match the full parse`);
  }
  assert.equal(fast.device, 'Roku TestModel');
  assert.equal(fast.formatVersion, 'v3.0.0');
  assert.deepEqual(fast.features, ['line-specific-data', 'memory-operations']);
});

test('getProfile caches the parsed profile across repeat calls', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bsprof-'));
  const file = path.join(dir, 'tiny.bsprof');
  writeFileSync(file, buildBsprof());

  const first = getProfile(file);
  const second = getProfile(file);
  assert.equal(first, second, 'second call should return the cached instance');
});
