/**
 * The correlation engine.
 *
 * Given any combination of three evidence sources —
 *   1. the device error (Video node errorCode/errorInfo), and/or
 *   2. the parsed manifest (codecs/container/DRM/segments), and/or
 *   3. the HTTP traffic from a Charles/HAR session —
 * produce ranked, plain-English root-cause findings, each with the evidence it
 * relied on, a confidence level, a suggested fix, and a doc link.
 *
 * Confidence rises when sources agree. For example, `errorCode -6` (DRM)
 * corroborated by a license POST returning 403 in the Charles session is a
 * high-confidence diagnosis; a manifest-only hint ("declares Opus audio") is
 * low confidence because the device might still play it.
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import type { NormalizedRokuError } from './error-info.js';
import type { ManifestSummary } from './manifest.js';
import type { CharlesSession, NormalizedHttpEntry } from './charles.js';

// roku-specs.json is copied alongside the compiled module (it lives in src/stream
// and ships to dist/stream). Read it at runtime to avoid JSON import-attribute
// requirements under the project's Node16 module setting.
const specsPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'roku-specs.json');
const specs = JSON.parse(readFileSync(specsPath, 'utf-8')) as RokuSpecs;

interface RokuSpecs {
  lastVerified: string;
  disclaimer: string;
  sources: string[];
  video: Record<string, { supported: string[]; docUrl: string }>;
  videoLimits: {
    note: string;
    avc: { maxWidth: number; maxHeight: number; maxLevel: number; profiles: string[] };
    hevc: { maxWidth: number; maxHeight: number; maxLevel: number };
    docUrl: string;
  };
  audio: Record<string, { supported: string[]; docUrl: string }>;
  containers: Record<string, {
    supported: string[];
    muxedCmafAllowed: boolean;
    muxedTsRequiresVideoAtAllBitrates?: boolean;
    docUrl: string;
  }>;
  drm: {
    supportedSystems: Record<string, string[]>;
    removedSystems: Array<{ name: string; removedInOsVersion: string; note: string; docUrl: string }>;
    preferredEncryptionScheme: string;
    encryptionNote: string;
    psshNote: string;
    libProviderNote: string;
    docUrl: string;
  };
  segments: {
    vodMaxSeconds: number;
    liveMaxSeconds: number;
    note: string;
    docUrl: string;
  };
  errorCodes: Record<string, string>;
  errorCategories: Record<string, string>;
}

export type Confidence = 'high' | 'medium' | 'low';

/**
 * How badly the issue breaks playback:
 *  - 'blocking'  : the stream will not play at all (decoder/network/DRM/empty).
 *  - 'degraded'  : the stream plays but is impaired (e.g. silent audio).
 *  - 'advisory'  : a hint that may or may not matter (segment length, signaling).
 */
export type Severity = 'blocking' | 'degraded' | 'advisory';

export interface Finding {
  id: string;
  cause: string;
  /** Verbatim evidence strings that support this finding. */
  evidence: string[];
  confidence: Confidence;
  /** Playback impact, used to rank a won't-play issue above a plays-but-silent one. */
  severity: Severity;
  fix: string;
  docUrl: string;
}

export interface DiagnosisInput {
  error?: NormalizedRokuError;
  manifest?: ManifestSummary;
  charles?: CharlesSession;
  /** DRM hint the developer told us they configured. */
  declaredDrm?: { keySystem?: string };
}

export interface Diagnosis {
  verdict: string;
  findings: Finding[];
  specVersion: string;
  specDisclaimer: string;
}

const confidenceRank: Record<Confidence, number> = { high: 3, medium: 2, low: 1 };
const severityRank: Record<Severity, number> = { blocking: 3, degraded: 2, advisory: 1 };

/** Find the license request(s) in a Charles session. */
function licenseRequests(charles?: CharlesSession): NormalizedHttpEntry[] {
  return charles?.entries.filter((e) => e.kind === 'license') ?? [];
}

function failingOfKind(charles: CharlesSession | undefined, kind: NormalizedHttpEntry['kind']): NormalizedHttpEntry[] {
  return charles?.failing.filter((e) => e.kind === kind) ?? [];
}

function shortUrl(url: string): string {
  return url.length > 120 ? url.slice(0, 117) + '...' : url;
}

