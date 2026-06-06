/**
 * Parse HLS (m3u8) and DASH (mpd) manifests into a normalized summary the
 * correlation engine can reason about: declared codecs, container/segment
 * format, DRM signaling, and segment durations.
 *
 * The manifest bytes can come from three places (in priority order handled by
 * the caller): pasted `content`, an HTTP `url` fetch, or a response body that
 * was extracted from a Charles session entry.
 *
 * We intentionally do NOT validate against Roku's spec here — that judgment
 * lives in diagnose.ts so the spec data stays in one (dated, cited) place.
 */

import axios from 'axios';
import { XMLParser } from 'fast-xml-parser';

const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

export type StreamFormat = 'hls' | 'dash';

/** A normalized DRM signal found in the manifest. */
export interface ManifestDrmSignal {
  /** Widevine | PlayReady | AES-128 | ClearKey | Verimatrix | FairPlay | unknown */
  system: string;
  /** The raw schemeIdUri (DASH) or KEYFORMAT/METHOD (HLS) we matched on. */
  raw: string;
  /** DASH only: whether a <cenc:pssh> was present (helps Roku start faster). */
  hasPssh?: boolean;
}

/** A single video/audio rendition declared by the manifest. */
export interface ManifestTrack {
  type: 'video' | 'audio' | 'muxed' | 'unknown';
  /** Raw codec string as declared, e.g. "avc1.640028,mp4a.40.2". */
  codecs?: string;
  /** Friendly codec families we recognized, e.g. ["AVC", "AAC"]. */
  codecFamilies: string[];
  bandwidth?: number;
  resolution?: string;
  mimeType?: string;
  /** H.264/AVC level x10 (e.g. 51 = level 5.1), when derivable from the codec string. */
  avcLevel?: number;
  /** HEVC level x10 (e.g. 61 = level 6.1), when derivable from the codec string. */
  hevcLevel?: number;
}

export interface ManifestSummary {
  format: StreamFormat;
  /** Whether this looked like a master/multivariant playlist (HLS) or full MPD (DASH). */
  isMultivariant: boolean;
  tracks: ManifestTrack[];
  drm: ManifestDrmSignal[];
  /** Container hint: "ts" | "fmp4" | "cmaf" | "mixed" | "unknown". */
  container: string;
  /** Whether the container was observed from segment evidence (vs. defaulted). */
  containerResolved?: boolean;
  /** Whether audio+video appear muxed in a single rendition. */
  muxed: boolean;
  /** Max segment/target duration in seconds, if derivable. */
  maxSegmentSeconds?: number;
  /** Whether the manifest is a live stream (DASH dynamic / HLS without ENDLIST). */
  isLive: boolean;
  /** Distinct video codec families across all tracks. */
  videoCodecs: string[];
  /** Distinct audio codec families across all tracks. */
  audioCodecs: string[];
  /** Non-fatal notes about parsing (e.g. "media playlist; variants not analyzed"). */
  notes: string[];
}

export interface ManifestSource {
  /** Raw manifest text. */
  content?: string;
  /** URL to fetch the manifest from (used only if content is absent). */
  url?: string;
  /** Forced format; otherwise auto-detected. */
  format?: StreamFormat;
}

/**
 * Extract the H.264/AVC level from an RFC 6381 codec string.
 * `avc1.PPCCLL` where LL is the level as a hex byte (e.g. `avc1.640033` -> 0x33 = 51 -> level 5.1).
 * Returns the level as an integer x10 (e.g. 51 means 5.1), or undefined.
 */
export function avcLevel(token: string): number | undefined {
  const m = /^avc[13]\.[0-9a-f]{2}[0-9a-f]{2}([0-9a-f]{2})$/i.exec(token.trim());
  if (!m) return undefined;
  const lvl = parseInt(m[1], 16);
  return Number.isFinite(lvl) ? lvl : undefined;
}

