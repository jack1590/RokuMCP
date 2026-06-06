/**
 * Parse a Charles Proxy session (or HAR capture) into normalized HTTP entries
 * and classify each request as manifest / segment / license / key / other.
 *
 * Supported export formats:
 *   - Charles ".chlsj" (JSON Session File): either a single JSON array of
 *     request objects, or newline-delimited JSON (one object per line).
 *   - ".har" (HTTP Archive): the standard `{ log: { entries: [...] } }` shape
 *     produced by Charles "Export > HAR" and by browser devtools.
 *
 * NOTE: the binary ".chls" format is NOT supported (it is a proprietary binary
 * blob). Callers should instruct the user to export as ".chlsj" or ".har".
 *
 * Charles .chlsj entry shape (varies slightly by version) roughly looks like:
 *   {
 *     "host": "...", "method": "GET", "path": "/x.m3u8",
 *     "scheme": "https", "status": 200,
 *     "request":  { "header": { "headers": [{ "name", "value" }] }, "body": {...} },
 *     "response": { "header": { "headers": [...] }, "body": { "text"|"encoded", "contentType" } },
 *     "times": { "totalDuration": 123 }
 *   }
 */

export interface NormalizedHttpEntry {
  url: string;
  host: string;
  path: string;
  method: string;
  status: number;
  reqHeaders: Record<string, string>;
  respHeaders: Record<string, string>;
  /** Decoded response body text when available (manifests, license errors). */
  respBody?: string;
  /** Response content-type, lowercased. */
  mimeType?: string;
  durationMs?: number;
  kind: HttpEntryKind;
}

export type HttpEntryKind = 'manifest' | 'segment' | 'license' | 'key' | 'other';

export interface CharlesSession {
  entries: NormalizedHttpEntry[];
  /** Entries with a non-2xx status or otherwise suspicious response. */
  failing: NormalizedHttpEntry[];
  format: 'chlsj' | 'har';
  notes: string[];
}

function lowerHeaderMap(headers: Array<{ name?: string; value?: string }> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!Array.isArray(headers)) return out;
  for (const h of headers) {
    if (h && typeof h.name === 'string') {
      out[h.name.toLowerCase()] = typeof h.value === 'string' ? h.value : String(h.value ?? '');
    }
  }
  return out;
}

function classify(url: string, method: string, mimeType: string | undefined, reqHeaders: Record<string, string>): HttpEntryKind {
  const path = url.split('?')[0].toLowerCase();
  const mime = (mimeType ?? '').toLowerCase();

  if (path.endsWith('.m3u8') || path.endsWith('.mpd') || path.endsWith('.m3u') ||
      mime.includes('mpegurl') || mime.includes('dash+xml')) {
    return 'manifest';
  }
  if (path.endsWith('.ts') || path.endsWith('.m4s') || path.endsWith('.mp4') ||
      path.endsWith('.cmfv') || path.endsWith('.cmfa') || path.endsWith('.cmft') ||
      path.endsWith('.aac') || path.endsWith('.m4a') || path.endsWith('.m4v') ||
      mime.includes('video/') || mime.includes('audio/') || mime.includes('iso.segment')) {
    return 'segment';
  }
  if (path.endsWith('.key') || mime.includes('pskc+xml')) {
    return 'key';
  }
  // License requests: typically POST to a DRM endpoint, often octet-stream or json.
  const accept = (reqHeaders['accept'] ?? '').toLowerCase();
  const ct = (reqHeaders['content-type'] ?? '').toLowerCase();
  if (method.toUpperCase() === 'POST' &&
      (path.includes('license') || path.includes('licence') || path.includes('widevine') ||
       path.includes('playready') || path.includes('drm') || path.includes('wv/') ||
       path.includes('/cenc') || ct.includes('octet-stream') || accept.includes('octet-stream'))) {
    return 'license';
  }
  if (path.includes('license') || path.includes('widevine') || path.includes('playready') || path.includes('/drm')) {
    return 'license';
  }
  return 'other';
}

