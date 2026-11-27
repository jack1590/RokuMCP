import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { READ_ONLY } from '../roku-config.js';
import * as sdk from '../sdk/index.js';
import { fail, jsonify } from './result.js';

export function registerBsprofTools(server: McpServer): void {
  server.registerTool(
    'analyze_bsprof',
    {
      title: 'Analyze .bsprof profile',
      annotations: READ_ONLY,
      description:
        'Analyze a BrightScript Profiler (.bsprof) file from a Roku device. Supports memory leak detection, CPU hot-path analysis, combined full reports, and one-page summaries. Returns structured JSON.',
      inputSchema: {
        filePath: z.string().describe('Absolute path to the .bsprof file'),
        mode: z
          .enum(['memory', 'cpu', 'full', 'summary'])
          .describe('Analysis mode: memory (retained bytes, leaks), cpu (self time, hot functions), full (both), summary (key metrics overview)'),
        top: z.number().optional().describe('Number of entries in ranked lists (default 30)'),
        sortBy: z
          .string()
          .optional()
          .describe('Sort field: retained, allocated, allocCount, cpuSelf, wallSelf, callCount'),
        filterModule: z.string().optional().describe('Filter results to a specific module/thread'),
        excludeModule: z.string().optional().describe('Exclude a module (e.g. roku_ads_lib)'),
        filterFile: z.string().optional().describe('Glob pattern for file filtering'),
        threshold: z
          .number()
          .optional()
          .describe('Only show entries exceeding this value (bytes for memory, microseconds for CPU)'),
      },
    },
    async (params) => {
      try {
        const { report, note } = sdk.analyzeProfile(params);
        const content = [{ type: 'text' as const, text: jsonify(report) }];
        if (note) content.unshift({ type: 'text' as const, text: note });
        return { content };
      } catch (error) {
        return fail('Analysis failed', error);
      }
    },
  );

  server.registerTool(
    'compare_bsprof',
    {
      title: 'Compare .bsprof profiles',
      annotations: READ_ONLY,
      description:
        'Compare two BrightScript Profiler (.bsprof) files to detect regressions, improvements, new memory leaks, resolved leaks, and CPU time deltas between runs.',
      inputSchema: {
        beforePath: z.string().describe('Absolute path to the "before" .bsprof file'),
        afterPath: z.string().describe('Absolute path to the "after" .bsprof file'),
        top: z.number().optional().describe('Number of entries in ranked lists (default 30)'),
        filterModule: z.string().optional().describe('Filter results to a specific module/thread'),
        excludeModule: z.string().optional().describe('Exclude a module (e.g. roku_ads_lib)'),
        threshold: z
          .number()
          .optional()
          .describe('Only show deltas exceeding this value (bytes or microseconds)'),
      },
    },
    async (params) => {
      try {
        const { diff, note } = sdk.compareProfiles(params);
        const content = [{ type: 'text' as const, text: jsonify(diff) }];
        if (note) content.unshift({ type: 'text' as const, text: note });
        return { content };
      } catch (error) {
        return fail('Comparison failed', error);
      }
    },
  );

  server.registerTool(
    'bsprof_info',
    {
      title: 'Read .bsprof header',
      annotations: READ_ONLY,
      description:
        'Get header metadata from a .bsprof file without full analysis — target name, device model, firmware, format version, duration, file size, and enabled features. Reads only the header/footer, so it is instant even on multi-hundred-MB profiles.',
      inputSchema: {
        filePath: z.string().describe('Absolute path to the .bsprof file'),
      },
    },
    async (params) => {
      try {
        return {
          content: [
            { type: 'text', text: jsonify(sdk.readHeaderInfo(params.filePath)) },
            {
              type: 'text',
              text: 'Note: duration is reported as 0 here — bsprof_info reads only the header for speed. Run analyze_bsprof for the full profile (and the duration, when the file has a footer timestamp).',
            },
          ],
        };
      } catch (error) {
        return fail('Info failed', error);
      }
    },
  );
}