/**
 * Extract the HEVC level from an RFC 6381 codec string and return it x10.
 * `hvc1.A.B.LXXX.YY` where `LXXX` is the general_level_idc (e.g. L183).
 * level_idc = general_level * 30, so 183 -> 6.1 (returned as 61), 153 -> 5.1 (51),
 * 123 -> 4.1 (41). Returns level x10, or undefined.
 */
export function hevcLevel(token: string): number | undefined {
  const m = /^(?:hvc1|hev1)\.[^.]*\.[^.]*\.[LH](\d+)/i.exec(token.trim());
  if (!m) return undefined;
  const idc = parseInt(m[1], 10);
  if (!Number.isFinite(idc)) return undefined;
  // general_level_idc = level * 30; level x10 = idc / 3.
  return Math.round(idc / 3);
}

/** Map a single codec token to a friendly family name. */
export function codecFamily(token: string): string | undefined {
  const t = token.trim().toLowerCase();
  if (t === '') return undefined;
  if (t.startsWith('avc1') || t.startsWith('avc3') || t.startsWith('h264')) return 'AVC';
  if (t.startsWith('hvc1') || t.startsWith('hev1') || t.startsWith('h265') || t.startsWith('hevc')) return 'HEVC';
  if (t.startsWith('vp09') || t === 'vp9') return 'VP9';
  if (t.startsWith('vp08') || t === 'vp8') return 'VP8';
  if (t.startsWith('av01') || t === 'av1') return 'AV1';
  if (t.startsWith('dvav') || t.startsWith('dvhe') || t.startsWith('dvh1') || t.startsWith('dav1')) return 'DolbyVision';
  if (t.startsWith('mp4a') || t === 'aac') return 'AAC';
  if (t === 'mp3' || t === 'mp4a.40.34' || t.startsWith('mp4a.6b')) return 'MP3';
  if (t === 'ac-3' || t === 'ac3') return 'DD';
  if (t === 'ec-3' || t === 'eac3' || t === 'ec3') return 'DD+';
  if (t.startsWith('dts') || t === 'dtse' || t === 'dtsc' || t === 'dtsh') return 'DTS';
  if (t === 'opus') return 'Opus';
  if (t === 'flac' || t === 'fLaC'.toLowerCase()) return 'FLAC';
  if (t === 'vorbis') return 'Vorbis';
  if (t.startsWith('mp2') || t.startsWith('mpeg2') || t === 'mp2v') return 'MPEG-2';
  return undefined;
}

/** Categorize a codec token as video, audio, or unknown. */
function codecKind(token: string): 'video' | 'audio' | 'unknown' {
  const family = codecFamily(token);
  if (!family) return 'unknown';
  if (['AVC', 'HEVC', 'VP9', 'VP8', 'AV1', 'DolbyVision', 'MPEG-2'].includes(family)) return 'video';
  if (['AAC', 'MP3', 'DD', 'DD+', 'DTS', 'Opus', 'FLAC', 'Vorbis'].includes(family)) return 'audio';
  return 'unknown';
}

function familiesFor(codecs: string | undefined): string[] {
  if (!codecs) return [];
  const families: string[] = [];
  for (const token of codecs.split(',')) {
    const fam = codecFamily(token);
    if (fam && !families.includes(fam)) families.push(fam);
  }
  return families;
}

const WIDEVINE_UUID = 'edef8ba9-79d6-4ace-a3c8-27dcd51d21ed';
const PLAYREADY_UUID = '9a04f079-9840-4286-ab92-e65be0885f95';
const CLEARKEY_UUID = 'e2719d58-a985-b3c9-781a-b030af78d30e';
const FAIRPLAY_UUID = '94ce86fb-07ff-4f43-adb8-93d2fa968ca2';
const VERIMATRIX_HINT = 'verimatrix';

