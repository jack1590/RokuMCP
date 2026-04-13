import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import os from 'os';
import path from 'path';
import { PerfettoClient, RokuAnalyzer, comparePerfetto, openTrace } from 'roku-perfetto';
import type { AnalysisMode } from 'roku-perfetto';
import { resolveHost, friendlyError } from '../roku-config.js';

function jsonify(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? Number(v) : v), 2);
}

let client: PerfettoClient | null = null;
let clientHost: string | null = null;

export function registerPerfettoTools(server: McpServer): void {
  // ---------------------------------------------------------------------------
  // roku_perfetto_enable
  // ---------------------------------------------------------------------------
  server.registerTool(
    'roku_perfetto_enable',
    {
      description:
        'Enable Perfetto tracing for a Roku channel via ECP. Tracing starts automatically on each app launch. Requires Roku OS 15.1+. There is no disable command — enabled channels are cleared on reboot.',
      inputSchema: {
        host: z.string().optional().describe('IP address or hostname of the Roku device'),
        channelId: z
          .string()
          .optional()
          .default('dev')
          .describe('Channel ID to enable tracing for (default: "dev" for sideloaded apps)'),
      },
    },
    async (params) => {
      try {
        const host = await resolveHost(params);
        client = new PerfettoClient(host);
        clientHost = host;
        const result = await client.enable(params.channelId ?? 'dev');
        return {
          content: [{ type: 'text', text: jsonify(result) }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Enable failed: ${friendlyError(error)}` }],
          isError: true,
        };
      }
    },
  );

  // ---------------------------------------------------------------------------
  // roku_perfetto_start
  // ---------------------------------------------------------------------------
  server.registerTool(
    'roku_perfetto_start',
    {
      description:
        'Start recording a Perfetto trace from the Roku device. Opens a binary WebSocket to stream trace data to a local file. Only one recording session at a time. Call roku_perfetto_enable first.',
      inputSchema: {
        host: z.string().optional().describe('IP address or hostname of the Roku device'),
        channelId: z.string().optional().default('dev').describe('Channel ID (default: "dev")'),
        outDir: z.string().optional().describe('Directory to save the trace file (default: OS temp directory)'),
        outFile: z.string().optional().describe('Filename without extension (default: timestamped name)'),
      },
    },
    async (params) => {
      try {
        const host = await resolveHost(params);
        if (!client || clientHost !== host) {
          client = new PerfettoClient(host);
          clientHost = host;
        }

        const dir = params.outDir ?? os.tmpdir();
        const name = params.outFile ?? `roku-perfetto-${Date.now()}`;
        const filePath = path.join(dir, `${name}.trace`);

        const session = await client.startRecording(filePath, params.channelId ?? 'dev');
        return {
          content: [{
            type: 'text',
            text: `Recording Perfetto trace on ${session.host} → ${session.filePath}\nUse roku_perfetto_stop to end recording.`,
          }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Start failed: ${friendlyError(error)}` }],
          isError: true,
        };
      }
    },
  );

  // ---------------------------------------------------------------------------
  // roku_perfetto_stop
  // ---------------------------------------------------------------------------
  server.registerTool(
    'roku_perfetto_stop',
    {
      description:
        'Stop the active Perfetto trace recording. Returns the file path, size, and duration. The resulting .trace file can be opened at https://ui.perfetto.dev/ or analyzed with analyze_perfetto.',
    },
    async () => {
      try {
        if (!client || !client.isRecording()) {
          return {
            content: [{ type: 'text', text: 'No active Perfetto recording. Use roku_perfetto_start first.' }],
            isError: true,
          };
        }

        const result = await client.stopRecording();
        return {
          content: [{
            type: 'text',
            text: `Perfetto trace saved: ${result.filePath}\nDuration: ${(result.durationMs / 1000).toFixed(1)}s | Size: ${(result.bytesWritten / 1024).toFixed(1)}KB\nOpen at: https://ui.perfetto.dev/\nOr analyze with: analyze_perfetto`,
          }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Stop failed: ${friendlyError(error)}` }],
          isError: true,
        };
      }
    },
  );

  // ---------------------------------------------------------------------------
  // analyze_perfetto
  // ---------------------------------------------------------------------------
  server.registerTool(
    'analyze_perfetto',
    {
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
        const opts = { top: params.top ?? 20, threshold: params.threshold };
        const analyzer = await openTrace(params.filePath);

        let report: unknown;
        try {
          switch (params.mode as AnalysisMode) {
            case 'summary':
              report = await analyzer.performanceSummary(opts);
              break;
            case 'frame-drops':
              report = await analyzer.analyzeFrameDrops(opts);
              break;
            case 'key-events':
              report = await analyzer.analyzeKeyEvents(opts);
              break;
            case 'observers':
              report = await analyzer.analyzeObservers(opts);
              break;
            case 'rendezvous':
              report = await analyzer.analyzeRendezvous(opts);
              break;
            case 'set-fields':
              report = await analyzer.analyzeSetFields(opts);
              break;
            case 'threads':
              report = await analyzer.analyzeThreads(opts);
              break;
          }
        } finally {
          await analyzer.close();
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

  // ---------------------------------------------------------------------------
  // compare_perfetto
  // ---------------------------------------------------------------------------
  server.registerTool(
    'compare_perfetto',
    {
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
        const report = await comparePerfetto(params.beforePath, params.afterPath, {
          top: params.top ?? 20,
        });
        return {
          content: [{ type: 'text', text: jsonify(report) }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Comparison failed: ${friendlyError(error)}` }],
          isError: true,
        };
      }
    },
  );

  // ---------------------------------------------------------------------------
  // query_perfetto
  // ---------------------------------------------------------------------------
  server.registerTool(
    'query_perfetto',
    {
      description:
        'Run a raw PerfettoSQL query against a Roku Perfetto trace file. Use for custom analysis beyond the built-in modes. Common queries: SELECT * FROM slice WHERE name = \'swapBuffers\' ORDER BY dur DESC; SELECT * FROM slice WHERE name = \'keyEvent\' ORDER BY dur DESC;',
      inputSchema: {
        filePath: z.string().describe('Absolute path to the .trace file'),
        sql: z.string().describe('PerfettoSQL query to execute'),
      },
    },
    async (params) => {
      try {
        const analyzer = await openTrace(params.filePath);
        try {
          const result = await analyzer.query(params.sql);
          return {
            content: [{ type: 'text', text: jsonify(result) }],
          };
        } finally {
          await analyzer.close();
        }
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Query failed: ${friendlyError(error)}` }],
          isError: true,
        };
      }
    },
  );
}
