import dotenv from 'dotenv';

/**
 * Empty ROKU_* values (e.g. unset plugin user_config) would hide a project .env: dotenv never overrides
 * defined vars. Unexpanded client placeholders (`${user_config.ROKU_RCE_DEVICE}`) are dropped too, or
 * one would route every LAN call to RCE.
 */
export function dropEmptyRokuVars(env: NodeJS.ProcessEnv = process.env): void {
  for (const k of Object.keys(env)) if (k.startsWith('ROKU_') && (env[k] === '' || env[k]!.startsWith('${'))) delete env[k];
}

dropEmptyRokuVars();
// ROKU_MCP_ENV_FILE: absolute path, for clients that cannot set the server's cwd.
if (process.env.ROKU_MCP_ENV_FILE) dotenv.config({ path: process.env.ROKU_MCP_ENV_FILE, quiet: true });
dotenv.config({ quiet: true });
