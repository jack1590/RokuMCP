/**
 * Regression test for roku_diagnose_stream.
 *
 * Every expectation below is anchored to behavior VERIFIED ON A REAL DEVICE
 * (Roku Ultra 4850X, OS 15.2.4) using the StreamProbe harness + ECP
 * media-player query. See test-streams/README.md for the captured evidence.
 *
 * The test serves the real test-streams/ fixtures over a throwaway localhost
 * HTTP server so loadManifest() exercises the true production path — including
 * the child-media-playlist fetch that resolves the fMP4-vs-TS container. No Roku
 * device and no external network are required, so it is CI-safe.
 *
 * Run: npm test  (builds, then runs the compiled suite with node --test)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';

import { loadManifest } from '../src/stream/manifest.js';
import { diagnose, type Finding } from '../src/stream/diagnose.js';
import { normalizeRokuError } from '../src/stream/error-info.js';

// test/ is compiled to dist/test/, so test-streams/ is three levels up.
const here = path.dirname(fileURLToPath(import.meta.url));
const streamsDir = path.resolve(here, '..', '..', 'test-streams');

const MIME: Record<string, string> = {
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.mp4': 'video/mp4',
  '.m4s': 'video/iso.segment',
};

let server: http.Server;
let base: string;

test.before(async () => {
  server = http.createServer(async (req, res) => {
    try {
      const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
      const filePath = path.join(streamsDir, urlPath);
      // Contain within streamsDir.
      if (!filePath.startsWith(streamsDir)) { res.statusCode = 403; return res.end(); }
      const s = await stat(filePath);
      if (!s.isFile()) { res.statusCode = 404; return res.end(); }
      res.setHeader('Content-Type', MIME[path.extname(filePath)] ?? 'application/octet-stream');
      createReadStream(filePath).pipe(res);
    } catch {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

test.after(() => { server.close(); });

/** Convenience: diagnose a fixture by URL (+ optional device errorInfo). */
async function diagnoseFixture(fixture: string, errorInfo?: string) {
  const manifest = await loadManifest({ url: `${base}/${fixture}/master.m3u8`, format: 'hls' });
  const error = errorInfo ? normalizeRokuError(errorInfo) : undefined;
  return { manifest, diagnosis: diagnose({ manifest, error: error && !error.empty ? error : undefined }) };
}

function ids(findings: Finding[]): string[] {
  return findings.map((f) => f.id);
}
function find(findings: Finding[], id: string): Finding | undefined {
  return findings.find((f) => f.id === id);
}

// ---------------------------------------------------------------------------
// Muxed fMP4 = silent on Roku (device: audio="none"), even with supported AAC.
// ---------------------------------------------------------------------------
test('muxed-fmp4 AAC -> high-confidence muxed-fmp4-no-audio (silent)', async () => {
  const { manifest, diagnosis } = await diagnoseFixture('muxed-fmp4-hls');
  assert.equal(manifest.container, 'fmp4', 'child playlist should resolve container to fmp4');
  assert.equal(manifest.muxed, true);
  const f = find(diagnosis.findings, 'muxed-fmp4-no-audio');
  assert.ok(f, 'expected muxed-fmp4-no-audio finding');
  assert.equal(f!.confidence, 'high');
  assert.equal(f!.severity, 'degraded');
  assert.match(diagnosis.verdict, /muxes audio and video|no audio/i);
});

test('flac (muxed) -> muxed-fmp4 + audio-codec-silent', async () => {
  const { diagnosis } = await diagnoseFixture('flac-hls');
  assert.ok(find(diagnosis.findings, 'muxed-fmp4-no-audio'));
  assert.ok(find(diagnosis.findings, 'audio-codec-silent'), 'FLAC should also raise audio-codec-silent');
});

test('vorbis (muxed) -> muxed-fmp4 + audio-codec-silent', async () => {
  const { diagnosis } = await diagnoseFixture('vorbis-hls');
  assert.ok(find(diagnosis.findings, 'muxed-fmp4-no-audio'));
  assert.ok(find(diagnosis.findings, 'audio-codec-silent'));
});

// ---------------------------------------------------------------------------
// HEVC over decoder limit = hard fail. Device reported errorCode -3 /
// category "mediaplayer" (NOT -5), so the generic media-player error must
// corroborate the manifest-derived decoder-limit finding to high confidence.
// ---------------------------------------------------------------------------
const HEVC8K_DEVICE_ERROR =
  '{"errorCode":-3,"errorInfo":{"category":"mediaplayer","dbgmsg":"bad:extra:err_clip_idx:0","drmerrcode":0,"errcode":0}}';

