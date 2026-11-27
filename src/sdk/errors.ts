/**
 * An expected failure the SDK raises itself (bad arguments, missing state, unsupported target).
 * Device, network and RCE errors are left as they are, so callers can still map them with
 * friendlyError.
 */
export class RokuError extends Error {
  readonly code: string;
  /** The message is complete as is: the MCP tools show it without their "<Tool> failed:" prefix. */
  readonly bare: boolean;

  constructor(code: string, message: string, options: { bare?: boolean } = {}) {
    super(message);
    this.name = 'RokuError';
    this.code = code;
    this.bare = options.bare ?? false;
  }
}
