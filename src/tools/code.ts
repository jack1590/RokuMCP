import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { COMMANDS, commandShape, commandSummary } from '../commands.js';
import { DESTRUCTIVE, READ_ONLY, targetParams } from '../roku-config.js';
import { RCE_BILLING } from '../rce.js';
import { RUN_LIMITS, runSnippet } from '../sandbox/run.js';
import { ok, type ToolResult } from './result.js';

const camel = (s: string) => s.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
const callName = (name: string) => {
  const [group, method] = name.split('.');
  return `roku.${group}.${camel(method)}`;
};

const API =
  'The snippet is the body of an async function with `roku` and `console` in scope; `return` a JSON value. ' +
  'Every call takes one options object and returns a promise: `await roku.input.keypress({ key: "Home" })`, ' +
  '`await roku.ui.find({ attr: "text", value: "Play" })`, `await roku.device.sleep({ durationMs: 1000 })`. ' +
  'Device calls default to the host or rceDevice given to roku_run, then the usual environment and discovery. ' +
  'Files: `roku.fs.read(path)` and `roku.fs.list(path)` read inside the server\'s working directory; `roku.fs.write(path, text)` creates data files (.json, .txt, .log, .csv, .md, ...) only inside its roku-run/ folder (captures and screenshots given a folder go there too). Secret files such as .env, mcp.json and bsconfig.json are refused. ' +
  'A failed call throws an Error with `code` and `message`; catch it to recover. Console session, capture and Perfetto recording state persists between roku_run calls. ' +
  `Limits: ${RUN_LIMITS.defaultTimeoutMs / 1000} s by default (at most ${RUN_LIMITS.maxTimeoutMs / 1000} s), ${RUN_LIMITS.memoryMb} MB, ` +
  `${RUN_LIMITS.maxResultChars / 1024} KiB return value, ${RUN_LIMITS.maxCalls} calls. The snippet has no file system, network secrets, environment or child processes of its own.`;

function docsFor(query?: string) {
  const q = query?.toLowerCase().trim();
  const matches = COMMANDS.filter((c) => !q || c.name.includes(q) || callName(c.name).toLowerCase().includes(q) || commandSummary(c).toLowerCase().includes(q));
  if (!q) {
    return {
      api: API,
      calls: COMMANDS.map((c) => ({ call: callName(c.name), summary: commandSummary(c).split('. ')[0].slice(0, 160) })),
      fs: ['roku.fs.read(path) -> string', 'roku.fs.write(path, text) -> { path, bytes } (relative paths land in roku-run/; writes go only there)', 'roku.fs.list(path?) -> [{ name, type }]'],
      next: 'Call roku_sdk_docs with a query (e.g. "keypress", "console", "rta") for full option schemas.',
    };
  }
  return {
    api: API,
    calls: matches.map((c) => ({
      call: callName(c.name),
      description: commandSummary(c),
      options: z.toJSONSchema(z.object(commandShape(c)), { io: 'input' }),
    })),
  };
}

export function registerCodeTools(server: McpServer): void {
  server.registerTool(
    'roku_run',
    {
      title: 'Run a Roku script',
      annotations: DESTRUCTIVE, // a script can deploy, delete the dev channel or start a billed Cloud Device Run
      description:
        'Run a short JavaScript snippet that drives Roku devices through the roku-mcp SDK, so a multi-step flow (navigate, wait, verify) takes one call instead of one tool call per step. ' +
        API +
        ' Use roku_sdk_docs to look up calls and their options. ' +
        RCE_BILLING,
      inputSchema: {
        code: z.string().describe('Body of an async function, e.g. `await roku.input.keypress({ key: "Home" }); return await roku.ui.focused();`'),
        timeoutMs: z.number().int().positive().max(RUN_LIMITS.maxTimeoutMs).optional().describe(`Stop the snippet after this many ms (default ${RUN_LIMITS.defaultTimeoutMs})`),
        ...targetParams,
      },
    },
    async (params): Promise<ToolResult> => {
      const result = await runSnippet(params);
      return { ...ok(JSON.stringify(result, null, 2)), ...(result.ok ? {} : { isError: true }) };
    }
  );

  server.registerTool(
    'roku_sdk_docs',
    {
      title: 'Roku SDK reference',
      annotations: READ_ONLY,
      description:
        'List the calls a roku_run snippet can make. Without a query: every call with a one-line summary and the snippet API. With a query: the matching calls with their full option schemas.',
      inputSchema: {
        query: z.string().optional().describe('Filter by call name or words in the description, e.g. "keypress", "console", "deploy"'),
      },
    },
    async (params): Promise<ToolResult> => ok(JSON.stringify(docsFor(params.query), null, 2))
  );
}
