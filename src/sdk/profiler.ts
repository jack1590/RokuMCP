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

export interface ProfileFilters {
  top?: number;
  filterModule?: string;
  excludeModule?: string;
  threshold?: number;
}

export interface AnalyzeProfileOptions extends ProfileFilters {
  /** Path to the .bsprof file. */
  filePath: string;
  mode: 'memory' | 'cpu' | 'full' | 'summary';
  sortBy?: string;
  filterFile?: string;
}

/** Memory, CPU, both, or a one-page summary of a .bsprof; `note` warns when a large file is parsed. */
export function analyzeProfile(options: AnalyzeProfileOptions): { report: unknown; note?: string } {
  const note = largeFileNote(options.filePath);
  const profile = getProfile(options.filePath);
  const opts = buildOptions(options);

  let report: unknown;
  switch (options.mode) {
    case 'memory':
      report = analyzeMemory(profile, opts);
      break;
    case 'cpu':
      report = analyzeCpu(profile, opts);
      break;
    case 'full': {
      const memory = analyzeMemory(profile, opts);
      const cpu = analyzeCpu(profile, opts);
      const fullReport: FullReport = { header: memory.header, memory, cpu };
      report = fullReport;
      break;
    }
    case 'summary': {
      const header = buildHeaderInfo(profile);
      const parseStats = buildParseStats(profile);
      const agg = aggregate(profile, opts);
      const allFuncs = [...agg.byFunction.values()];
      const summaryReport: SummaryReport = {
        header,
        parseStats,
        topMemoryLeaks: rankFunctions(allFuncs, 'retained', opts.top),
        topCpuConsumers: rankFunctions(allFuncs, 'cpuSelf', opts.top),
        moduleOverview: [...agg.byModule.values()],
      };
      report = summaryReport;
      break;
    }
  }
  return { report, note };
}

/** Regressions, improvements and new or resolved leaks between two .bsprof files. */
export function compareProfiles(options: ProfileFilters & { beforePath: string; afterPath: string }): { diff: unknown; note?: string } {
  const note = largeFileNote(options.beforePath) ?? largeFileNote(options.afterPath);
  // ponytail: single-entry cache means comparing two distinct files re-parses
  // each on every call. Parse the larger file second so it's the one left cached.
  const before = getProfile(options.beforePath);
  const after = getProfile(options.afterPath);
  const diff = compareBsprof(before, after, options.beforePath, options.afterPath, buildOptions(options));
  return { diff, note };
}