/** Akamai/CDN token-auth query param + header signals. */
const TOKEN_URL_RE = /[?&](hdnts|hdntl|hdnea|token|auth|jwt|signature|sig|policy|expires|key-pair-id|exp|st)=/i;
const AKAMAI_HEADER_RE = /hdntl|hdnts/i;
const TOKEN_BODY_RE = /access denied|errors\.edgesuite\.net|akamaighost|forbidden|expired|invalid token|missing token/i;

/** Whether a failing entry looks gated by a per-session token/signature. */
function isTokenGated(e: NormalizedHttpEntry): boolean {
  if (TOKEN_URL_RE.test(e.url)) return true;
  // Akamai advertises its token headers in the access-control allow/expose lists.
  const acAllow = e.respHeaders['access-control-allow-headers'] ?? '';
  const acExpose = e.respHeaders['access-control-expose-headers'] ?? '';
  if (AKAMAI_HEADER_RE.test(acAllow) || AKAMAI_HEADER_RE.test(acExpose)) return true;
  // A 403 with an Akamai/edge "Access Denied" body is a classic token denial.
  if (e.status === 403 && (e.kind === 'manifest' || e.kind === 'segment')) {
    const server = e.respHeaders['server'] ?? '';
    if (/akamai/i.test(server)) return true;
    if (e.respBody && TOKEN_BODY_RE.test(e.respBody)) return true;
  }
  return false;
}

/** Verbatim evidence strings explaining why an entry looks token-gated. */
function tokenGateEvidence(e: NormalizedHttpEntry): string[] {
  const out: string[] = [];
  if (TOKEN_URL_RE.test(e.url)) out.push('URL carries an auth/token query parameter.');
  const acAllow = e.respHeaders['access-control-allow-headers'] ?? '';
  const acExpose = e.respHeaders['access-control-expose-headers'] ?? '';
  if (AKAMAI_HEADER_RE.test(acAllow) || AKAMAI_HEADER_RE.test(acExpose)) {
    out.push('Response advertises Akamai token headers (hdnts/hdntl) in access-control headers.');
  }
  if (e.status === 403 && /akamai/i.test(e.respHeaders['server'] ?? '')) {
    out.push('403 served by AkamaiGHost (edge token/auth denial).');
  }
  return out;
}