test('hevc-8k + device errorInfo -> blocking hevc-exceeds-decoder leads', async () => {
  const { diagnosis } = await diagnoseFixture('hevc-8k-hls', HEVC8K_DEVICE_ERROR);
  const f = find(diagnosis.findings, 'hevc-exceeds-decoder');
  assert.ok(f, 'expected hevc-exceeds-decoder finding');
  assert.equal(f!.confidence, 'high', 'errorCode -3/mediaplayer should corroborate to high');
  assert.equal(f!.severity, 'blocking');
  // Blocking decoder fault must rank ahead of any degraded/advisory finding.
  assert.equal(diagnosis.findings[0].id, 'hevc-exceeds-decoder');
  // Verbatim device evidence flows through.
  assert.ok(f!.evidence.some((e) => e.includes('bad:extra:err_clip_idx:0')));
});

test('hevc-8k WITHOUT a device error -> still flagged, medium confidence', async () => {
  const { diagnosis } = await diagnoseFixture('hevc-8k-hls');
  const f = find(diagnosis.findings, 'hevc-exceeds-decoder');
  assert.ok(f, 'manifest alone should still flag the over-limit HEVC');
  assert.equal(f!.confidence, 'medium', 'no device corroboration -> medium');
});

// ---------------------------------------------------------------------------
// CONTROL: demuxed AAC plays WITH audio on device. Must produce NO findings
// (guards against the muxed false-positive we previously had).
// ---------------------------------------------------------------------------
test('demuxed-aac control -> no findings (no false positive)', async () => {
  const { manifest, diagnosis } = await diagnoseFixture('demuxed-aac-hls');
  assert.equal(manifest.muxed, false, 'AUDIO group means demuxed, even though CODECS lists both');
  assert.equal(diagnosis.findings.length, 0, `expected zero findings, got: ${ids(diagnosis.findings).join(', ')}`);
});

// ---------------------------------------------------------------------------
// Severity ranking: a won't-play (blocking) issue outranks a plays-but-silent
// (degraded) one when both are present (e.g. an over-limit + muxed stream).
// ---------------------------------------------------------------------------
test('h264-4k (muxed + over-limit) with reader error -> decoder blocking ranks first', async () => {
  const readerError =
    '{"errorInfo":{"category":"mediaplayer","dbgmsg":"reader pick stream error:bad:invalid or corrupt playlist","drmerrcode":0,"errcode":0,"source":"buffer:reader"}}';
  const { diagnosis } = await diagnoseFixture('h264-4k-hls', readerError);
  assert.equal(diagnosis.findings[0].id, 'avc-exceeds-decoder');
  assert.equal(diagnosis.findings[0].severity, 'blocking');
  // The muxed-audio degraded finding is still present, just ranked lower.
  const muxedIdx = diagnosis.findings.findIndex((f) => f.id === 'muxed-fmp4-no-audio');
  assert.ok(muxedIdx > 0, 'muxed finding should be present but not first');
});

// ---------------------------------------------------------------------------
// Pure errorInfo correlation (no manifest) still works.
// ---------------------------------------------------------------------------
test('DRM errorInfo only -> blocking drm-error', () => {
  const error = normalizeRokuError('{"errorCode":-6,"errorInfo":{"category":"drm","drmerrcode":13}}');
  const diagnosis = diagnose({ error });
  const f = find(diagnosis.findings, 'drm-error');
  assert.ok(f, 'expected drm-error finding');
  assert.equal(f!.severity, 'blocking');
});

// ---------------------------------------------------------------------------
// Every finding must carry the full shape (no missing severity/fix/docUrl).
// ---------------------------------------------------------------------------
test('all findings are well-formed', async () => {
  const fixtures = ['muxed-fmp4-hls', 'flac-hls', 'vorbis-hls', 'hevc-8k-hls', 'opus-hls', 'h264-4k-hls'];
  for (const fx of fixtures) {
    const { diagnosis } = await diagnoseFixture(fx);
    for (const f of diagnosis.findings) {
      assert.ok(f.id, `${fx}: finding missing id`);
      assert.ok(['blocking', 'degraded', 'advisory'].includes(f.severity), `${fx}/${f.id}: bad severity`);
      assert.ok(['high', 'medium', 'low'].includes(f.confidence), `${fx}/${f.id}: bad confidence`);
      assert.ok(f.cause && f.fix && f.docUrl, `${fx}/${f.id}: missing cause/fix/docUrl`);
      assert.ok(Array.isArray(f.evidence) && f.evidence.length > 0, `${fx}/${f.id}: empty evidence`);
    }
  }
});
