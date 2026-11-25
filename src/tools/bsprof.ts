import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readFileSync, statSync } from 'fs';
import {
  parseBsprof,
  analyzeMemory,
  analyzeCpu,
  compareBsprof,
  buildHeaderInfo,
  buildParseStats,
  aggregate,
  rankFunctions,
  BsprofParser,
} from 'bsprof-cli';
import type { AnalysisOptions, FullReport, SummaryReport, ParsedProfile, HeaderInfo } from 'bsprof-cli';
import { READ_ONLY, friendlyError } from '../roku-config.js';

function jsonify(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? Number(v) : v), 2);
}

/**
 * Parsing a .bsprof is O(entries): a 645 MB file (~73M entries) takes minutes and
 * the parsed profile is ~180 MB resident. To avoid re-parsing the same file across
 * back-to-back tool calls (e.g. info → summary → full, or memory then cpu), cache the
 * most recent parse keyed by path + size + mtime.
 *
 * ponytail: single-entry cache (the parsed profile is large, so we keep only one).
 * Upgrade path: bump to a small size-bounded LRU if multi-file workflows get common.
 */
const LARGE_FILE_BYTES = 200 * 1024 * 1024;
let parseCache: { key: string; profile: ParsedProfile } | undefined;

function cacheKey(filePath: string): string {
  const st = statSync(filePath);
  return `${filePath}:${st.size}:${st.mtimeMs}`;
}

export function getProfile(filePath: string): ParsedProfile {
  const key = cacheKey(filePath);
  if (parseCache && parseCache.key === key) {
    return parseCache.profile;
  }
  const profile = parseBsprof(readFileSync(filePath));
  parseCache = { key, profile };
  return profile;
}

/** Cheaply read header metadata without parsing the 73M-entry body (duration omitted). */
export function readHeaderInfo(filePath: string): HeaderInfo {
  const st = statSync(filePath);
  const key = `${filePath}:${st.size}:${st.mtimeMs}`;
  if (parseCache && parseCache.key === key) {
    return buildHeaderInfo(parseCache.profile);
  }

  const buffer = readFileSync(filePath);
  const { header, fileSize } = new BsprofParser(buffer).parseHeaderOnly();

  // The footer timestamp can only be located reliably by reaching it through the
  // body (a back-scan from EOF lands mid-record and decodes garbage). So duration
  // is left at 0 here; it requires a full analyze_bsprof pass to compute.
  const profile = {
    header,
    timestampEnd: undefined,
    fileSize,
    strings: new Map(),
    modules: new Map(),
    pathElements: new Map(),
    parseResult: { count: 0, errors: 0, memoryByPE: new Map(), cpuByPE: new Map() },
  } as ParsedProfile;
  return buildHeaderInfo(profile);
}

function largeFileNote(filePath: string): string | undefined {
  try {
    const { size } = statSync(filePath);
    if (size >= LARGE_FILE_BYTES) {
      const mb = (size / 1048576).toFixed(0);
      const cached = parseCache && parseCache.key === cacheKey(filePath);
      return cached
        ? undefined
        : `Large profile (${mb} MB): the first analysis parses tens of millions of entries and can take several minutes. The parse is cached, so follow-up analyses of the same file return quickly.`;
    }
  } catch {
    // statSync failure surfaces later as a friendlier read error.
  }
  return undefined;
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
        const note = largeFileNote(params.filePath);
        const profile = getProfile(params.filePath);
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

        const content = [{ type: 'text' as const, text: jsonify(report) }];
        if (note) content.unshift({ type: 'text' as const, text: note });
        return { content };
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
        const note = largeFileNote(params.beforePath) ?? largeFileNote(params.afterPath);
        // ponytail: single-entry cache means comparing two distinct files re-parses
        // each on every call. Parse the larger file second so it's the one left cached.
        const before = getProfile(params.beforePath);
        const after = getProfile(params.afterPath);
        const options = buildOptions(params);

        const diff = compareBsprof(before, after, params.beforePath, params.afterPath, options);

        const content = [{ type: 'text' as const, text: jsonify(diff) }];
        if (note) content.unshift({ type: 'text' as const, text: note });
        return { content };
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
        const info = readHeaderInfo(params.filePath);

        return {
          content: [
            { type: 'text', text: jsonify(info) },
            {
              type: 'text',
              text: 'Note: duration is reported as 0 here — bsprof_info reads only the header for speed. Run analyze_bsprof for the full profile (and the duration, when the file has a footer timestamp).',
            },
          ],
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