/** DRM correlation rules. */
function diagnoseDrm(input: DiagnosisInput, findings: Finding[]): void {
  const { error, manifest, charles } = input;
  const isDrmError = error?.errorCode === -6 || error?.category === 'drm';
  const failingLicense = failingOfKind(charles, 'license');
  const allLicense = licenseRequests(charles);

  if (isDrmError && failingLicense.length > 0) {
    const ev = failingLicense.map((e) => `${e.method} ${shortUrl(e.url)} -> HTTP ${e.status}`);
    if (error?.drmerrcode !== undefined) ev.unshift(`Video.errorInfo.drmerrcode = ${error.drmerrcode}`);
    if (error?.dbgmsg) ev.push(`dbgmsg: ${error.dbgmsg}`);
    findings.push({
      id: 'drm-license-rejected',
      severity: 'blocking',
      cause: `The DRM license request was rejected by the license server (HTTP ${failingLicense[0].status}). Roku reported a DRM error, and the matching license call in the capture failed.`,
      evidence: ev,
      confidence: 'high',
      fix: 'Check the licenseServerURL, auth token, and licenseReqHeaders Roku sends. The token/cookie that works in the browser may not be forwarded by Roku, or the server may reject Roku\'s request shape. Ensure the license endpoint accepts the request as sent on-device.',
      docUrl: specs.drm.docUrl,
    });
    return;
  }

  if (isDrmError) {
    const ev: string[] = [];
    if (error?.errorCode !== undefined) ev.push(`Video.errorCode = ${error.errorCode} (${specs.errorCodes[String(error.errorCode)] ?? 'DRM error'})`);
    if (error?.drmerrcode !== undefined) ev.push(`drmerrcode = ${error.drmerrcode}`);
    if (error?.dbgmsg) ev.push(`dbgmsg: ${error.dbgmsg}`);
    if (allLicense.length > 0) ev.push(`License request seen: ${allLicense[0].method} ${shortUrl(allLicense[0].url)} -> HTTP ${allLicense[0].status}`);
    const libMissing = !!error?.dbgmsg && /lib provider not found|provider not found/i.test(error.dbgmsg);
    findings.push({
      id: 'drm-error',
      severity: 'blocking',
      cause: libMissing
        ? 'DRM failed because the required DRM library is not installed on the device.'
        : 'Roku reported a DRM error. The license/key handshake did not complete successfully.',
      evidence: ev.length ? ev : ['Video reported a DRM error (errorCode -6 / category "drm").'],
      confidence: charles ? 'medium' : 'medium',
      fix: libMissing
        ? specs.drm.libProviderNote
        : 'Verify drmParams (KeySystem, licenseServerURL, licenseReqHeaders) match what the stream expects. Confirm the device supports the keysystem and that the license server accepts Roku\'s request. ' + specs.drm.libProviderNote,
      docUrl: specs.drm.docUrl,
    });
  }

  // Manifest-level DRM hints (low confidence — signaling only).
  if (manifest) {
    for (const removed of specs.drm.removedSystems) {
      if (manifest.drm.some((d) => d.system.toLowerCase() === removed.name.toLowerCase())) {
        findings.push({
          id: `drm-removed-${removed.name.toLowerCase()}`,
          severity: 'blocking',
          cause: `The manifest signals ${removed.name} DRM, which Roku removed from firmware in OS ${removed.removedInOsVersion}.`,
          evidence: [`Manifest DRM signal: ${removed.name}`],
          confidence: 'medium',
          fix: removed.note,
          docUrl: removed.docUrl,
        });
      }
    }

    const fmt = manifest.format;
    const allowedDrm = specs.drm.supportedSystems[fmt] ?? [];
    for (const sig of manifest.drm) {
      const known = ['Widevine', 'PlayReady', 'AES-128', 'SAMPLE-AES', 'ClearKey', 'FairPlay', 'Verimatrix'];
      if (known.includes(sig.system) && !allowedDrm.includes(sig.system) &&
          !specs.drm.removedSystems.some((r) => r.name === sig.system)) {
        findings.push({
          id: `drm-unsupported-${sig.system.toLowerCase()}-${fmt}`,
          severity: 'blocking',
          cause: `The manifest signals ${sig.system} DRM, which Roku does not list as supported for ${fmt.toUpperCase()}.`,
          evidence: [`Manifest DRM signal: ${sig.system} (${fmt.toUpperCase()})`],
          confidence: 'low',
          fix: `Use a Roku-supported DRM for ${fmt.toUpperCase()}: ${allowedDrm.join(', ')}.`,
          docUrl: specs.drm.docUrl,
        });
      }
    }

    if (fmt === 'dash' && manifest.drm.length > 0 && manifest.drm.every((d) => !d.hasPssh)) {
      findings.push({
        id: 'dash-missing-pssh',
        severity: 'advisory',
        cause: 'The DASH manifest declares DRM but no <cenc:pssh> was found.',
        evidence: ['No cenc:pssh in any ContentProtection element.'],
        confidence: 'low',
        fix: specs.drm.psshNote,
        docUrl: specs.drm.docUrl,
      });
    }
  }
}

/** Parse "WIDTHxHEIGHT" into [w, h]. */
function parseResolution(res: string | undefined): [number, number] | undefined {
  if (!res) return undefined;
  const m = /^(\d+)\s*x\s*(\d+)$/i.exec(res.trim());
  if (!m) return undefined;
  return [Number(m[1]), Number(m[2])];
}

/**
 * Detect H.264/AVC streams that exceed Roku's decoder limits (1080p / level 4.2).
 * 4K or high-level H.264 plays in browsers/VLC (software decode) but Roku's
 * hardware H.264 decoder rejects it with errorCode -5. The fix is HEVC for 4K.
 */
/**
 * Roku reader/selection failure signals. When the device cannot decode any
 * offered variant it often reports category "mediaplayer" / source
 * "buffer:reader" with a dbgmsg like "reader pick stream error" or
 * "invalid or corrupt playlist" — i.e. it could not pick a usable stream.
 */
function isReaderSelectionFailure(error: NormalizedRokuError | undefined): boolean {
  if (!error) return false;
  const dbg = (error.dbgmsg ?? '').toLowerCase();
  const src = (typeof error.extra?.source === 'string' ? error.extra.source : '').toLowerCase();
  if (/pick stream|invalid or corrupt playlist|no valid bitrates|reader/.test(dbg)) return true;
  if (/buffer:reader|reader/.test(src)) return true;
  return false;
}

