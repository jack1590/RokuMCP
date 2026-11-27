# roku-mcp

A [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) server for Roku device automation. Exposes tools for app deployment, ECP remote control, screenshot capture, SceneGraph node inspection, BrightScript debug console access, profiling, and stream diagnosis. It drives Roku devices on your local network and, since 1.9.0, [Roku Cloud Emulator (RCE)](#roku-cloud-emulator-rce) Cloud Devices.

## Install

The server ships as a single `npx` command. Install once globally if you prefer, or let your MCP client launch it on demand via `npx -y roku-mcp` — both work.

```bash
npm install -g roku-mcp     # optional, global install
# or just point your client at: npx -y roku-mcp
```

### Plugin mode (Claude Code and Cursor)

> Unofficial community tool. Not affiliated with or endorsed by Roku, Inc.

The repo also ships as a plugin: the MCP server, workflow skills, and Cursor rules, registered together.

- **Claude Code:** `/plugin marketplace add jack1590/RokuMCP` then `/plugin install roku-mcp@roku-mcp-marketplace`. The plugin lives in the `plugin/` folder: `plugin/.claude-plugin/plugin.json`, `plugin/.mcp.json` and `plugin/skills/`.
- **Cursor:** manifests in `.cursor-plugin/` and `mcp.json`. Skills in `plugin/skills/`, rules in `rules/cursor/`.

Claude Code asks for the device host and developer password when the plugin is enabled (the password is stored as sensitive). It also offers optional Roku Cloud Emulator settings: `ROKU_RCE_TOKEN` and `ROKU_RCE_PASSWORD` (both stored as sensitive) and `ROKU_RCE_DEVICE`.

Both clients start the server with `npx -y roku-mcp@<version>`, pinned to the exact release that matches the plugin. The plugin folder contains no `package.json` and installs nothing itself: `npx` downloads that one published version from the npm registry on first start (Node 18+ and network access to registry.npmjs.org are required). On native Windows, if the client cannot start `npx` directly, use the manual configuration below with `"command": "cmd"` and `"args": ["/c", "npx", "-y", "roku-mcp"]`. Outside plugin mode, `ROKU_DEVICE_HOST` / `ROKU_DEVICE_PASSWORD` or a project `.env` still work.

Configure your AI client below. Every platform uses the same launch line; only the config file and reload step change.

<details>
<summary><strong>Cursor</strong> — agent-mode tools, auto-discovers MCP servers</summary>

**Prerequisites:** Cursor 0.45+ with Agent mode.

**Install:** create `.cursor/mcp.json` in your project root (or `~/.cursor/mcp.json` for global):

```json
{
  "mcpServers": {
    "roku": {
      "command": "npx",
      "args": ["-y", "roku-mcp"],
      "env": {
        "ROKU_DEVICE_HOST": "192.168.1.XXX",
        "ROKU_DEVICE_PASSWORD": "your-password"
      }
    }
  }
}
```

Then reload the window (`Cmd+Shift+P` / `Ctrl+Shift+P` → **Developer: Reload Window**).

**Verify:** open **Cursor Settings → MCP** and confirm the `roku` row shows a green dot. If it appears disabled, click the toggle. In a new agent chat, type `list roku tools` — you should see `roku_deploy`, `roku_screenshot`, etc.

**Routing rule (recommended):** the repo also ships an [`AGENTS.md`](./AGENTS.md). Cursor picks it up automatically, so the agent knows the canonical *observe → act → wait → verify* loop and the RTA `uiElementId` gotcha without you having to re-explain it every session.

**Troubleshoot:** if the server stays grey/disabled, check `View → Output → MCP Logs` — the most common cause is `ROKU_DEVICE_HOST` unreachable on the LAN. Omit the `env` block entirely to fall back to SSDP auto-discovery.

</details>

<details>
<summary><strong>VS Code (GitHub Copilot)</strong> — agent mode, MCP via <code>.vscode/mcp.json</code></summary>

**Prerequisites:** VS Code 1.99+ with the GitHub Copilot extension and an active Copilot subscription that includes Agent mode.

**Install:** create `.vscode/mcp.json` in your project root:

```json
{
  "servers": {
    "roku": {
      "command": "npx",
      "args": ["-y", "roku-mcp"],
      "env": {
        "ROKU_DEVICE_HOST": "192.168.1.XXX",
        "ROKU_DEVICE_PASSWORD": "your-password"
      }
    }
  }
}
```

Reload the window (`Cmd+Shift+P` / `Ctrl+Shift+P` → **Developer: Reload Window**).

**Verify:** open Copilot Chat, switch the chat-mode dropdown to **Agent**, and ask "what roku tools do you have?". You should see the full `roku_*` list. The MCP panel (`Cmd+Shift+P` → **MCP: List Servers**) should show `roku` as `Running`.

**Troubleshoot:** if the server fails to start, run `npx -y roku-mcp --help` in a regular terminal first — that confirms Node 18+ and `npx` are working before VS Code launches it.

</details>

<details>
<summary><strong>Claude Desktop</strong> — official Anthropic desktop app</summary>

**Prerequisites:** Claude Desktop (latest from claude.ai/download), Node.js 18+ on `PATH`.

**Install:** edit your Claude Desktop config:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "roku": {
      "command": "npx",
      "args": ["-y", "roku-mcp"],
      "env": {
        "ROKU_DEVICE_HOST": "192.168.1.XXX",
        "ROKU_DEVICE_PASSWORD": "your-password"
      }
    }
  }
}
```

Fully quit and restart Claude Desktop (the menu-bar icon must close — `Cmd+Q` on macOS).

**Verify:** open a new chat. The 🛠️ icon in the input bar should list `roku-mcp` with all its tools. Ask "take a Roku screenshot" — Claude will request approval for `roku_screenshot` and run it.

**Troubleshoot:** if no tool icon appears, check `~/Library/Logs/Claude/mcp-server-roku.log` (macOS) — `command not found: npx` means Node isn't on the GUI app's `PATH`. Either install Node via the official `.pkg`, or hard-code the absolute paths: `"command": "/usr/local/bin/node"`, `"args": ["/usr/local/bin/npx", "-y", "roku-mcp"]`.

</details>

<details>
<summary><strong>Windsurf</strong> — Codeium's agentic IDE</summary>

**Prerequisites:** Windsurf with Cascade enabled.

**Install:** create `.windsurf/mcp.json` in your project root (or `~/.codeium/windsurf/mcp_config.json` globally):

```json
{
  "mcpServers": {
    "roku": {
      "command": "npx",
      "args": ["-y", "roku-mcp"],
      "env": {
        "ROKU_DEVICE_HOST": "192.168.1.XXX",
        "ROKU_DEVICE_PASSWORD": "your-password"
      }
    }
  }
}
```

Reload the window. In Cascade settings, refresh the MCP server list.

**Verify:** ask Cascade "list available MCP tools" — `roku_*` entries should appear.

**Troubleshoot:** Windsurf occasionally caches a stale server. If reloads don't pick up edits, fully quit Windsurf and reopen.

</details>

<details>
<summary><strong>Any MCP-compatible client</strong> (Continue, Cline, Zed, Codex, Claude Code, OpenCode, …)</summary>

The server speaks the standard MCP **stdio** transport. Anywhere you can declare:

```
command: npx
args:    ["-y", "roku-mcp"]
env:     { ROKU_DEVICE_HOST: "...", ROKU_DEVICE_PASSWORD: "..." }
```

…the server runs. Both env vars are optional: omit `ROKU_DEVICE_HOST` to use SSDP auto-discovery on the LAN, and pass `host` / `password` on each tool call to override.

The repo-root [`AGENTS.md`](./AGENTS.md) is picked up automatically by Claude Code, OpenCode, Codex CLI, and any other tool that follows the AGENTS.md convention, so those agents inherit the same usage guidance without extra setup.

</details>

## Agent rules

For better agent behavior (the `observe → act → wait → verify` loop, the RTA `uiElementId` gotcha that silently breaks `roku_edit_node`, when to use which tool), the repo ships drop-in rules pre-formatted for each major agent. The body is identical — only the wrapper differs to match what each agent auto-loads.

| Agent | File | Install path |
|---|---|---|
| Cursor | [`rules/cursor/roku-mcp.mdc`](./rules/cursor/roku-mcp.mdc) | `.cursor/rules/roku-mcp.mdc` |
| Claude Code | [`rules/claude-code/CLAUDE.md`](./rules/claude-code/CLAUDE.md) | `CLAUDE.md` (repo root) |
| Claude Desktop | [`rules/claude-desktop/roku-mcp.md`](./rules/claude-desktop/roku-mcp.md) | Settings → System Prompt |
| Windsurf | [`rules/windsurf/roku-mcp.md`](./rules/windsurf/roku-mcp.md) | `.windsurf/rules/roku-mcp.md` |
| Codex CLI / OpenCode / Aider | [`AGENTS.md`](./AGENTS.md) (repo root) | `AGENTS.md` (repo root) |

See [`rules/README.md`](./rules/README.md) for one-line copy commands per agent.

## Quickstart

Once your client is wired up, these three prompts work out of the box and exercise the main capability groups.

**1. Confirm the device is reachable**

```
Use roku-mcp to query my Roku device info and tell me the model, firmware, and IP.
```

The agent should call `roku_query_device_info` (and possibly `roku_discover` if no host is configured) and reply in one turn.

**2. Drive the UI with screenshots**

```
Press Home, wait 2 seconds, take a screenshot, then move Right twice and
screenshot again. Describe what changed between the two screenshots.
```

This exercises `roku_keypress`, `roku_sleep`, and `roku_screenshot` — the standard *observe → act → wait → verify* loop.

**3. Live-edit a running channel (requires RTA — see [Runtime UI Editing](#runtime-ui-editing))**

```
On the currently running dev channel, find the label that shows the page
title, change its text to "Hello from MCP", verify the change with
roku_get_value, then change it back.
```

The agent will `roku_query_app_ui` to locate the node, grab the `uiElementId`, call `roku_edit_node` + `roku_get_value`, and roll back — proving end-to-end RTA wiring.

## Code mode

Full mode (the default) exposes 46 tools, and each step of a flow (press, wait, check) is one tool call. Code mode exposes three tools and lets the agent write the whole flow as one short script:

| Tool | Purpose |
|---|---|
| `roku_run` | Runs a JavaScript async function body against the roku-mcp SDK and returns its result, logs and the files it wrote |
| `roku_sdk_docs` | Lists the calls a script can make; with a query, their full option schemas |
| `roku_screenshot` | The screenshot tool, since a script cannot return an image |

Turn it on with `ROKU_MCP_MODE=code` (also a plugin setting). It needs Node.js 22.13 or later; on older Node, `roku_run` refuses and says why.

```js
// roku_run code:
await roku.input.keys({ keys: ['Home', 'Down', 'Select'], delayMs: 300 });
await roku.device.sleep({ durationMs: 1500 });
return { focused: await roku.ui.focused(), player: await roku.device.mediaPlayer() };
```

Calls are `roku.<group>.<call>(options)`, one per SDK operation (`device`, `input`, `ui`, `app`, `console`, `rta`, `profile`, `perfetto`, `stream`, `rce`), with the same options as the matching tool. A failed call throws an error with `code` and `message`. Console sessions, captures and Perfetto recordings persist between `roku_run` calls.

The main saving is the tool list itself: on the fake devices in the test suite (`npm run bench`), it shrinks from about 12,000 to about 1,000 tokens, every session. The three measured flows also take one call instead of 3, 12 and 4, and each flow's own bytes shrink by about half (results in [`bench/results.json`](./bench/results.json)). Tokens are estimated as bytes / 4. The bench does not measure model reasoning per round trip, the earlier results a model re-reads each turn, or the cost of writing the script, so the real saving per flow depends on the agent.

### What a script can and cannot do

The script runs in a separate Node.js process started with the [permission model](https://nodejs.org/api/permissions.html) and no grants: no file system, no child processes, no workers, no native addons, no inspector, and an empty environment. Before the script runs, `process.kill` and the other signal functions are removed, `os.setPriority` and `trace_events` are stubbed, `node:sqlite` is disabled, and the process refuses to run if signals or `node:sqlite` are still reachable. Every `roku.*` call goes to the server, which checks it against the command list and the tool's input schema before running it. Secrets (`ROKU_RCE_TOKEN`, passwords) stay in the server, and errors come back as `code` and `message`, with secrets removed and no stack trace.

- **Files:** `roku.fs.read(path)` and `roku.fs.list(path)` read inside the server's working directory. `roku.fs.write(path, text)` creates data files only (`.json`, `.txt`, `.log`, `.csv`, `.md`, `.png`, `.trace`, ...) and only inside `roku-run/`. Console captures, screenshots and traces given a folder go there too. Paths that leave the working directory, follow a symlink out of it, or name secret files are refused: `.env*`, `*.env`, `.npmrc`, `.git-credentials`, `mcp.json`, `opencode.json`, `bsconfig*.json`, `rokudeploy*.json`, key files, and folders such as `.git`, `.ssh`, `.vscode`, `.cursor` and `.claude`.
- **Deploy:** `rootDir` must hold no secret file and no symlink. `files` and `stagingDir` cannot be set from a script.
- **Perfetto SQL:** `roku.perfetto.query` takes one read-only `SELECT` or `WITH` statement, because `trace_processor` runs with the server's rights. Words such as `replace`, `update`, `create` and `attach` are refused anywhere in the SQL, even as function or column names.
- **Limits:** 30 s by default (`timeoutMs`, at most 300 s), a 128 MB JavaScript heap, a 100 KiB return value, 64 KiB of logs, and 5,000 calls per run.
- **Billing:** `roku.rce.start` in a script starts a billed Cloud Device Run ($0.20 per hour, never stopped when idle). A script stops it in `finally` only if the script ends normally: when `roku_run` kills it for a timeout, memory or a crash, the Run keeps billing. Check `roku_rce_status` and call `roku_rce_stop`. The server still stops the Runs it started when it shuts down.
- **Known limits:**
  - **Network:** the script can open network connections (Node 22 does not restrict them). It never sees tokens or passwords, but it can send anything it can read (any non-secret file in the working directory, captured logs, UI dumps) to any host, and reach local services.
  - **Memory:** the heap limit does not count `ArrayBuffer` memory, so a script can allocate large buffers until its timeout.
  - **Calls in progress:** a device call already in progress when the run times out still finishes.
  - **Device hosts:** as with the tools, a deploy to a host the script names uses the configured password.
  - **Windows:** not tested yet.

## Command line (rokuctl)

`rokuctl` runs the same SDK operations from a shell or CI, one command per call:

```sh
npx -p roku-mcp rokuctl help
rokuctl app.deploy ./dist --rce-device 400
rokuctl console.capture "HomeScreen ready" --timeout-ms 60000 --settle-ms 0
rokuctl input.keys Down Select --delay-ms 400
rokuctl ui.app-ui --out ui.xml
```

- **Output:** exactly one JSON object on stdout, `{"ok":true,"data":...}` or `{"ok":false,"error":{"code":"...","message":"..."}}`.
- **Exit codes:** 0 ok, 1 device or tool error, 2 usage error, 3 timeout.
- **Large output:** a result over 64 KiB fails with `output_too_large` (exit 2); run it again with `--out <file>`. Screenshot bytes never go to stdout (stdout shows their size); `--out` saves them.
- **Options:** kebab-case (`--rce-device`, `--delay-ms`), or one `--json '{...}'` object. `--timeout <ms>` bounds the whole command.
- **Passwords:** come from the environment or `.env`; a password flag is refused.
- **Session commands:** the single-shot console, step-by-step capture and Perfetto recording keep state between calls, so they exist only in code mode. `console.capture` covers capture, wait and stop in one command.
- **Cloud Device Runs:** an interrupted `rokuctl rce.start` (Ctrl-C or `--timeout`) stops the Run it started. A finished `rce.start` leaves the Run up on purpose: stop it with `rokuctl rce.stop <device>`.

## Environment Variables

| Variable | Aliases (checked in order, canonical first) | Description |
|---|---|---|
| `ROKU_DEVICE_HOST` | `ROKU_IP`, `ROKU_HOST`, `ROKU_DEV_TARGET` | IP address or hostname of the Roku device |
| `ROKU_DEVICE_PASSWORD` | `ROKU_DEV_PASSWORD`, `ROKU_PASSWORD` | Developer password for the Roku device |
| `ROKU_RCE_TOKEN` | none | Roku Cloud Emulator personal access token. Required for any RCE use; see [Roku Cloud Emulator (RCE)](#roku-cloud-emulator-rce) |
| `ROKU_RCE_DEVICE` | none | Default RCE Cloud Device, by id or exact name |
| `ROKU_RCE_PASSWORD` | none | Developer password of the RCE Cloud Device |
| `ROKU_MCP_ENV_FILE` | none | Absolute path to an extra `.env` file to load (see below) |
| `ROKU_MCP_MODE` | none | `code` for [code mode](#code-mode); anything else, or unset, is the full tool set |

Device-facing tools accept a `host` parameter and an `rceDevice` parameter, which override the environment variables. `roku_deploy`, `roku_delete_dev_channel`, `roku_screenshot` and `roku_diagnose_stream` (for `captureLive`) also accept `password`. The target is chosen in this order: the `host` parameter, then the `rceDevice` parameter, then `ROKU_RCE_DEVICE`, then `ROKU_DEVICE_HOST` (or its aliases, including values from `.env`), then SSDP discovery.

### Auto-discovery

If no host is configured and no `host` parameter is provided, the server discovers Roku devices on the local network using SSDP and uses the first one found. You can also use the `roku_discover` tool to list all available devices. The password cannot be discovered and must still be configured.

### `.env` file support

The server loads a `.env` file from **its working directory** using [dotenv](https://www.npmjs.com/package/dotenv). The canonical names and the aliases above are all recognised, so an existing project `.env` such as

```
ROKU_IP=192.168.1.100
ROKU_DEV_PASSWORD=my-password
```

works unchanged. Do not map variables in the MCP `env` block (`"ROKU_DEVICE_HOST": "${ROKU_IP}"`): MCP clients do not expand variables from a `.env` file there. Omit the `env` block and make sure the server starts in the project folder:

- **VS Code** (`.vscode/mcp.json`): stdio servers accept `cwd` (defaults to the workspace folder) and `envFile`, e.g. `"cwd": "${workspaceFolder}"` or `"envFile": "${workspaceFolder}/.env"`.
- **Other clients** (Cursor, Claude Desktop, Windsurf, ...): project-level configs usually start the server in the project folder. If your client does not, set `ROKU_MCP_ENV_FILE` to the absolute path of the env file in the `env` block.

Empty `ROKU_*` values are ignored, so a blank value from a client config does not hide the `.env`.

## Roku Cloud Emulator (RCE)

[Roku Cloud Emulator](https://developer.roku.com/) runs Roku devices in the cloud. RCE calls them Cloud Devices, and each boot of a Cloud Device is a Run. roku-mcp drives a running Cloud Device with the same tools it uses for a LAN device, through the [roku-rce](https://www.npmjs.com/package/roku-rce) library.

> **Billing warning.** A Run costs **$0.20 per hour**, billed per minute from the moment the start is requested. RCE never stops an idle Run: only the maximum runtime cap ends it (`roku_rce_start` sets it to 60 minutes unless you pass `maxRuntimeMinutes`). Always call `roku_rce_stop` when you are done. When the server shuts down (stdin closes, or it receives SIGINT, SIGTERM or SIGHUP), it tries to stop every Run it started, but MCP clients may kill the process about four seconds after closing stdin, so do not rely on that.

### Configuration

| Variable | Description |
|---|---|
| `ROKU_RCE_TOKEN` | Your RCE personal access token. Required for every RCE tool and for any tool call that targets a Cloud Device. |
| `ROKU_RCE_DEVICE` | Optional default Cloud Device id or exact name. When it is set, device tools target that Cloud Device unless a `host` parameter is passed. |
| `ROKU_RCE_PASSWORD` | The Cloud Device developer password, used by `roku_deploy`, `roku_delete_dev_channel` and `roku_screenshot`. |

For a Cloud Device, the password is taken from the `password` parameter, then `ROKU_RCE_PASSWORD`, then `ROKU_DEVICE_PASSWORD` (or its aliases). A LAN device never uses `ROKU_RCE_PASSWORD`.

The token never appears in tool results, logs or error messages. roku-rce sends it only over HTTPS or secure WebSockets to `rce.roku.com` hosts on port 443, never follows redirects, and never routes requests through an HTTP proxy from the environment (such as `HTTPS_PROXY`), so a debugging proxy never sees it.

### Workflow

1. `roku_rce_list_devices` lists your Cloud Devices with their status and any current Run.
2. `roku_rce_status` shows one Cloud Device: its Run, the cost so far, the auto-stop time, whether this server started the Run, and its Snapshots.
3. `roku_rce_start` starts a Run (optionally from a `snapshotId`) and waits until the device takes input, which takes about 35 to 50 seconds. It refuses a Cloud Device that already has a Run. The call can block for up to about 5 minutes, so set your client's tool timeout above that.
4. Use the usual tools with `rceDevice` (or with `ROKU_RCE_DEVICE` set), for example `roku_deploy`, `roku_console_capture_start`, `roku_keypress` and `roku_screenshot`.
5. `roku_rce_stop` stops the Run and waits until the device reports shutdown. Confirm with `roku_rce_status`.

No tool creates or deletes Cloud Devices.

When the stdio server shuts down (stdin closes, or SIGINT, SIGTERM or SIGHUP), it stops, on a best-effort basis, every Run it started, including one whose start is still in flight. This cleanup covers the stdio entry only: a host that embeds `createServer()` with another transport must stop Runs itself (`roku_rce_stop`), or they bill until their max runtime.

### What works on a Cloud Device

RCE Cloud Devices start with "Control by mobile apps" set to **Limited**, and in that mode the device refuses most ECP commands with HTTP 403. To lift it, on the Cloud Device go to Settings > System > Advanced system settings > Control by mobile apps > Network access > Permissive, then save a new Snapshot and start from it.

| Status | Tools |
|---|---|
| Works (verified on RCE firmware 16.0.4) | `roku_rce_*`, `roku_query_device_info`, `roku_query_active_app`, `roku_keypress`, `roku_deploy`, `roku_delete_dev_channel`, `roku_screenshot`, `roku_console_capture_start`, `roku_console_wait`, `roku_console_capture_stop`, `roku_console_capture_status` |
| Works through the same paths, not separately verified | `roku_keypress_sequence`, `roku_type_text`, `roku_launch`, `roku_console_connect`, `roku_console_read`, `roku_console_send`, `roku_console_disconnect` |
| Needs the Permissive setting (403 in Limited mode; the error explains the fix) | `roku_query_app_ui`, `roku_query_sg_nodes`, `roku_find_node`, `roku_get_focused_node`, `roku_query_media_player` |
| Unverified | The runtime UI editing tools (`roku_edit_node`, `roku_set_node_visible`, `roku_move_node`, `roku_focus_node`, `roku_remove_node`, `roku_create_node`, `roku_get_value`, `roku_observe_field`). They try an RCE bridge to port 9000. Without RTA in the channel, RCE answered 502 and the tools report that port 9000 is closed. Whether RCE bridges port 9000 when RTA is present has not been tested. |
| Not supported (the tool returns an error naming the alternative) | `roku_perfetto_enable`, `roku_perfetto_start` (roku-perfetto needs direct access to the device), `roku_discover` (LAN only; use `roku_rce_list_devices`), `roku_diagnose_stream` with `captureLive` |

Tools that only read local files (`analyze_*`, `compare_*`, `query_perfetto`, `bsprof_info`, `roku_perfetto_stop`, `roku_sleep`, and `roku_diagnose_stream` without `captureLive`) do not depend on the device.

## Available Tools

### Deploy

| Tool | Description |
|---|---|
| `roku_deploy` | Sideload a Roku app; replaces the installed dev channel and cold-starts it. Stages in a temp folder (`stagingDir` overrides) so a project `bsconfig.json` can't make it wipe `rootDir` |
| `roku_delete_dev_channel` | Delete the currently sideloaded developer channel |

### Discovery

| Tool | Description |
|---|---|
| `roku_discover` | Scan the local network for Roku devices via SSDP (LAN only) |

### Roku Cloud Emulator

Every RCE tool other than the list and status tools affects billing: a Run costs $0.20 per hour from the start request until it is stopped.

| Tool | Description |
|---|---|
| `roku_rce_list_devices` | List the Cloud Devices of the account, with status and any current Run |
| `roku_rce_start` | Start a Run (billed) and wait until it takes input; refuses a device that already has a Run |
| `roku_rce_stop` | Stop the current Run and wait for shutdown |
| `roku_rce_status` | Run state, cost so far, auto-stop time, whether this server started the Run, and Snapshots |

### ECP (External Control Protocol)

| Tool | Description |
|---|---|
| `roku_keypress` | Send a single key press (Home, Select, Up, Down, Left, Right, Back, etc.) |
| `roku_keypress_sequence` | Send multiple key presses in sequence with configurable delay |
| `roku_type_text` | Type a text string into the focused field (e.g. email, password, search). The result reports only the character count |
| `roku_launch` | Launch or deep-link into a channel (`restart: true` exits it first) |
| `roku_query_device_info` | Get device model, firmware, serial number, network info |
| `roku_query_active_app` | Get the currently running app |
| `roku_query_media_player` | Get media player state (play/pause/buffer/stop), position, and duration |
| `roku_query_app_ui` | Get the current app UI tree as XML |
| `roku_query_sg_nodes` | Query SceneGraph nodes (all, roots, or by node ID) |
| `roku_find_node` | Search the UI tree for a node whose id or name matches `nodeId`, or by any attribute (subtype, text, etc.) |
| `roku_get_focused_node` | Get the currently focused node with all its properties |
| `roku_sleep` | Wait for a specified duration, clamped to 30000 ms (useful between navigation steps) |

### Screenshot

| Tool | Description |
|---|---|
| `roku_screenshot` | Capture a screenshot (returns base64 image and file path) |

### Debug Console

| Tool | Description |
|---|---|
| `roku_console_connect` | Open a connection to the BrightScript debug console (port 8085) for one follow-up `roku_console_read` or `roku_console_send` call |
| `roku_console_read` | Read the output buffered since the connect, then disconnect (single-shot) |
| `roku_console_send` | Send one command, return the output received within 500 ms, then disconnect (single-shot) |
| `roku_console_disconnect` | Close the console connection (safety net) |
| `roku_console_capture_start` | Keep port 8085 open and record the console to a file (skips the previous session's replay; default `./logs/<timestamp>-rokuDevice.log`) |
| `roku_console_wait` | Wait for a captured line matching a regex; optional `predicate: "jwtValid"`. Returns line number, timestamp and a redacted preview, never the raw console |
| `roku_console_capture_stop` | Stop the capture and close the file |
| `roku_console_capture_status` | Report whether a capture is active, its file and size |

The single-shot tools are not for streaming: to record the console or wait for a log line, use the capture tools. While a capture is active it holds port 8085, so `roku_console_read` and `roku_console_send` point you to `roku_console_wait` and the capture file instead.

### Runtime UI Editing

Edit the SceneGraph UI of a running sideloaded dev channel without redeploying — the same backend the SceneGraph Inspector in the [vscode-brightscript-language](https://github.com/rokucommunity/vscode-brightscript-language) extension uses. These tools speak the [roku-test-automation](https://github.com/triwav/roku-test-automation) (RTA) protocol against the channel's **On-Device Component** on TCP port 9000, so changes apply instantly with no debugger pause.

| Tool | Description |
|---|---|
| `roku_edit_node` | Set one or more fields on a node by id (visible, translation, text, color, opacity, etc.) |
| `roku_set_node_visible` | Show or hide a node by id |
| `roku_move_node` | Move a node to `[x, y]` |
| `roku_focus_node` | Set focus on a node by id (RTA `focusNode`) |
| `roku_remove_node` | Detach a node from its parent at runtime (RTA `removeNode`) |
| `roku_create_node` | Create a new node and append it to a parent by id (RTA `createChild`) |
| `roku_get_value` | Read a field value (or full `keyPath`) from the running scene (RTA `getValue`) |
| `roku_observe_field` | Wait for a field to change or match a value (RTA `onFieldChangeOnce`) — great for "wait until X" assertions |

**How it works.** Each tool opens a short-lived TCP connection to the RTA On-Device Component (port 9000) in the running channel, sends a length-prefixed JSON request (`setValue` / `getValue` / `focusNode` / ...) and parses the framed JSON response. Mutations apply on the SceneGraph thread without breaking into the debugger.

**Node addressing.** `nodeId` accepts either:
- A `uiElementId` like `RTA_1773` (visible in the `roku_query_sg_nodes` / `roku_query_app_ui` output for every node when RTA is running). This is the most robust target.
- A real BrightScript `id` attribute defined on the node in the channel source.

Anything matching `/^RTA_\d+$/` is sent with RTA `base: "elementId"`; otherwise it's sent with `base: "scene"`.

#### Required: install the RTA On-Device Component in your channel

These tools only work when the channel under test bundles RTA. You have two options:

**Option A — let `roku-debug` inject RTA on every sideload (recommended for VS Code users).**

1. In your `launch.json`, enable:

    ```json
    "injectRdbOnDeviceComponent": true
    ```

2. In `source/main.brs`, add the marker comment immediately after `screen.show()`:

    ```brightscript
    sub main()
        screen = createObject("roSGScreen")
        ' ...
        screen.show()
        ' vscode_rdb_on_device_component_entry
        ' ...
    end sub
    ```

**Option B — bundle the RTA component yourself.** Copy the `device/components` folder from [roku-test-automation](https://github.com/triwav/roku-test-automation) into your channel and instantiate `RTA_OnDeviceComponent` once from your scene.

Either way, on a successful install you will see this in the device log at channel launch:

```
[RTA][INFO] OnDeviceComponent init
```

If a runtime UI tool returns a connection-refused error, RTA is not present in the running channel — apply one of the two install options above and redeploy.

### BrightScript Profiler

Analyze `.bsprof` files generated by Roku devices. These tools use [bsprof-cli](https://www.npmjs.com/package/bsprof-cli) to parse the binary profiler format and return structured JSON reports.

| Tool | Description |
|---|---|
| `analyze_bsprof` | Analyze a .bsprof file — memory leaks, CPU hot paths, full report, or summary. Supports filtering by module/file and sorting options. |
| `compare_bsprof` | Compare two .bsprof profiles to detect regressions, improvements, new leaks, and resolved leaks. |
| `bsprof_info` | Get header metadata (target name, device, firmware, format version, features) without full parsing. |

To generate a `.bsprof` file, enable the profiler in your Roku app's `manifest` (`bs_prof_enabled=true`), run the app, and download the profile from `http://<device-ip>:8080`.

