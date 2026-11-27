# Code mode plan (draft, not approved)

Written for: the implementer and the per-phase reviewer agents. Branch: `feat/code-mode`, from `master @ 80f87a6` (v1.9.0).

## Goal

Cut the context an agent spends on roku-mcp. Today every session loads 46 tool definitions, and multi-step flows (navigate, wait, verify) cost one model round trip per step. Code mode lets the agent write one short script against a typed SDK and run it in a single call.

## Constraints

- **Full mode stays the default and stays identical.** The 46 tools keep the same names, input schemas, output text, `isError` behaviour and annotations. Code mode is opt-in.
- **One implementation.** Tools, CLI and `roku_run` all call the same SDK. No logic is copied between them.
- **Secrets never reach a snippet.** `ROKU_RCE_TOKEN`, device passwords and `.env` contents stay in the parent process.
- **No new native dependencies.** Must install with `npx` on macOS, Linux and Windows.
- **Billing safety is unchanged.** RCE Runs started from a snippet or the CLI are tracked and stopped like the tools' Runs.
- Same publish order and pins as today (see the wiki page `rokumcp-conventions`).

## Phase 1: SDK extraction (deep review)

1. **Parity harness first.** Add `test/parity/`: a fake LAN device (ECP on 8060, installer on 80, console on 8085, RTA on 9000) and a fake RCE (reuse `roku-rce`'s `test/fake-rce.ts` pattern). Record the exact output of all 46 tools on `master` for a fixed set of inputs, including error paths: 404 to `query/app-ui` (`NO_DEV_CHANNEL`), timeouts, unknown `rceDevice`, Limited-mode 403, Windows-style paths in deploy. Commit the recordings as golden files before touching `src/tools`.
2. Add `src/sdk/`, one module per area: `device` (discover, device-info, active app, launch, sleep), `input` (keypress, sequence, type text), `ui` (app-ui, sg-nodes, find-node, focused node, media player), `deploy`, `screenshot`, `console` (read, send, capture start, wait, stop, status), `rta` (edit-UI), `profiler` (bsprof), `perfetto`, `stream` (diagnose), `rce`. Each function takes typed options plus an optional target (`host` or `rceDevice`) and returns data, not MCP text. Errors are a typed `RokuError` with a `code` (e.g. `no_dev_channel`, `timeout`, `ecp_forbidden`, `not_found`).
3. `src/sdk/index.ts` exports a `createRoku(options?)` client that holds the resolved target and the RCE client, so a script can call `roku.input.keypress('Home')`.
4. Rewrite every `src/tools/*` handler as a thin wrapper: parse params, call the SDK, format the same text as before. `friendlyError` moves to the wrapper layer and maps `RokuError.code` to today's messages.
5. Golden tests must pass unchanged. Existing 33 tests must pass.

## Phase 2: CLI

1. New bin `rokuctl` (`dist/cli.js`). `roku-mcp` with no args keeps starting the stdio server, because every client config runs it that way.
2. Commands map 1:1 to SDK functions: `rokuctl input keypress Home`, `rokuctl ui find-node --text "Play"`, `rokuctl deploy ./dist`. Global flags: `--host`, `--rce-device`, `--out <file>`, `--timeout <ms>`.
3. Contract: one JSON object on stdout (`{ok: true, data}` or `{ok: false, error: {code, message}}`). Logs and progress go to stderr. Binary or large output (screenshots, traces, app-ui XML over 64 KiB) is written only with `--out`; without it the command fails with `output_too_large`. Exit codes: 0 ok, 1 device or tool error, 2 usage error, 3 timeout.
4. Tests run the built CLI against the phase 1 fakes and assert stdout JSON, stderr and exit codes.

## Phase 3: Skills (light review)

1. Rewrite `plugin/skills/*` as task-level skills: "reproduce a bug on screen", "run an end-to-end check", "profile a memory leak", "diagnose a stream", "use a Cloud Device". Each has numbered steps that use `rokuctl` or `roku_run`, and an error-recovery table (symptom, cause, fix).
2. Remove references to tool sequences that code mode replaces. Keep the full-mode tool names only where a step still needs them.
3. A test greps skills, `AGENTS.md`, `README.md` and `rules/*` for `roku_*` names and fails on any name the server does not register.

## Phase 4: Slim MCP and `roku_run` sandbox (deep review)

1. `ROKU_MCP_MODE=code` (also a plugin setting) registers only: `roku_run`, `roku_sdk_docs` (search the SDK's typed signatures and examples), and `roku_screenshot` (returns an image, which a script cannot hand back). Full mode is unchanged.
2. `roku_run` takes `code` (an async function body), `timeoutMs` (default 30 000, max 300 000) and an optional target. It returns `{result, logs, files}` as JSON text.
3. **Sandbox design.**
   - The snippet runs in a separate Node child process started with `--permission` and no `--allow-fs-*`, `--allow-child-process`, `--allow-worker` or `--allow-addons` grants, plus `--max-old-space-size=128`. Its environment is empty except `NODE_OPTIONS` unset and `PATH` minimal.
   - The child gets no SDK code. `roku` inside the snippet is a proxy that sends each call over IPC to the parent. The parent validates the method name against an allowlist and the arguments against the SDK schemas, runs the call, and returns plain JSON. Errors cross the boundary as `{code, message}` only, with no stack and with tokens and passwords redacted.
   - File access goes through `roku.fs.read` and `roku.fs.write`, which the parent resolves against the working directory and refuses outside it (`..`, absolute paths, symlinks that leave it) and refuses `.env*`, `*.pem`, `*.key` and `.mcpregistry_*` files.
   - The parent kills the child at `timeoutMs` and on exit code from an out-of-memory abort, and reports `timeout` or `memory_limit`.
   - The permission model needs Node 22.13 or later (stable `--permission`). Add `"engines": {"node": ">=22.13"}` for code mode; on older Node, `roku_run` refuses with a clear message and full mode keeps working.
   - The network is not restricted by the permission model on Node 22. The child holds no secrets, so the risk is limited to the snippet calling hosts directly. Document it.
4. Adversarial tests: read `process.env`, `process.binding`, `require('fs')`, `process.getBuiltinModule('child_process')`, constructor-chain escapes, read `.env` through `roku.fs`, `../` and symlink escapes, infinite loop, allocation bomb, huge log output, error message containing the token, RCE start without stop (the parent's Run tracking must still stop it).

## Phase 5: Bench script

1. `scripts/bench.mjs`: starts the server in each mode over stdio against the phase 1 fakes.
2. Reports: `tools/list` size in bytes and estimated tokens, and for three scripted flows (deploy then verify a label, navigate five keys and find a node, start a console capture and wait for a line) the number of MCP calls, total request plus response bytes, and wall time.
3. Writes `bench/results.json` and prints a table. No model calls, no billed RCE.

## Phase 6: Docs and release (light review)

1. README: a Code mode section (when to use it, `ROKU_MCP_MODE`, `rokuctl`, sandbox limits). AGENTS.md and `rules/*`: the code-mode loop. CHANGELOG.
2. Bump to 1.10.0 (minor, because full mode is unchanged). Follow the release order in `rokumcp-conventions`, then create the GitHub release.

## Review loop

After each phase, a reviewer subagent with no chat history gets this plan, the phase diff (`git diff <previous phase commit>..HEAD`) and permission to run `npm test` and the bench. It returns findings ranked blocker, important, nit, each with file, line and a failure scenario, and does not edit code. Blockers and important findings are fixed or answered in writing, and the reviewer re-runs on the fix diff. A phase is done when no blockers remain. Phases 1 and 4 get a deep review; phases 3 and 6 one light pass. Phases 2 and 5 get a normal pass.

## Open decisions

1. CLI bin name: `rokuctl` (recommended) or a `roku-mcp cli` subcommand.
2. Which tools stay in code mode besides `roku_run`: recommended `roku_sdk_docs` and `roku_screenshot` only.
3. Node floor: recommended `>=22.13` for code mode only, with a refusal on older Node.