function diagnoseDecoderLimits(input: DiagnosisInput, findings: Finding[], isMediaError: boolean): void {
  const { manifest, error } = input;
  if (!manifest) return;
  const avc = specs.videoLimits?.avc;
  const hevc = specs.videoLimits?.hevc;
  if (!avc && !hevc) return;

  // A reader/selection failure OR a generic media-player error (errorCode -3/-5,
  // category mediaerror/mediaplayer) corroborates a decoder rejection. Roku does
  // not always emit errorCode -5: an over-limit HEVC stream was observed
  // returning errorCode -3 / category "mediaplayer" on a Roku Ultra (OS 15.2).
  const readerFail = isReaderSelectionFailure(error);
  const corroborated = isMediaError || readerFail || isGenericMediaPlayerError(error);

  for (const t of manifest.tracks) {
    const codecsLower = (t.codecs ?? '').toLowerCase();
    const isAvc = t.codecFamilies.includes('AVC') || codecsLower.includes('avc1') || codecsLower.includes('avc3');
    const isHevc = t.codecFamilies.includes('HEVC') || codecsLower.includes('hvc1') || codecsLower.includes('hev1');
    const res = parseResolution(t.resolution);

    let label: 'H.264' | 'HEVC' | undefined;
    let limits: { maxWidth: number; maxHeight: number; maxLevel: number } | undefined;
    let level: number | undefined;
    if (isAvc && avc) { label = 'H.264'; limits = avc; level = t.avcLevel; }
    else if (isHevc && hevc) { label = 'HEVC'; limits = hevc; level = t.hevcLevel; }
    if (!label || !limits) continue;

    const overRes = res ? (res[0] > limits.maxWidth || res[1] > limits.maxHeight) : false;
    const overLevel = level !== undefined && level > limits.maxLevel;
    if (!overRes && !overLevel) continue;

    const reasons: string[] = [];
    if (res && overRes) reasons.push(`resolution ${res[0]}x${res[1]} exceeds ${label} max ${limits.maxWidth}x${limits.maxHeight}`);
    if (overLevel) reasons.push(`${label} level ${(level! / 10).toFixed(1)} exceeds max ${(limits.maxLevel / 10).toFixed(1)}`);

    const evidence = [`Track codecs: ${t.codecs ?? t.codecFamilies.join(',')}${t.resolution ? `, ${t.resolution}` : ''}`];
    if (error?.errorCode !== undefined && error.errorCode < 0) evidence.push(`Video.errorCode = ${error.errorCode} (${specs.errorCodes[String(error.errorCode)] ?? 'media error'})`);
    if (error?.category) evidence.push(`errorInfo.category = ${error.category}`);
    if ((readerFail || corroborated) && error?.dbgmsg) evidence.push(`dbgmsg: ${error.dbgmsg}`);

    const fix = label === 'H.264'
      ? 'For 4K/UHD use HEVC (H.265), VP9, or AV1 — not H.264. For H.264, cap at 1920x1080 and level 4.2.'
      : 'This HEVC variant is beyond what the device can decode (Roku 4K models top out around 3840x2160 / level 5.1; 8K and level 6.x are not decodable). Cap HEVC at 4K/level 5.1, or offer a lower variant the device can select.';

    findings.push({
      id: label === 'H.264' ? 'avc-exceeds-decoder' : 'hevc-exceeds-decoder',
      severity: 'blocking',
      cause: `The stream uses ${label} beyond Roku's decoder limits: ${reasons.join('; ')}. The hardware decoder cannot handle this variant${readerFail ? ' and its reader rejects the stream as unplayable (e.g. "invalid or corrupt playlist" / "pick stream error")' : ', so playback fails'} — even though browsers and VLC play it via software decode.`,
      evidence,
      confidence: corroborated ? 'high' : 'medium',
      fix,
      docUrl: specs.videoLimits.docUrl,
    });
    return; // one finding is enough
  }
}

/**
 * A generic media-player error (no specific subcategory). Over-limit decoders and
 * undecodable media often surface as errorCode -3 ("unknown/unspecified") with
 * category "mediaplayer" rather than the more specific errorCode -5 / "mediaerror".
 */
function isGenericMediaPlayerError(error: NormalizedRokuError | undefined): boolean {
  if (!error) return false;
  if (error.category === 'mediaplayer' || error.category === 'mediaerror') return true;
  if (error.errorCode === -3 || error.errorCode === -5) return true;
  return false;
}

