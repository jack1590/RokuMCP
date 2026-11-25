#!/usr/bin/env node

import './env.js';
import { createRequire } from 'module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerDeployTools } from './tools/deploy.js';
import { registerEcpTools } from './tools/ecp.js';
import { registerScreenshotTools } from './tools/screenshot.js';
import { registerConsoleTools } from './tools/console.js';
import { registerConsoleCaptureTools } from './tools/console-capture.js';
import { registerBsprofTools } from './tools/bsprof.js';
import { registerPerfettoTools } from './tools/perfetto.js';
import { registerEditUiTools } from './tools/edit-ui.js';
import { registerStreamTools } from './tools/stream.js';
import { registerRceTools } from './tools/rce.js';
import { stopStartedRuns } from './rce.js';

const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

/** Registers every tool on a new McpServer. */
export function buildServer(): McpServer {
  const server = new McpServer({ name: 'roku-mcp', version });
  registerDeployTools(server);
  registerEcpTools(server);
  registerScreenshotTools(server);
  registerConsoleTools(server);
  registerConsoleCaptureTools(server);
  registerBsprofTools(server);
  registerPerfettoTools(server);
  registerEditUiTools(server);
  registerStreamTools(server);
  registerRceTools(server);
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
