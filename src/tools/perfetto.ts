import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { READ_ONLY, WRITES, targetParams } from '../roku-config.js';
import * as sdk from '../sdk/index.js';
import { fail, jsonify, ok } from './result.js';

export function registerPerfettoTools(server: McpServer): void {
  // ---------------------------------------------------------------------------
  // roku_perfetto_enable
  // ---------------------------------------------------------------------------
  server.registerTool(
    'roku_perfetto_enable',
    {
      title: 'Enable Perfetto tracing',
      annotations: WRITES,
      description:
        'Enable Perfetto tracing for a Roku channel via ECP. Tracing starts automatically on each app launch, so relaunch the channel afterwards and then call roku_perfetto_start. Requires Roku OS 15.1+ on a LAN device (not supported on Roku Cloud Emulator). There is no disable command — enabled channels are cleared on reboot.',
      inputSchema: {
        ...targetParams,
        channelId: z
          .string()
          .optional()
          .default('dev')
          .describe('Channel ID to enable tracing for (default: "dev" for sideloaded apps)'),
      },
    },
    async (params) => {
      try {
        return ok(jsonify(await sdk.perfettoEnable(params)));
      } catch (error) {
        return fail('Enable failed', error);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // roku_perfetto_start
  // ---------------------------------------------------------------------------
  server.registerTool(
    'roku_perfetto_start',
    {
      title: 'Start Perfetto recording',
      annotations: WRITES,
      description:
        'Start recording a Perfetto trace from the Roku device. The order is strict: roku_perfetto_enable, then relaunch the channel, then roku_perfetto_start. Opens a binary WebSocket to stream trace data to a local file. Only one recording session at a time. LAN devices only (not supported on Roku Cloud Emulator).',
      inputSchema: {
        ...targetParams,
        channelId: z.string().optional().default('dev').describe('Channel ID (default: "dev")'),
        outDir: z.string().optional().describe('Directory to save the trace file (default: OS temp directory)'),
        outFile: z.string().optional().describe('Filename without extension (default: timestamped name)'),
      },
    },
    async (params) => {
      try {
        const session = await sdk.perfettoStart(params);
        return ok(`Recording Perfetto trace on ${session.host} → ${session.filePath}\nUse roku_perfetto_stop to end recording.`);
      } catch (error) {
        return fail('Start failed', error);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // roku_perfetto_stop
  // ---------------------------------------------------------------------------
  server.registerTool(
    'roku_perfetto_stop',
    {
      title: 'Stop Perfetto recording',
      annotations: WRITES,
      description:
        'Stop the active Perfetto trace recording. Returns the file path, size, and duration. The resulting .trace file can be opened at https://ui.perfetto.dev/ or analyzed with analyze_perfetto.',
    },
    async () => {
      try {
        const result = await sdk.perfettoStop();
        return ok(
          `Perfetto trace saved: ${result.filePath}\nDuration: ${(result.durationMs / 1000).toFixed(1)}s | Size: ${(result.bytesWritten / 1024).toFixed(1)}KB\nOpen at: https://ui.perfetto.dev/\nOr analyze with: analyze_perfetto`
        );
      } catch (error) {
        return fail('Stop failed', error);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // analyze_perfetto
  // ---------------------------------------------------------------------------
  server.registerTool(
    'analyze_perfetto',
    {
      title: 'Analyze Perfetto trace',
      annotations: READ_ONLY,
      description:
        'Analyze a Roku Perfetto trace file (.trace). Returns structured JSON with AI-friendly suggestion fields for each analysis area. Requires the trace_processor binary (auto-downloaded on first use). Modes: summary (full report), frame-drops, key-events, observers, rendezvous, set-fields, threads.',
      inputSchema: {
        filePath: z.string().describe('Absolute path to the .trace file'),
        mode: z
          .enum(['summary', 'frame-drops', 'key-events', 'observers', 'rendezvous', 'set-fields', 'threads'])
          .describe('Analysis mode'),
        top: z.number().optional().describe('Number of entries in ranked lists (default 20)'),
        threshold: z
          .number()
          .optional()
          .describe('Only show entries exceeding this value in milliseconds'),
      },
    },
    async (params) => {
      try {
        return ok(jsonify(await sdk.analyzeTrace(params)));
      } catch (error) {
        return fail('Analysis failed', error);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // compare_perfetto
  // ---------------------------------------------------------------------------
  server.registerTool(
    'compare_perfetto',
    {
      title: 'Compare Perfetto traces',
      annotations: READ_ONLY,
      description:
        'Compare two Roku Perfetto trace files to detect performance regressions and improvements. Returns metric deltas for frame drops, key events, observers, rendezvous, and setField calls.',
      inputSchema: {
        beforePath: z.string().describe('Absolute path to the "before" .trace file'),
        afterPath: z.string().describe('Absolute path to the "after" .trace file'),
        top: z.number().optional().describe('Number of entries in ranked lists (default 20)'),
      },
    },
    async (params) => {
      try {
        return ok(jsonify(await sdk.compareTraces(params)));
      } catch (error) {
        return fail('Comparison failed', error);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // query_perfetto
  // ---------------------------------------------------------------------------
  server.registerTool(
    'query_perfetto',
    {
      title: 'Query Perfetto trace',
      annotations: READ_ONLY,
      description:
        'Run a raw PerfettoSQL query against a Roku Perfetto trace file. Use for custom analysis beyond the built-in modes. Common queries: SELECT * FROM slice WHERE name = \'swapBuffers\' ORDER BY dur DESC; SELECT * FROM slice WHERE name = \'keyEvent\' ORDER BY dur DESC;',
      inputSchema: {
        filePath: z.string().describe('Absolute path to the .trace file'),
        sql: z.string().describe('PerfettoSQL query to execute'),
      },
    },
    async (params) => {
      try {
        return ok(jsonify(await sdk.queryTrace(params)));
      } catch (error) {
        return fail('Query failed', error);
      }
    },
  );
}