/** Media/codec correlation rules. */
function diagnoseMedia(input: DiagnosisInput, findings: Finding[]): void {
  const { error, manifest } = input;
  // A media error is a -5/mediaerror, OR a generic media-player failure
  // (errorCode -3 / category "mediaplayer") which Roku emits for undecodable
  // media (e.g. an over-limit HEVC variant — verified on a Roku Ultra OS 15.2).
  const isMediaError = error?.errorCode === -5 || error?.category === 'mediaerror' ||
    (error?.category === 'mediaplayer' && (error?.errorCode === -3 || error?.errorCode === undefined));

  const decoderFindingCount = findings.length;
  diagnoseDecoderLimits(input, findings, isMediaError);
  const decoderFired = findings.length > decoderFindingCount;

  // Reader/selection failure without a more specific decoder finding: Roku could
  // not pick a playable variant. If we have a manifest it's usually a codec/level
  // issue; otherwise point the user at the variant set.
  if (isReaderSelectionFailure(error) && !decoderFired) {
    const ev: string[] = [];
    if (error?.category) ev.push(`errorInfo.category = ${error.category}`);
    if (error?.dbgmsg) ev.push(`dbgmsg: ${error.dbgmsg}`);
    if (typeof error?.extra?.source === 'string') ev.push(`source: ${error.extra.source}`);
    findings.push({
      id: 'reader-selection-failure',
      severity: 'blocking',
      cause: 'Roku\'s reader could not select a playable stream from the manifest ("invalid or corrupt playlist" / "pick stream error"). The manifest is reachable but no offered variant is decodable on this device — typically an unsupported video codec/profile/level, a resolution above the decoder limit, or a malformed playlist.',
      evidence: ev.length ? ev : ['Roku reported a reader/selection failure (category "mediaplayer", source "buffer:reader").'],
      confidence: 'medium',
      fix: 'Verify each variant\'s codec/profile/level/resolution against Roku limits (H.264 \u2264 1080p/L4.2; 4K needs HEVC/VP9/AV1), and validate the playlist is well-formed. Provide at least one variant the device can decode.',
      docUrl: specs.videoLimits?.docUrl ?? specs.errorCodes.docUrl,
    });
  }

  if (isMediaError) {
    const ev: string[] = [];
    if (error?.errorCode !== undefined) ev.push(`Video.errorCode = ${error.errorCode} (media error)`);
    if (error?.dbgmsg) ev.push(`dbgmsg: ${error.dbgmsg}`);
    if (error?.errcode !== undefined) ev.push(`errcode = ${error.errcode}`);

    // Correlate dbgmsg "pump" / fragment messages with container info.
    const fragmentIssue = !!error?.dbgmsg && /pump|fragment|moof|moov|movie fragment|box/i.test(error.dbgmsg);
    if (fragmentIssue) {
      findings.push({
        id: 'media-fragment-parse',
        severity: 'blocking',
        cause: `Roku could not parse the media fragments${manifest ? ` (${manifest.container} container)` : ''}. This usually means non-compliant fMP4/CMAF fragmentation (missing/!invalid moof/moov, unaligned fragments) rather than an unsupported codec.`,
        evidence: ev,
        confidence: 'high',
        fix: 'Re-package the stream as Roku-compatible CMAF/fMP4: ensure each segment starts with an IDR frame, fragments are valid and aligned across representations, and (for CMAF) audio and video are not muxed in one track.',
        docUrl: specs.segments.docUrl,
      });
    } else {
      // Generic media error — correlate against declared VIDEO codecs.
      // NOTE: an unsupported *audio* codec does NOT cause a media error on Roku;
      // it plays the video with no audio (see diagnoseAudio). So a -5 media error
      // points at the video codec/container, not the audio.
      const unsupportedVideo = manifest ? unsupportedVideoCodecs(manifest) : [];
      if (unsupportedVideo.length > 0) {
        findings.push({
          id: 'media-unsupported-video-codec',
          severity: 'blocking',
          cause: `Roku reported a media error and the manifest declares a video codec Roku does not support for ${manifest!.format.toUpperCase()}: ${unsupportedVideo.join(', ')}.`,
          evidence: [...ev, ...unsupportedVideo.map((c) => `Declared video codec not supported: ${c}`)],
          confidence: 'high',
          fix: `Re-encode the video using a Roku-supported codec for ${manifest!.format.toUpperCase()} (${specs.video[manifest!.format].supported.join('/')}).`,
          docUrl: specs.video[manifest!.format].docUrl,
        });
      } else {
        findings.push({
          id: 'media-error-generic',
          severity: 'blocking',
          cause: 'Roku reported a media error (format unknown or unsupported), but the manifest codecs look supported. The problem is likely in the actual media (container/fragmentation, profile/level, or an encrypted track without DRM signaling).',
          evidence: ev.length ? ev : ['Video reported errorCode -5 / category "mediaerror".'],
          confidence: 'medium',
          fix: 'Check the codec profile/level (e.g. very high H.264/HEVC levels), container fragmentation, and that any encrypted track is correctly DRM-signaled. Capture a Charles session to inspect the actual segment responses.',
          docUrl: specs.video[manifest?.format ?? 'hls']?.docUrl ?? specs.errorCodes.docUrl,
        });
      }
    }
  }

  // Manifest-only VIDEO codec hints (no media error reported).
  if (manifest && !isMediaError) {
    for (const codec of unsupportedVideoCodecs(manifest)) {
      findings.push({
        id: `video-codec-hint-${codec.toLowerCase().replace(/[^a-z0-9]/g, '')}`,
        severity: 'blocking',
        cause: `The manifest declares video codec ${codec}, which Roku does not support for ${manifest.format.toUpperCase()}. Playback will fail (errorCode -5) on-device.`,
        evidence: [`Declared video codec: ${codec} (${manifest.format.toUpperCase()})`],
        confidence: 'low',
        fix: `Re-encode the video with a Roku-supported codec for ${manifest.format.toUpperCase()}: ${specs.video[manifest.format].supported.join('/')}.`,
        docUrl: specs.video[manifest.format].docUrl,
      });
    }
  }

  // Audio-codec / no-audio diagnosis runs in its own pass.
  diagnoseAudio(input, findings);
}

