#!/usr/bin/env node

import 'dotenv/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerDeployTools } from './tools/deploy.js';
import { registerEcpTools } from './tools/ecp.js';
import { registerScreenshotTools } from './tools/screenshot.js';
import { registerConsoleTools } from './tools/console.js';

const server = new McpServer({
  name: 'roku-mcp',
  version: '1.3.0',
});

registerDeployTools(server);
registerEcpTools(server);
registerScreenshotTools(server);
registerConsoleTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);
