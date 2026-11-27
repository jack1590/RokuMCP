import type { TargetParams } from '../roku-config.js';

/**
 * The options a call runs with: undefined values are dropped, and a call that names its own
 * host or rceDevice replaces the whole default target (password included), so host cannot win
 * over a per-call rceDevice by precedence.
 */
export function withDefaults<O extends object>(defaults: TargetParams, options?: O): O {
  const given = Object.fromEntries(Object.entries(options ?? {}).filter(([, v]) => v !== undefined)) as O & TargetParams;
  return { ...(given.host || given.rceDevice ? {} : defaults), ...given } as O;
}