function drmSystemFromSchemeId(schemeIdUri: string): string {
  const s = schemeIdUri.toLowerCase();
  if (s.includes(WIDEVINE_UUID)) return 'Widevine';
  if (s.includes(PLAYREADY_UUID) || s.includes('com.microsoft.playready')) return 'PlayReady';
  if (s.includes(CLEARKEY_UUID) || s.includes('clearkey') || s.includes('w3.org/.../clearkey')) return 'ClearKey';
  if (s.includes(FAIRPLAY_UUID) || s.includes('fairplay') || s.includes('apple.com')) return 'FairPlay';
  if (s.includes(VERIMATRIX_HINT)) return 'Verimatrix';
  if (s.includes('mp4protection')) return 'cenc (mp4protection)';
  return 'unknown';
}

/** Auto-detect HLS vs DASH from text content and/or a URL. */
export function detectFormat(content: string | undefined, url: string | undefined, forced?: StreamFormat): StreamFormat {
  if (forced) return forced;
  if (content) {
    const head = content.slice(0, 4096);
    if (/#EXTM3U/i.test(head)) return 'hls';
    if (/<MPD[\s>]/i.test(head) || /urn:mpeg:dash/i.test(head)) return 'dash';
  }
  if (url) {
    const lower = url.split('?')[0].toLowerCase();
    if (lower.endsWith('.m3u8') || lower.endsWith('.m3u')) return 'hls';
    if (lower.endsWith('.mpd')) return 'dash';
  }
  // Default to HLS — it is by far the most common Roku format.
  return 'hls';
}

/** Parse a value like RESOLUTION=1920x1080 / BANDWIDTH=4500000 from an attr line. */
function parseAttrList(line: string): Record<string, string> {
  const out: Record<string, string> = {};
  // Attribute lists are comma-separated, but quoted values may contain commas.
  const re = /([A-Z0-9-]+)=("(?:[^"]*)"|[^,]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    let val = m[2];
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    out[m[1]] = val;
  }
  return out;
}