/**
 * Audio-specific diagnosis.
 *
 * IMPORTANT Roku behavior: when an HLS stream uses an unsupported audio codec
 * (e.g. Opus) or muxes audio+video into a single fMP4/CMAF track, Roku does NOT
 * raise an error — it plays the VIDEO and silently drops the audio ("Audio
 * Format: None" in the Stream Tester). So the symptom is "video plays, no
 * sound", not a failed stream. This is why such a stream can look like it
 * "worked" on-device while actually being broken.
 */
function diagnoseAudio(input: DiagnosisInput, findings: Finding[]): void {
  const { manifest, error } = input;
  if (!manifest) return;

  // Only relevant when there is no hard failure (video plays).
  const hardFailure = error?.errorCode !== undefined && error.errorCode < 0 && error.errorCode !== 0;
  // A -5/media error is a video/container problem, handled elsewhere; but a stream
  // that "played" (no error, or finished/playing) with a bad audio codec is silent.

  const badAudio = unsupportedAudioCodecs(manifest);
  if (badAudio.length > 0 && !hardFailure) {
    findings.push({
      id: 'audio-codec-silent',
      severity: 'degraded',
      cause: `The manifest declares audio codec ${badAudio.join(', ')}, which Roku does not support for ${manifest.format.toUpperCase()}. Roku will play the video but produce NO audio (it silently drops the unsupported track) rather than erroring — so the stream can look like it "works" while being silent.`,
      evidence: [`Declared audio codec: ${badAudio.join(', ')} (${manifest.format.toUpperCase()})`],
      confidence: 'medium',
      fix: `Provide an AAC stereo audio track. Supported HLS audio: ${specs.audio[manifest.format].supported.join('/')}. Roku requires an AAC track even when an additional Dolby track is offered.`,
      docUrl: specs.audio[manifest.format].docUrl,
    });
  }

  // Muxed audio+video in fMP4/CMAF HLS yields silent playback on Roku — verified
  // on-device (Roku Ultra OS 15.2): a muxed fMP4 variant reports
  // media-player format audio="none" even with fully-supported AAC, while the
  // demuxed equivalent reports audio="aac". Muxed MPEG-TS, by contrast, is the
  // classic supported HLS shape and is fine, so we only flag fMP4/CMAF (or an
  // unresolved container, which on a v7 master is almost always fMP4).
  const isFmp4 = manifest.container === 'cmaf' || manifest.container === 'fmp4';
  const containerUnknown = !manifest.containerResolved && manifest.container !== 'ts';
  if (manifest.muxed && manifest.format === 'hls' && (isFmp4 || containerUnknown) && !hardFailure) {
    const ev = ['Variant declares both video and audio codecs with no separate EXT-X-MEDIA audio group (muxed A/V).'];
    ev.push(isFmp4
      ? `Container: ${manifest.container} (fMP4/CMAF).`
      : 'Container could not be confirmed from the master alone; an HLS v7 master with muxed CODECS is almost always fMP4.');
    findings.push({
      id: 'muxed-fmp4-no-audio',
      severity: 'degraded',
      cause: 'The HLS stream muxes audio and video into a single fMP4/CMAF rendition. Roku does not play muxed audio in fMP4/CMAF HLS: the video plays but there is NO audio (media-player reports audio="none"). This happens even when the audio codec itself (e.g. AAC) is fully supported — the problem is the muxing, not the codec.',
      evidence: ev,
      confidence: isFmp4 ? 'high' : 'medium',
      fix: 'Split audio into a separate HLS audio rendition declared with #EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=...,URI=... and reference it via AUDIO="..." on the #EXT-X-STREAM-INF. With ffmpeg: -var_stream_map "v:0,agroup:aud a:0,agroup:aud,default:yes". (Muxed MPEG-TS HLS is fine; only fMP4/CMAF must be demuxed.)',
      docUrl: specs.containers[manifest.format].docUrl,
    });
  }
}

