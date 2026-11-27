import { friendlyError } from '../roku-config.js';
import { RokuError } from '../sdk/errors.js';

export type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

export const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] });
export const failure = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });

export { jsonify } from '../sdk/json.js';

/** The text a tool returns for an error: SDK errors as written, everything else through friendlyError. */
export function errorText(prefix: string, error: unknown, options: { notFound?: string } = {}): string {
  if (error instanceof RokuError) return error.bare ? error.message : `${prefix}: ${error.message}`;
  return `${prefix}: ${friendlyError(error, options)}`;
}

export const fail = (prefix: string, error: unknown, options?: { notFound?: string }): ToolResult => failure(errorText(prefix, error, options));