function parseHls(content: string): ManifestSummary {
  const lines = content.split(/\r?\n/);
  const tracks: ManifestTrack[] = [];
  const drm: ManifestDrmSignal[] = [];
  const notes: string[] = [];
  let isMultivariant = false;
  let maxSegmentSeconds: number | undefined;
  let isLive = true;
  let sawSegments = false;
  let container = 'ts'; // HLS media segments default to MPEG-TS unless we see fMP4.
  let containerResolved = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '') continue;

    if (line.startsWith('#EXT-X-STREAM-INF')) {
      isMultivariant = true;
      const attrs = parseAttrList(line.slice(line.indexOf(':') + 1));
      const codecs = attrs['CODECS'];
      const families = familiesFor(codecs);
      const kinds = new Set((codecs ?? '').split(',').map(codecKind).filter((k) => k !== 'unknown'));
      // A variant that references a separate audio rendition (AUDIO="group") is
      // demuxed even though its CODECS lists the audio codec too (the HLS spec
      // requires CODECS to enumerate every codec across the variant + its groups).
      // Only a variant with no AUDIO group and both kinds inline is truly muxed.
      const hasAudioGroup = !!attrs['AUDIO'];
      let type: ManifestTrack['type'] = 'unknown';
      if (kinds.has('video') && kinds.has('audio') && !hasAudioGroup) type = 'muxed';
      else if (kinds.has('video')) type = 'video';
      else if (kinds.has('audio')) type = 'audio';
      tracks.push({
        type,
        codecs,
        codecFamilies: families,
        bandwidth: attrs['BANDWIDTH'] ? Number(attrs['BANDWIDTH']) : undefined,
        resolution: attrs['RESOLUTION'],
        avcLevel: avcLevelFromCodecs(codecs),
        hevcLevel: hevcLevelFromCodecs(codecs),
      });
    } else if (line.startsWith('#EXT-X-MEDIA')) {
      const attrs = parseAttrList(line.slice(line.indexOf(':') + 1));
      const t = (attrs['TYPE'] ?? '').toUpperCase();
      if (t === 'AUDIO') {
        tracks.push({ type: 'audio', codecFamilies: [] });
      }
    } else if (line.startsWith('#EXT-X-KEY') || line.startsWith('#EXT-X-SESSION-KEY')) {
      const attrs = parseAttrList(line.slice(line.indexOf(':') + 1));
      const method = (attrs['METHOD'] ?? '').toUpperCase();
      const keyformat = (attrs['KEYFORMAT'] ?? '').toLowerCase();
      if (method === 'NONE') continue;
      let system = 'unknown';
      if (method === 'AES-128' || method === 'SAMPLE-AES' || method === 'SAMPLE-AES-CTR') {
        system = method === 'AES-128' ? 'AES-128' : 'SAMPLE-AES';
      }
      if (keyformat.includes('widevine')) system = 'Widevine';
      else if (keyformat.includes('playready') || keyformat.includes('com.microsoft.playready')) system = 'PlayReady';
      else if (keyformat.includes('com.apple.streamingkeydelivery') || keyformat.includes('fairplay')) system = 'FairPlay';
      if (!drm.some((d) => d.system === system)) {
        drm.push({ system, raw: line });
      }
    } else if (line.startsWith('#EXT-X-MAP') || /\.m4s|\.mp4|\.cmf/i.test(line)) {
      container = 'fmp4';
      containerResolved = true;
    } else if (!line.startsWith('#') && /\.ts(\?|$)/i.test(line)) {
      container = 'ts';
      containerResolved = true;
    } else if (line.startsWith('#EXT-X-TARGETDURATION')) {
      const v = Number(line.split(':')[1]);
      if (Number.isFinite(v)) maxSegmentSeconds = Math.max(maxSegmentSeconds ?? 0, v);
    } else if (line.startsWith('#EXTINF')) {
      sawSegments = true;
      const v = parseFloat(line.split(':')[1]);
      if (Number.isFinite(v)) maxSegmentSeconds = Math.max(maxSegmentSeconds ?? 0, v);
    } else if (line.startsWith('#EXT-X-ENDLIST')) {
      isLive = false;
    } else if (line.startsWith('#EXT-X-PLAYLIST-TYPE')) {
      if (/VOD/i.test(line)) isLive = false;
    }
  }

  if (isMultivariant) {
    notes.push('Master/multivariant playlist parsed. Per-variant media playlists (segment list) were not fetched; segment-level details are limited.');
    isLive = false; // master playlists themselves do not carry the live flag
  } else if (sawSegments) {
    notes.push('Media (single-variant) playlist parsed.');
  }

  const videoCodecs = distinct(tracks.flatMap((t) => t.codecFamilies.filter((f) => codecKind(f) === 'video' || ['AVC', 'HEVC', 'VP9', 'VP8', 'AV1', 'DolbyVision', 'MPEG-2'].includes(f))));
  const audioCodecs = distinct(tracks.flatMap((t) => t.codecFamilies.filter((f) => ['AAC', 'MP3', 'DD', 'DD+', 'DTS', 'Opus', 'FLAC', 'Vorbis'].includes(f))));
  const muxed = tracks.some((t) => t.type === 'muxed');

  return {
    format: 'hls',
    isMultivariant,
    tracks,
    drm,
    container,
    containerResolved,
    muxed,
    maxSegmentSeconds,
    isLive,
    videoCodecs,
    audioCodecs,
    notes,
  };
}

function asArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

