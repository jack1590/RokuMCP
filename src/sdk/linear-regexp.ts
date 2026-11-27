import v8 from 'v8';

let enabled = false;

/**
 * A RegExp compiled with V8's linear-time engine (flag `l`): no backreferences or lookarounds,
 * and no catastrophic backtracking on long attacker-controlled text.
 * Turning the engine on affects only regexes that ask for it.
 */
export function linearRegExp(source: string, flags = ''): RegExp {
  if (!enabled) {
    v8.setFlagsFromString('--enable-experimental-regexp-engine');
    enabled = true;
  }
  return new RegExp(source, flags + 'l');
}