function unsupportedVideoCodecs(manifest: ManifestSummary): string[] {
  const okVideo = specs.video[manifest.format]?.supported ?? [];
  const out: string[] = [];
  for (const v of manifest.videoCodecs) {
    if (v === 'DolbyVision') continue; // HDR layer, not a base codec mismatch
    if (!okVideo.includes(v) && !out.includes(v)) out.push(v);
  }
  return out;
}

function unsupportedAudioCodecs(manifest: ManifestSummary): string[] {
  const okAudio = specs.audio[manifest.format]?.supported ?? [];
  const out: string[] = [];
  for (const a of manifest.audioCodecs) {
    if (!okAudio.includes(a) && !out.includes(a)) out.push(a);
  }
  return out;
}

/** Network / HTTP correlation rules. */
function diagnoseNetwork(input: DiagnosisInput, findings: Finding[]): void {
  const { error, charles } = input;
  const isNetError = error?.errorCode === -1 || error?.errorCode === -2 || error?.category === 'http';

  const failingSeg = failingOfKind(charles, 'segment');
  const failingMan = failingOfKind(charles, 'manifest');

  if (isNetError && (failingSeg.length > 0 || failingMan.length > 0)) {
    const failing = [...failingMan, ...failingSeg];
    const ev = failing.slice(0, 5).map((e) => `${e.method} ${shortUrl(e.url)} -> HTTP ${e.status}`);
    if (error?.errorCode !== undefined) ev.unshift(`Video.errorCode = ${error.errorCode} (${specs.errorCodes[String(error.errorCode)]})`);
    const looksTokenGated = failing.some(isTokenGated);
    const tokenEvidence = failing.flatMap(tokenGateEvidence);
    ev.push(...tokenEvidence);
    findings.push({
      id: 'network-request-failed',
      severity: 'blocking',
      cause: `Roku could not download ${failingMan.length ? 'the manifest' : 'segments'} — ${failing[0].status} from the origin.${looksTokenGated ? ' The request is token/signature-gated (e.g. an Akamai hdnts/hdntl token), so a missing, expired, or device-rejected token is the likely cause.' : ''}`,
      evidence: ev,
      confidence: 'high',
      fix: looksTokenGated
        ? 'This stream requires a per-session auth token appended to the URL (or sent as a header). It plays in a browser/other platform because that client obtained a fresh token. On Roku you must generate the token at playback time and put it on the ContentNode `url` (e.g. `...master.m3u8?hdnts=...`) or send it via the Video node HTTP agent (`getHttpAgent().addHeader(...)`). A bare manifest URL with no token returns 403.'
        : 'Verify the origin/CDN serves these URLs to the Roku device (check geo/IP/User-Agent restrictions, CORS is irrelevant on Roku but WAF rules are not), and that there are no redirects Roku cannot follow.',
      docUrl: specs.errorCategories.docUrl,
    });
    return;
  }

  if (isNetError) {
    const ev: string[] = [];
    if (error?.errorCode !== undefined) ev.push(`Video.errorCode = ${error.errorCode} (${specs.errorCodes[String(error.errorCode)]})`);
    if (error?.dbgmsg) ev.push(`dbgmsg: ${error.dbgmsg}`);
    findings.push({
      id: 'network-error',
      severity: 'blocking',
      cause: error?.errorCode === -2
        ? 'Roku timed out connecting to the stream server.'
        : 'Roku hit a network error reaching the stream (server unreachable, DNS, TLS, or a client network problem).',
      evidence: ev.length ? ev : ['Video reported a network error.'],
      confidence: charles ? 'medium' : 'medium',
      fix: 'Confirm the host resolves and responds from the device\'s network, the TLS certificate chain is complete and trusted, and the server isn\'t blocking Roku by User-Agent/IP. A Charles capture pinpoints which request failed.',
      docUrl: specs.errorCategories.docUrl,
    });
  }
}