function parseDash(content: string): ManifestSummary {
  const parsed = xmlParser.parse(content);
  const mpd = parsed.MPD ?? parsed.mpd ?? {};
  const tracks: ManifestTrack[] = [];
  const drm: ManifestDrmSignal[] = [];
  const notes: string[] = [];
  let container = 'fmp4'; // DASH is fragmented MP4 / CMAF.
  let maxSegmentSeconds: number | undefined;

  const isLive = String(mpd['@_type'] ?? '').toLowerCase() === 'dynamic';

  const periods = asArray(mpd.Period);
  for (const period of periods) {
    const adaptationSets = asArray(period?.AdaptationSet);
    for (const as of adaptationSets) {
      const asMime = as['@_mimeType'] as string | undefined;
      const asCodecs = as['@_codecs'] as string | undefined;
      const contentType = (as['@_contentType'] as string | undefined) ?? '';

      // DRM signaling at the AdaptationSet level.
      for (const cp of asArray(as.ContentProtection)) {
        const schemeIdUri = (cp['@_schemeIdUri'] as string | undefined) ?? '';
        const system = drmSystemFromSchemeId(schemeIdUri);
        const hasPssh = !!(cp['cenc:pssh'] ?? cp['pssh'] ?? cp['cenc:Pssh']);
        const existing = drm.find((d) => d.system === system);
        if (existing) {
          if (hasPssh) existing.hasPssh = true;
        } else if (system !== 'unknown' || schemeIdUri) {
          drm.push({ system, raw: schemeIdUri, hasPssh });
        }
      }

      // Segment duration from SegmentTemplate (AS or Representation level).
      const segTemplate = as.SegmentTemplate;
      if (segTemplate) {
        const dur = Number(segTemplate['@_duration']);
        const timescale = Number(segTemplate['@_timescale'] ?? 1);
        if (Number.isFinite(dur) && timescale > 0) {
          maxSegmentSeconds = Math.max(maxSegmentSeconds ?? 0, dur / timescale);
        }
      }

      const representations = asArray(as.Representation);
      if (representations.length === 0) {
        // Some manifests put codecs only on the AdaptationSet.
        addDashTrack(tracks, asCodecs, asMime, contentType, undefined, undefined);
      }
      for (const rep of representations) {
        const codecs = (rep['@_codecs'] as string | undefined) ?? asCodecs;
        const mime = (rep['@_mimeType'] as string | undefined) ?? asMime;
        const width = rep['@_width'];
        const height = rep['@_height'];
        const bandwidth = rep['@_bandwidth'] ? Number(rep['@_bandwidth']) : undefined;
        const resolution = width && height ? `${width}x${height}` : undefined;
        addDashTrack(tracks, codecs, mime, contentType, resolution, bandwidth);

        const repSeg = rep.SegmentTemplate;
        if (repSeg) {
          const dur = Number(repSeg['@_duration']);
          const timescale = Number(repSeg['@_timescale'] ?? 1);
          if (Number.isFinite(dur) && timescale > 0) {
            maxSegmentSeconds = Math.max(maxSegmentSeconds ?? 0, dur / timescale);
          }
        }
      }
    }
  }

  if (tracks.length === 0) {
    notes.push('No Representation/AdaptationSet codec info found — the MPD may be malformed or use an unusual structure.');
  }

  const videoCodecs = distinct(tracks.filter((t) => t.type === 'video' || t.type === 'muxed').flatMap((t) => t.codecFamilies));
  const audioCodecs = distinct(tracks.filter((t) => t.type === 'audio' || t.type === 'muxed').flatMap((t) => t.codecFamilies));
  const muxed = tracks.some((t) => t.type === 'muxed');

  return {
    format: 'dash',
    isMultivariant: true,
    tracks,
    drm,
    container,
    muxed,
    maxSegmentSeconds,
    isLive,
    videoCodecs: videoCodecs.filter((f) => ['AVC', 'HEVC', 'VP9', 'VP8', 'AV1', 'DolbyVision', 'MPEG-2'].includes(f)),
    audioCodecs: audioCodecs.filter((f) => ['AAC', 'MP3', 'DD', 'DD+', 'DTS', 'Opus', 'FLAC', 'Vorbis'].includes(f)),
    notes,
  };
}

