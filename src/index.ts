#!/usr/bin/env node

import 'dotenv/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerDeployTools } from './tools/deploy.js';
import { registerEcpTools } from './tools/ecp.js';
import { registerScreenshotTools } from './tools/screenshot.js';
import { registerConsoleTools } from './tools/console.js';
import { registerBsprofTools } from './tools/bsprof.js';
import { registerPerfettoTools } from './tools/perfetto.js';
import { registerEditUiTools } from './tools/edit-ui.js';
import { registerStreamTools } from './tools/stream.js';

export default function createServer(_options?: { config?: Record<string, string> }) {
  const server = new McpServer({
    name: 'roku-mcp',
    version: '1.7.0',
  });

  registerDeployTools(server);
  registerEcpTools(server);
  registerScreenshotTools(server);
  registerConsoleTools(server);
  registerBsprofTools(server);
  registerPerfettoTools(server);
  registerEditUiTools(server);
  registerStreamTools(server);

  return server.server;
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

if (isDirectRun) {
  (async () => {
    const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
    const server = new McpServer({
      name: 'roku-mcp',
      version: '1.7.0',
    });

    registerDeployTools(server);
    registerEcpTools(server);
    registerScreenshotTools(server);
    registerConsoleTools(server);
    registerBsprofTools(server);
    registerPerfettoTools(server);
    registerEditUiTools(server);
    registerStreamTools(server);

    const transport = new StdioServerTransport();
    await server.connect(transport);
  })();
}
