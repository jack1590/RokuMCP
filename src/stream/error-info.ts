/**
 * Normalize the diagnostic evidence a developer captures from the Roku
 * SceneGraph `Video` node when playback fails.
 *
 * The `Video` node exposes (all READ_ONLY):
 *   - state     — "error" once playback has failed
 *   - errorCode — integer in -1..-6 (see ROKU_ERROR_CODES below)
 *   - errorMsg  — short human-readable message
 *   - errorInfo — roAssociativeArray: { category, errcode, dbgmsg, drmerrcode, clipId, ignored, source, ... }
 *
 * Developers can read these via `roku_get_value` (RTA) or by printing
 * `formatJSON(m.video.errorInfo)` to the debug console. Either way the text
 * they paste in is rarely clean JSON, so the parser here is deliberately
 * tolerant: it accepts a real JSON object, a JSON string, or loose log text
 * and recovers whatever fields it can find.
 *
 * Source: https://developer.roku.com/dev/docs/video
 */

/** Roku Video-node `errorCode` catalog. */
export const ROKU_ERROR_CODES: Record<number, string> = {
  0: 'no error',
  [-1]: 'network error (server down/unreachable, or a client network setup problem)',
  [-2]: 'connection timed out',
  [-3]: 'unknown/unspecified or generic error',
  [-4]: 'empty list — no streams were specified to play',
  [-5]: 'media error — the media format is unknown or unsupported',
  [-6]: 'DRM error',
};

/** The `category` (a.k.a. `category_name`) values Roku reports in errorInfo. */
export type RokuErrorCategory = 'http' | 'drm' | 'mediaerror' | 'mediaplayer' | string;

export interface NormalizedRokuError {
  /** Top-level Video.errorCode, when present (-1..-6). */
  errorCode?: number;
  /** Plain-English meaning of errorCode, from ROKU_ERROR_CODES. */
  errorCodeMeaning?: string;
  /** Video.errorMsg, when present. */
  errorMsg?: string;
  /** errorInfo.category — http | drm | mediaerror | mediaplayer. */
  category?: RokuErrorCategory;
  /** errorInfo.errcode — the internal Roku code. */
  errcode?: number;
  /** errorInfo.dbgmsg — verbose debug message, often the single most useful field. */
  dbgmsg?: string;
  /** errorInfo.drmerrcode — error code returned by the DRM system. */
  drmerrcode?: number;
  /** errorInfo.clipId — id of the clip that failed. */
  clipId?: number;
  /** Anything else we recognized but don't have a typed slot for. */
  extra?: Record<string, unknown>;
  /** True when we could not extract anything meaningful. */
  empty: boolean;
}

function coerceNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return undefined;
    const n = Number(trimmed);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function coerceString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const t = value.trim();
    return t === '' ? undefined : t;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

/** Case-insensitive lookup across a flat record. */
function pick(obj: Record<string, unknown>, ...keys: string[]): unknown {
  const lowerMap = new Map<string, unknown>();
  for (const [k, v] of Object.entries(obj)) lowerMap.set(k.toLowerCase(), v);
  for (const key of keys) {
    const hit = lowerMap.get(key.toLowerCase());
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/**
 * Flatten a parsed object so that a nested `errorInfo` AA is merged with the
 * top-level fields. Roku devs paste both shapes:
 *   { errorCode: -6, errorInfo: { category: "drm", drmerrcode: 13 } }
 *   { category: "drm", drmerrcode: 13 }   // just the errorInfo AA
 */
function flatten(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...obj };
  const nestedKey = Object.keys(obj).find((k) => k.toLowerCase() === 'errorinfo');
  if (nestedKey && obj[nestedKey] && typeof obj[nestedKey] === 'object' && !Array.isArray(obj[nestedKey])) {
    for (const [k, v] of Object.entries(obj[nestedKey] as Record<string, unknown>)) {
      if (out[k] === undefined) out[k] = v;
    }
  }
  return out;
}

/** Try hard to JSON.parse, tolerating a leading label and trailing junk. */
function tryParseJson(text: string): Record<string, unknown> | undefined {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return undefined;
  const candidate = text.slice(start, end + 1);
  try {
    const parsed = JSON.parse(candidate);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* fall through to loose parsing */
  }
  return undefined;
}

/**
 * Loose `key: value` / `key=value` extractor for log text that isn't valid
 * JSON, e.g. `the error is==>category:"drm",drmerrcode:13,dbgmsg:":pump:..."`.
 */
function parseLoose(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const fieldNames = ['errorcode', 'errormsg', 'category', 'category_name', 'errcode', 'dbgmsg', 'drmerrcode', 'clipid', 'source'];
  for (const name of fieldNames) {
    // Matches name : "quoted" | name = value | name : value (up to a comma/brace/newline)
    const re = new RegExp(`["']?${name}["']?\\s*[:=]\\s*("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|[^,}\\n\\r]+)`, 'i');
    const m = re.exec(text);
    if (m) {
      let raw = m[1].trim();
      if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
        raw = raw.slice(1, -1);
      }
      out[name] = raw;
    }
  }
  return out;
}

/**
 * Parse and normalize whatever the developer pasted for the Video-node error.
 * Accepts a JSON object, a JSON string, or loose log text.
 */
export function normalizeRokuError(input: unknown): NormalizedRokuError {
  let source: Record<string, unknown> | undefined;

  if (input && typeof input === 'object' && !Array.isArray(input)) {
    source = input as Record<string, unknown>;
  } else if (typeof input === 'string') {
    source = tryParseJson(input) ?? parseLoose(input);
  }

  if (!source || Object.keys(source).length === 0) {
    return { empty: true };
  }

  const flat = flatten(source);

  const errorCode = coerceNumber(pick(flat, 'errorCode', 'error_code'));
  const result: NormalizedRokuError = {
    errorCode,
    errorCodeMeaning: errorCode !== undefined ? ROKU_ERROR_CODES[errorCode] : undefined,
    errorMsg: coerceString(pick(flat, 'errorMsg', 'error_string', 'error_message')),
    category: coerceString(pick(flat, 'category', 'category_name')),
    errcode: coerceNumber(pick(flat, 'errcode')),
    dbgmsg: coerceString(pick(flat, 'dbgmsg', 'debug_message')),
    drmerrcode: coerceNumber(pick(flat, 'drmerrcode')),
    clipId: coerceNumber(pick(flat, 'clipId', 'clipid', 'clip_id')),
    empty: false,
  };

  const recognized = new Set([
    'errorcode', 'error_code', 'errormsg', 'error_string', 'error_message',
    'category', 'category_name', 'errcode', 'dbgmsg', 'debug_message',
    'drmerrcode', 'clipid', 'clip_id', 'errorinfo',
  ]);
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(flat)) {
    if (!recognized.has(k.toLowerCase())) extra[k] = v;
  }
  if (Object.keys(extra).length > 0) result.extra = extra;

  const hasAnything =
    result.errorCode !== undefined ||
    result.errorMsg !== undefined ||
    result.category !== undefined ||
    result.errcode !== undefined ||
    result.dbgmsg !== undefined ||
    result.drmerrcode !== undefined;
  result.empty = !hasAnything;

  return result;
}