function decodeBody(body: any): { text?: string; mimeType?: string } {
  if (!body || typeof body !== 'object') return {};
  const contentType =
    typeof body.contentType === 'string' ? body.contentType.toLowerCase() :
    typeof body.mimeType === 'string' ? body.mimeType.toLowerCase() : undefined;

  // Charles uses `text` (plain), or `encoded` (base64) with `encoding: "base64"`.
  if (typeof body.text === 'string') {
    if ((body.encoding ?? '').toLowerCase() === 'base64') {
      try { return { text: Buffer.from(body.text, 'base64').toString('utf-8'), mimeType: contentType }; }
      catch { return { mimeType: contentType }; }
    }
    return { text: body.text, mimeType: contentType };
  }
  if (typeof body.encoded === 'string') {
    try { return { text: Buffer.from(body.encoded, 'base64').toString('utf-8'), mimeType: contentType }; }
    catch { return { mimeType: contentType }; }
  }
  return { mimeType: contentType };
}

/** Normalize one Charles .chlsj entry. */
function normalizeChlsjEntry(raw: any): NormalizedHttpEntry | undefined {
  if (!raw || typeof raw !== 'object') return undefined;

  const scheme = raw.scheme ?? raw.protocol ?? 'https';
  const host = raw.host ?? raw.remoteHost ?? '';
  const path = raw.path ?? raw.query ? `${raw.path ?? ''}${raw.query ? '?' + raw.query : ''}` : raw.path ?? '/';
  const explicitUrl = typeof raw.url === 'string' ? raw.url : undefined;
  const url = explicitUrl ?? (host ? `${scheme}://${host}${path.startsWith('/') ? '' : '/'}${path}` : path);

  const method = (raw.method ?? 'GET').toUpperCase();
  const status = Number(raw.status ?? raw.responseCode ?? raw.response?.status ?? 0) || 0;

  const reqHeaders = lowerHeaderMap(raw.request?.header?.headers ?? raw.request?.headers);
  const respHeaders = lowerHeaderMap(raw.response?.header?.headers ?? raw.response?.headers);

  const decoded = decodeBody(raw.response?.body);
  const mimeType = decoded.mimeType ?? respHeaders['content-type']?.split(';')[0]?.toLowerCase();
  const durationMs =
    typeof raw.times?.totalDuration === 'number' ? raw.times.totalDuration :
    typeof raw.totalDuration === 'number' ? raw.totalDuration : undefined;

  const kind = classify(url, method, mimeType, reqHeaders);

  return {
    url,
    host: host || safeHost(url),
    path: path || new URLSafe(url).pathname,
    method,
    status,
    reqHeaders,
    respHeaders,
    respBody: decoded.text,
    mimeType,
    durationMs,
    kind,
  };
}

/** Normalize one HAR entry. */
function normalizeHarEntry(raw: any): NormalizedHttpEntry | undefined {
  if (!raw || typeof raw !== 'object' || !raw.request) return undefined;
  const url = raw.request.url ?? '';
  const method = (raw.request.method ?? 'GET').toUpperCase();
  const status = Number(raw.response?.status ?? 0) || 0;

  const reqHeaders = lowerHeaderMap(raw.request.headers);
  const respHeaders = lowerHeaderMap(raw.response?.headers);

  const harContent = raw.response?.content;
  let respBody: string | undefined;
  let mimeType: string | undefined = harContent?.mimeType?.split(';')[0]?.toLowerCase();
  if (harContent && typeof harContent.text === 'string') {
    if ((harContent.encoding ?? '').toLowerCase() === 'base64') {
      try { respBody = Buffer.from(harContent.text, 'base64').toString('utf-8'); } catch { /* ignore */ }
    } else {
      respBody = harContent.text;
    }
  }
  if (!mimeType) mimeType = respHeaders['content-type']?.split(';')[0]?.toLowerCase();

  const durationMs = typeof raw.time === 'number' ? raw.time : undefined;
  const kind = classify(url, method, mimeType, reqHeaders);

  return {
    url,
    host: safeHost(url),
    path: new URLSafe(url).pathname,
    method,
    status,
    reqHeaders,
    respHeaders,
    respBody,
    mimeType,
    durationMs,
    kind,
  };
}

