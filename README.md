# roku-mcp

A [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) server for Roku device automation. Exposes tools for app deployment, ECP remote control, screenshot capture, SceneGraph node inspection, and BrightScript debug console access.

## Installation

```bash
npm install -g roku-mcp
```

Or run directly with npx (no install required):

```bash
npx roku-mcp
```

## Client Configuration

### Cursor

1. Create `.cursor/mcp.json` in your project root:

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

2. Reload the window: `Cmd+Shift+P` (macOS) / `Ctrl+Shift+P` (Windows/Linux) → **Developer: Reload Window**
3. Go to **Cursor Settings → MCP** and verify the "roku" server shows a green status. If it appears disabled, click the toggle to enable it.

### VS Code

Requires VS Code **1.99+** with the GitHub Copilot extension.

1. Create `.vscode/mcp.json` in your project root:

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

2. Reload the window: `Cmd+Shift+P` / `Ctrl+Shift+P` → **Developer: Reload Window**
3. Open Copilot Chat and switch to **Agent mode** (select from the chat mode dropdown). The roku tools will be available there.

### Claude Desktop

Add to your Claude Desktop config file:
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

Restart Claude Desktop after saving.

### Windsurf

Create `.windsurf/mcp.json` in your project root:

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

Reload the window after saving.

### Any MCP-compatible client

The server uses **stdio transport**. Any client that supports MCP can launch it with:

```
command: npx
args:    ["-y", "roku-mcp"]
```

Pass `ROKU_DEVICE_HOST` and `ROKU_DEVICE_PASSWORD` as environment variables, or omit the host to use SSDP auto-discovery.

## Environment Variables

| Variable | Description |
|---|---|
| `ROKU_DEVICE_HOST` | IP address or hostname of the Roku device |
| `ROKU_DEVICE_PASSWORD` | Developer password for the Roku device |

Both can also be passed as parameters on each tool call, which override the environment variables.

### Auto-discovery

If `ROKU_DEVICE_HOST` is not set and no `host` parameter is provided, the server automatically discovers Roku devices on the local network using SSDP and uses the first one found. You can also use the `roku_discover` tool to list all available devices. Note that the password cannot be discovered and must still be configured.

### `.env` file support

The server automatically loads a `.env` file from the current working directory using [dotenv](https://www.npmjs.com/package/dotenv). If your project's `.env` already uses `ROKU_DEVICE_HOST` and `ROKU_DEVICE_PASSWORD`, the server picks them up with no extra configuration — just omit the `env` block from your MCP config:

```
ROKU_DEVICE_HOST=192.168.1.100
ROKU_DEVICE_PASSWORD=my-password
```

If your project uses different variable names (e.g. `ROKU_IP`, `ROKU_DEV_PASSWORD`), you can map them in the `env` block:

```json
"env": {
  "ROKU_DEVICE_HOST": "${ROKU_IP}",
  "ROKU_DEVICE_PASSWORD": "${ROKU_DEV_PASSWORD}"
}
```

Or simply add the two expected variables to your `.env` alongside your existing ones.

## Available Tools

### Deploy

| Tool | Description |
|---|---|
| `roku_deploy` | Sideload (deploy) a Roku app to the device |
| `roku_delete_dev_channel` | Delete the currently sideloaded developer channel |

### Discovery

| Tool | Description |
|---|---|
| `roku_discover` | Scan the local network for Roku devices via SSDP |

### ECP (External Control Protocol)

| Tool | Description |
|---|---|
| `roku_keypress` | Send a single key press (Home, Select, Up, Down, Left, Right, Back, etc.) |
| `roku_keypress_sequence` | Send multiple key presses in sequence with configurable delay |
| `roku_type_text` | Type a text string into the focused field (e.g. email, password, search) |
| `roku_launch` | Launch or deep-link into a channel |
| `roku_query_device_info` | Get device model, firmware, serial number, network info |
| `roku_query_active_app` | Get the currently running app |
| `roku_query_media_player` | Get media player state (play/pause/buffer/stop), position, and duration |
| `roku_query_app_ui` | Get the current app UI tree as XML |
| `roku_query_sg_nodes` | Query SceneGraph nodes (all, roots, or by node ID) |
| `roku_find_node` | Search the UI tree for a node by ID or attribute (subtype, text, etc.) |
| `roku_get_focused_node` | Get the currently focused node with all its properties |
| `roku_sleep` | Wait for a specified duration (useful between navigation steps) |

### Screenshot

| Tool | Description |
|---|---|
| `roku_screenshot` | Capture a screenshot (returns base64 image and file path) |

### Debug Console

| Tool | Description |
|---|---|
| `roku_console_connect` | Open a TCP connection to the BrightScript debug console (port 8085) |
| `roku_console_read` | Read buffered console output and auto-disconnect |
| `roku_console_send` | Send a command to the debug console and auto-disconnect |
| `roku_console_disconnect` | Close the console connection (safety net) |

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

Workflow: enable tracing → start recording → interact with app → stop recording → analyze. The `.trace` files can also be opened at [ui.perfetto.dev](https://ui.perfetto.dev/).

## Requirements

- Node.js 18+
- A Roku device with [Developer Mode](https://developer.roku.com/docs/developer-program/getting-started/developer-setup.md) enabled on the same network
- For screenshots and deploy: a sideloaded dev channel must be running

## License

MIT
