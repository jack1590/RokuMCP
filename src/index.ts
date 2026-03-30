#!/usr/bin/env node

import 'dotenv/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerDeployTools } from './tools/deploy.js';
import { registerEcpTools } from './tools/ecp.js';
import { registerScreenshotTools } from './tools/screenshot.js';
import { registerConsoleTools } from './tools/console.js';

export default function createServer(_options?: { config?: Record<string, string> }) {
  const server = new McpServer({
    name: 'roku-mcp',
    version: '1.3.2',
  });

  registerDeployTools(server);
  registerEcpTools(server);
  registerScreenshotTools(server);
  registerConsoleTools(server);

  return server.server;
}

const isDirectRun =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  (process.argv[1].endsWith('/index.js') || process.argv[1].endsWith('/roku-mcp'));

if (isDirectRun) {
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const server = new McpServer({
    name: 'roku-mcp',
    version: '1.3.2',
  });

  registerDeployTools(server);
  registerEcpTools(server);
  registerScreenshotTools(server);
  registerConsoleTools(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
