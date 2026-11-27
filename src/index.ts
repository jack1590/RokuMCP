#!/usr/bin/env node

import './env.js';
import { createRequire } from 'module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { TOOL_GROUPS } from './tools/index.js';
import { registerCodeTools } from './tools/code.js';
import { registerScreenshotTools } from './tools/screenshot.js';
import { stopStartedRuns } from './rce.js';

const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

export type ServerMode = 'full' | 'code';

/** ROKU_MCP_MODE=code selects code mode; anything else is the full tool set. */
export const serverMode = (env: NodeJS.ProcessEnv = process.env): ServerMode => (env.ROKU_MCP_MODE?.trim().toLowerCase() === 'code' ? 'code' : 'full');

/**
 * Full mode registers every tool. Code mode registers roku_run, roku_sdk_docs and roku_screenshot
 * (an image cannot come back from a script).
 */
export function buildServer(mode: ServerMode = serverMode()): McpServer {
  const server = new McpServer({ name: 'roku-mcp', version });
  if (mode === 'code') {
    registerCodeTools(server);
    registerScreenshotTools(server);
  } else {
    for (const register of TOOL_GROUPS) register(server);
  }
  return server;
}

export default function createServer(_options?: { config?: Record<string, string> }) {
  return buildServer().server;
}

const isDirectRun =
  typeof process !== 'undefined' &&
  !!process.argv[1] &&
  (() => {
    // Normalise Windows back-slashes: process.argv[1] is e.g.
    // C:\...\dist\index.js, so the forward-slash endsWith checks below would
    // never match and the stdio server would never start on Windows.
    const entry = process.argv[1].replace(/\\/g, '/');
    return (
      entry.endsWith('/index.js') ||
      entry.endsWith('/roku-mcp') ||
      entry.endsWith('/roku-mcp.js')
    );
  })();

let shuttingDown = false;
/** Stops the Cloud Device Runs this server started. MCP clients SIGKILL about 4 s after closing stdin. */
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    const result = await stopStartedRuns(3500);
    for (const f of result.failed) console.error(`roku-mcp: could not stop RCE Run ${f.runId ?? '(not shown yet)'} on Cloud Device ${f.deviceId}: ${f.message}`);
  } finally {
    process.exit(0);
  }
}

if (isDirectRun) {
  (async () => {
    const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
    await buildServer().connect(new StdioServerTransport());
    process.stdin.on('end', shutdown);
    process.stdin.on('close', shutdown);
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, shutdown);
  })();
}