function addDashTrack(
  tracks: ManifestTrack[],
  codecs: string | undefined,
  mime: string | undefined,
  contentType: string,
  resolution: string | undefined,
  bandwidth: number | undefined
): void {
  const families = familiesFor(codecs);
  let type: ManifestTrack['type'] = 'unknown';
  const mimeLower = (mime ?? '').toLowerCase();
  const ctLower = contentType.toLowerCase();
  if (mimeLower.includes('video') || ctLower === 'video') type = 'video';
  else if (mimeLower.includes('audio') || ctLower === 'audio') type = 'audio';
  else {
    const kinds = new Set((codecs ?? '').split(',').map(codecKind).filter((k) => k !== 'unknown'));
    if (kinds.has('video') && kinds.has('audio')) type = 'muxed';
    else if (kinds.has('video')) type = 'video';
    else if (kinds.has('audio')) type = 'audio';
  }
  tracks.push({ type, codecs, codecFamilies: families, mimeType: mime, resolution, bandwidth, avcLevel: avcLevelFromCodecs(codecs), hevcLevel: hevcLevelFromCodecs(codecs) });
}

/** First AVC level found across the comma-separated codec tokens. */
function avcLevelFromCodecs(codecs: string | undefined): number | undefined {
  if (!codecs) return undefined;
  for (const token of codecs.split(',')) {
    const lvl = avcLevel(token);
    if (lvl !== undefined) return lvl;
  }
  return undefined;
}

function hevcLevelFromCodecs(codecs: string | undefined): number | undefined {
  if (!codecs) return undefined;
  for (const token of codecs.split(',')) {
    const lvl = hevcLevel(token);
    if (lvl !== undefined) return lvl;
  }
  return undefined;
}

function distinct<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

/** Fetch + parse a manifest from any of the supported sources. */
export async function loadManifest(source: ManifestSource): Promise<ManifestSummary> {
  let content = source.content;
  const url = source.url;

  if (!content && url) {
    const response = await axios.get(url, { responseType: 'text', transformResponse: [(d) => d] });
    content = typeof response.data === 'string' ? response.data : String(response.data);
  }

  if (!content) {
    throw new Error('No manifest content available: provide `content`, a fetchable `url`, or a Charles session with a manifest response.');
  }

  const format = detectFormat(content, url, source.format);
  const summary = parseManifestText(content, format);

  // For an HLS master playlist the container (TS vs fMP4/CMAF) only shows up in
  // the child media playlist. The TS-vs-fMP4 distinction is decisive for the
  // muxed-audio diagnosis (muxed TS plays; muxed fMP4 goes silent on Roku), so
  // when we have a URL and the master didn't reveal it, fetch one child to learn
  // the real container. Best-effort: failures leave the heuristic in place.
  if (format === 'hls' && summary.isMultivariant && url && !summary.containerResolved) {
    try {
      const childUri = firstChildPlaylistUri(content);
      if (childUri) {
        const childUrl = resolveUrl(url, childUri);
        const resp = await axios.get(childUrl, { responseType: 'text', transformResponse: [(d) => d], timeout: 8000 });
        const childText = typeof resp.data === 'string' ? resp.data : String(resp.data);
        const child = parseHls(childText);
        summary.container = child.container;
        summary.containerResolved = child.containerResolved;
        if (child.maxSegmentSeconds !== undefined) summary.maxSegmentSeconds = child.maxSegmentSeconds;
        summary.notes.push(`Child media playlist fetched to resolve container: ${child.container}.`);
      }
    } catch {
      summary.notes.push('Could not fetch a child media playlist to confirm the container; container is inferred from the master only.');
    }
  }

  return summary;
}

/** First non-comment URI line following an EXT-X-STREAM-INF in a master playlist. */
function firstChildPlaylistUri(masterText: string): string | undefined {
  const lines = masterText.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().startsWith('#EXT-X-STREAM-INF')) {
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j].trim();
        if (l === '' || l.startsWith('#')) continue;
        return l;
      }
    }
  }
  return undefined;
}

/** Resolve a (possibly relative) playlist URI against the master URL. */
function resolveUrl(base: string, ref: string): string {
  try {
    return new URL(ref, base).toString();
  } catch {
    return ref;
  }
}

/** Parse already-obtained manifest text. */
export function parseManifestText(content: string, format: StreamFormat): ManifestSummary {
  return format === 'dash' ? parseDash(content) : parseHls(content);
}