/** Empty-list / no-playable-variant rules. */
function diagnoseEmpty(input: DiagnosisInput, findings: Finding[]): void {
  const { error, manifest } = input;
  if (error?.errorCode !== -4) return;
  const ev = ['Video.errorCode = -4 (empty list — no streams specified to play)'];
  const noVariants = manifest && manifest.tracks.filter((t) => t.type !== 'audio').length === 0;
  findings.push({
    id: 'empty-list',
    severity: 'blocking',
    cause: noVariants
      ? 'No playable video variant was offered to Roku — the manifest has no video renditions Roku could select.'
      : 'Roku was given an empty content list — no stream URL/streamFormat reached the Video node, or all variants were filtered out.',
    evidence: ev,
    confidence: manifest ? 'medium' : 'medium',
    fix: 'Ensure the ContentNode has a valid `url` and `streamFormat`, and that the manifest exposes at least one variant with a Roku-supported codec.',
    docUrl: specs.errorCodes.docUrl,
  });
}

/** Segment-duration hints (manifest-only). */
function diagnoseSegments(input: DiagnosisInput, findings: Finding[]): void {
  const { manifest } = input;
  if (!manifest || manifest.maxSegmentSeconds === undefined) return;
  const limit = manifest.isLive ? specs.segments.liveMaxSeconds : specs.segments.vodMaxSeconds;
  if (manifest.maxSegmentSeconds > limit) {
    findings.push({
      id: 'segment-too-long',
      severity: 'advisory',
      cause: `Segment duration (~${manifest.maxSegmentSeconds.toFixed(1)}s) exceeds Roku's recommended ${manifest.isLive ? 'live' : 'VOD'} maximum of ${limit}s.`,
      evidence: [`maxSegmentSeconds ≈ ${manifest.maxSegmentSeconds.toFixed(1)} (${manifest.isLive ? 'live' : 'VOD'})`],
      confidence: 'low',
      fix: `Re-segment to under ${limit}s for ${manifest.isLive ? 'live' : 'VOD'} to improve start time and ABR behavior.`,
      docUrl: specs.segments.docUrl,
    });
  }
}

/** Build the one-line verdict from the highest-confidence finding. */
function buildVerdict(findings: Finding[], input: DiagnosisInput): string {
  if (findings.length === 0) {
    if (input.error && !input.error.empty) {
      const code = input.error.errorCode;
      return `Roku reported an error${code !== undefined ? ` (errorCode ${code}: ${specs.errorCodes[String(code)] ?? 'see errorInfo'})` : ''}, but not enough evidence to pinpoint a root cause. Add the manifest and/or a Charles session for a sharper diagnosis.`;
    }
    return 'No issues detected from the provided evidence. If playback still fails, capture the Video node errorInfo and/or a Charles session and re-run.';
  }
  return findings[0].cause;
}

export function diagnose(input: DiagnosisInput): Diagnosis {
  const findings: Finding[] = [];

  diagnoseDrm(input, findings);
  diagnoseMedia(input, findings);
  diagnoseNetwork(input, findings);
  diagnoseEmpty(input, findings);
  diagnoseSegments(input, findings);

  // Rank: a won't-play (blocking) issue outranks a plays-but-silent (degraded)
  // one, which outranks an advisory hint; within a severity tier, higher
  // confidence first; ties keep insertion order (stable sort).
  findings.sort((a, b) => {
    const sev = severityRank[b.severity] - severityRank[a.severity];
    if (sev !== 0) return sev;
    return confidenceRank[b.confidence] - confidenceRank[a.confidence];
  });

  return {
    verdict: buildVerdict(findings, input),
    findings,
    specVersion: specs.lastVerified,
    specDisclaimer: specs.disclaimer,
  };
}
