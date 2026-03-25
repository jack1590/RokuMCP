# roku-mcp

A [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) server for Roku device automation. Exposes tools for app deployment, ECP remote control, screenshot capture, SceneGraph node inspection, and BrightScript debug console access.

## Installation

```bash
npm install -g roku-mcp
```

Or run directly with npx:

```bash
npx roku-mcp
```

## Cursor Configuration

Add the following to your project's `.cursor/mcp.json`:

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

Replace `ROKU_DEVICE_HOST` with your Roku device's IP address and `ROKU_DEVICE_PASSWORD` with the developer password you set during dev mode setup.

## Environment Variables

| Variable | Description |
|---|---|
| `ROKU_DEVICE_HOST` | IP address or hostname of the Roku device |
| `ROKU_DEVICE_PASSWORD` | Developer password for the Roku device |

Both can also be passed as parameters on each tool call, which override the environment variables.

### Auto-discovery

If `ROKU_DEVICE_HOST` is not set and no `host` parameter is provided, the server automatically discovers Roku devices on the local network using SSDP and uses the first one found. You can also use the `roku_discover` tool to list all available devices. Note that the password cannot be discovered and must still be configured.

### `.env` file support

The server automatically loads a `.env` file from the current working directory using [dotenv](https://www.npmjs.com/package/dotenv). If your project's `.env` already uses `ROKU_DEVICE_HOST` and `ROKU_DEVICE_PASSWORD`, the server picks them up with no extra configuration:

```
ROKU_DEVICE_HOST=192.168.1.100
ROKU_DEVICE_PASSWORD=my-password
```

```json
{
  "mcpServers": {
    "roku": {
      "command": "npx",
      "args": ["-y", "roku-mcp"]
    }
  }
}
```

If your project uses different variable names (e.g. `ROKU_IP`, `ROKU_DEV_PASSWORD`), you can map them in the `env` block:

```json
{
  "mcpServers": {
    "roku": {
      "command": "npx",
      "args": ["-y", "roku-mcp"],
      "env": {
        "ROKU_DEVICE_HOST": "${ROKU_IP}",
        "ROKU_DEVICE_PASSWORD": "${ROKU_DEV_PASSWORD}"
      }
    }
  }
}
```

Or simply add the two expected variables to your `.env`:

```
ROKU_DEVICE_HOST=192.168.1.100
ROKU_DEVICE_PASSWORD=my-password
```

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
| `roku_launch` | Launch or deep-link into a channel |
| `roku_query_device_info` | Get device model, firmware, serial number, network info |
| `roku_query_active_app` | Get the currently running app |
| `roku_query_app_ui` | Get the current app UI tree as XML |
| `roku_query_sg_nodes` | Query SceneGraph nodes (all, roots, or by node ID) |

### Screenshot

| Tool | Description |
|---|---|
| `roku_screenshot` | Capture a screenshot (returns base64 image and file path) |

### Debug Console

| Tool | Description |
|---|---|
| `roku_console_connect` | Open a TCP connection to the BrightScript debug console (port 8085) |
| `roku_console_read` | Read buffered console output since last read |
| `roku_console_send` | Send a command to the debug console (bt, var, cont, step, etc.) |
| `roku_console_disconnect` | Close the console connection |

## Requirements

- Node.js 18+
- A Roku device with [Developer Mode](https://developer.roku.com/docs/developer-program/getting-started/developer-setup.md) enabled on the same network
- For screenshots and deploy: a sideloaded dev channel must be running

## License

MIT
