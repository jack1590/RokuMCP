import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readFileSync } from 'fs';
import {
  parseBsprof,
  analyzeMemory,
  analyzeCpu,
  compareBsprof,
  buildHeaderInfo,
  buildParseStats,
  aggregate,
  rankFunctions,
} from 'bsprof-cli';
import type { AnalysisOptions, FullReport, SummaryReport } from 'bsprof-cli';
import { friendlyError } from '../roku-config.js';

function jsonify(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? Number(v) : v), 2);
}

function buildOptions(params: {
  top?: number;
  sortBy?: string;
  filterModule?: string;
  excludeModule?: string;
  filterFile?: string;
  threshold?: number;
}): AnalysisOptions {
  return {
    top: params.top ?? 30,
    sortBy: params.sortBy,
    filterModule: params.filterModule,
    excludeModule: params.excludeModule,
    filterFile: params.filterFile,
    threshold: params.threshold ?? 0,
  };
}

export function registerBsprofTools(server: McpServer): void {
  server.registerTool(
    'analyze_bsprof',
    {
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
        const buffer = readFileSync(params.filePath);
        const profile = parseBsprof(buffer);
        const options = buildOptions(params);

        let report: unknown;

        switch (params.mode) {
          case 'memory':
            report = analyzeMemory(profile, options);
            break;
          case 'cpu':
            report = analyzeCpu(profile, options);
            break;
          case 'full': {
            const memory = analyzeMemory(profile, options);
            const cpu = analyzeCpu(profile, options);
            const fullReport: FullReport = { header: memory.header, memory, cpu };
            report = fullReport;
            break;
          }
          case 'summary': {
            const header = buildHeaderInfo(profile);
            const parseStats = buildParseStats(profile);
            const agg = aggregate(profile, options);
            const allFuncs = [...agg.byFunction.values()];
            const summaryReport: SummaryReport = {
              header,
              parseStats,
              topMemoryLeaks: rankFunctions(allFuncs, 'retained', options.top),
              topCpuConsumers: rankFunctions(allFuncs, 'cpuSelf', options.top),
              moduleOverview: [...agg.byModule.values()],
            };
            report = summaryReport;
            break;
          }
        }

        return {
          content: [{ type: 'text', text: jsonify(report) }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Analysis failed: ${friendlyError(error)}` }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    'compare_bsprof',
    {
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
        const beforeBuf = readFileSync(params.beforePath);
        const afterBuf = readFileSync(params.afterPath);
        const before = parseBsprof(beforeBuf);
        const after = parseBsprof(afterBuf);
        const options = buildOptions(params);

        const diff = compareBsprof(before, after, params.beforePath, params.afterPath, options);

        return {
          content: [{ type: 'text', text: jsonify(diff) }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Comparison failed: ${friendlyError(error)}` }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    'bsprof_info',
    {
      description:
        'Get header metadata from a .bsprof file without full analysis — target name, device model, firmware, format version, duration, file size, and enabled features.',
      inputSchema: {
        filePath: z.string().describe('Absolute path to the .bsprof file'),
      },
    },
    async (params) => {
      try {
        const buffer = readFileSync(params.filePath);
        const profile = parseBsprof(buffer);
        const info = buildHeaderInfo(profile);

        return {
          content: [{ type: 'text', text: jsonify(info) }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Info failed: ${friendlyError(error)}` }],
          isError: true,
        };
      }
    },
  );
}