/** A tiny URL helper that never throws on malformed input. */
class URLSafe {
  pathname = '/';
  host = '';
  constructor(url: string) {
    try {
      const u = new URL(url);
      this.pathname = u.pathname;
      this.host = u.host;
    } catch {
      const m = /^[a-z]+:\/\/([^/]+)(\/[^?#]*)?/i.exec(url);
      if (m) { this.host = m[1]; this.pathname = m[2] ?? '/'; }
    }
  }
}

function safeHost(url: string): string {
  return new URLSafe(url).host;
}

/** Parse the raw text of a Charles .chlsj or .har file. */
export function parseCharlesText(text: string): CharlesSession {
  const notes: string[] = [];
  const trimmed = text.trimStart();

  // HAR detection.
  if (trimmed.startsWith('{')) {
    try {
      const obj = JSON.parse(text);
      if (obj && obj.log && Array.isArray(obj.log.entries)) {
        const entries = obj.log.entries
          .map(normalizeHarEntry)
          .filter((e: NormalizedHttpEntry | undefined): e is NormalizedHttpEntry => !!e);
        return finalize(entries, 'har', notes);
      }
      // A single .chlsj object (rare) — treat as a one-element array.
      const one = normalizeChlsjEntry(obj);
      if (one) return finalize([one], 'chlsj', notes);
    } catch {
      /* fall through to line-delimited parsing */
    }
  }

  // .chlsj as a JSON array.
  if (trimmed.startsWith('[')) {
    try {
      const arr = JSON.parse(text);
      if (Array.isArray(arr)) {
        const entries = arr
          .map(normalizeChlsjEntry)
          .filter((e): e is NormalizedHttpEntry => !!e);
        return finalize(entries, 'chlsj', notes);
      }
    } catch {
      /* fall through */
    }
  }

  // Newline-delimited JSON objects (one Charles record per line).
  const lineEntries: NormalizedHttpEntry[] = [];
  let parsedAny = false;
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim().replace(/,$/, '');
    if (t === '' || t === '[' || t === ']') continue;
    try {
      const obj = JSON.parse(t);
      const norm = normalizeChlsjEntry(obj);
      if (norm) { lineEntries.push(norm); parsedAny = true; }
    } catch {
      /* skip non-JSON lines */
    }
  }
  if (parsedAny) {
    notes.push('Parsed as newline-delimited JSON (one record per line).');
    return finalize(lineEntries, 'chlsj', notes);
  }

  throw new Error(
    'Could not parse the Charles session. Export it from Charles as a "JSON Session File" (.chlsj) or HAR (.har). ' +
    'Binary ".chls" files are not supported.'
  );
}

function finalize(entries: NormalizedHttpEntry[], format: 'chlsj' | 'har', notes: string[]): CharlesSession {
  const failing = entries.filter(isFailing);
  if (entries.length === 0) notes.push('No HTTP entries were found in the session.');
  return { entries, failing, format, notes };
}

/** A request is "failing" if it has a non-2xx status, or an empty body where one is expected. */
export function isFailing(entry: NormalizedHttpEntry): boolean {
  if (entry.status === 0) return false; // unknown — don't flag
  if (entry.status >= 400) return true;
  if (entry.status >= 300 && entry.status < 400) {
    // Redirects on license/manifest are a common Roku gotcha.
    return entry.kind === 'license' || entry.kind === 'manifest';
  }
  return false;
}
