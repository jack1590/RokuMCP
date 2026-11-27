/** JSON with bigint values as numbers (the profiler and trace reports carry bigints). */
export function jsonify(value: unknown, indent: number | undefined = 2): string {
  return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? Number(v) : v), indent);
}
