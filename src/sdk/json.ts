/** JSON with bigint values as numbers (the profiler and trace reports carry bigints). */
export function jsonify(value: unknown, indent: number | undefined = 2): string {
  return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? Number(v) : v), indent);
}

/**
 * A JSON-safe copy: Buffers become {binary: true, bytes} (the first one is returned so a caller can
 * write it to a file), bigints become numbers. Other values pass through.
 */
export function toPlain(value: unknown): { data: unknown; binary?: Buffer } {
  let binary: Buffer | undefined;
  const walk = (v: unknown): unknown => {
    if (Buffer.isBuffer(v)) {
      binary ??= v;
      return { binary: true, bytes: v.length };
    }
    if (typeof v === 'bigint') return Number(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return { data: walk(value), binary };
}