### Perfetto Tracing

Record, analyze, and compare Perfetto traces from Roku devices. Requires **Roku OS 15.1+**. These tools use [roku-perfetto](https://www.npmjs.com/package/roku-perfetto) for ECP control, WebSocket recording, and PerfettoSQL analysis.

| Tool | Description |
|---|---|
| `roku_perfetto_enable` | Enable Perfetto tracing for a channel via ECP (tracing starts on next app launch) |
| `roku_perfetto_start` | Start recording a Perfetto trace via WebSocket binary stream |
| `roku_perfetto_stop` | Stop recording and return file path, size, and duration |
| `analyze_perfetto` | Analyze a .trace file — summary, frame-drops, key-events, observers, rendezvous, set-fields, or threads. Returns AI-friendly structured JSON with suggestions. |
| `compare_perfetto` | Compare two .trace files to detect performance regressions and improvements |
| `query_perfetto` | Run a raw PerfettoSQL query against a trace file for custom analysis |

Workflow: enable tracing → relaunch the channel → start recording → interact with app → stop recording → analyze. Perfetto recording needs a LAN device; it is not supported on Roku Cloud Emulator. The `.trace` files can also be opened at [ui.perfetto.dev](https://ui.perfetto.dev/).

### Stream Diagnosis

Figure out why an HLS/DASH stream that plays everywhere else fails on Roku.

| Tool | Description |
|---|---|
| `roku_diagnose_stream` | Correlate the Video-node `errorInfo`, the manifest (a fetchable `url` or pasted `content`), and an optional Charles/HAR capture into ranked Roku-specific root causes (cause, evidence, confidence, severity, fix, doc link). Optionally `captureLive=true` deploys the bundled StreamProbe harness to capture the device error first. |

It detects Roku-specific gotchas such as muxed audio+video in fMP4/CMAF HLS (plays video but silent), video codecs/levels beyond the hardware decoder (e.g. 4K H.264 or 8K HEVC), token/403-gated CDNs, and DRM license rejections. The static manifest checks are treated as hints; when you supply the real device `errorInfo` the diagnosis is corroborated to high confidence.

HAR exports from an HTTP proxy such as [roxy](https://github.com/oscarsanchez/roxy) can be passed as `charlesSessionPath`, because the tool accepts `.har` files as well as Charles `.chlsj` files.

## Requirements

- Node.js 18+ (22.13+ for code mode: its sandbox uses the stable permission model)
- A Roku device with [Developer Mode](https://developer.roku.com/docs/developer-program/getting-started/developer-setup.md) enabled on the same network, or a Roku Cloud Emulator account (`ROKU_RCE_TOKEN`) with a Cloud Device
- For screenshots and deploy: a sideloaded dev channel must be running

## Privacy

The server runs on your machine and has no telemetry or analytics. It sends data only to:

- the Roku device you target on your local network (ECP, the developer web server, the debug console and the RTA port);
- Roku Cloud Emulator (`https://api.rce.roku.com` and `*.rce.roku.com`), only when you use a Cloud Device, authenticated with the token you provide;
- stream URLs that you pass to `roku_diagnose_stream`, to fetch the manifest;
- the npm registry, when `npx` downloads the server.

Device passwords and the Cloud Emulator token are read from the plugin settings, tool parameters or your environment, are used only for those requests, and are never written to tool output or log files. Screenshots, console captures and traces are saved to local files that you choose. Nothing is collected or retained by the author.

## License

MIT
