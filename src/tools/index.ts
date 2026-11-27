import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ZodRawShape } from 'zod';
import { registerDeployTools } from './deploy.js';
import { registerEcpTools } from './ecp.js';
import { registerScreenshotTools } from './screenshot.js';
import { registerConsoleTools } from './console.js';
import { registerConsoleCaptureTools } from './console-capture.js';
import { registerBsprofTools } from './bsprof.js';
import { registerPerfettoTools } from './perfetto.js';
import { registerEditUiTools } from './edit-ui.js';
import { registerStreamTools } from './stream.js';
import { registerRceTools } from './rce.js';

/** Every tool group, in registration order (the order tools/list reports). */
export const TOOL_GROUPS: Array<(server: McpServer) => void> = [
  registerDeployTools,
  registerEcpTools,
  registerScreenshotTools,
  registerConsoleTools,
  registerConsoleCaptureTools,
  registerBsprofTools,
  registerPerfettoTools,
  registerEditUiTools,
  registerStreamTools,
  registerRceTools,
];

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: ZodRawShape;
}

let specs: Map<string, ToolSpec> | undefined;

/** Each tool's name, description and zod input shape, read from the same registrations the server uses. */
export function toolSpecs(): Map<string, ToolSpec> {
  if (!specs) {
    const found = new Map<string, ToolSpec>();
    const recorder = {
      registerTool(name: string, config: { description?: string; inputSchema?: ZodRawShape }) {
        found.set(name, { name, description: config.description ?? '', inputSchema: config.inputSchema ?? {} });
      },
    } as unknown as McpServer;
    for (const register of TOOL_GROUPS) register(recorder);
    specs = found;
  }
  return specs;
}
