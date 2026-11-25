# roku-mcp plugin for Claude Code

Unofficial community tool. Not affiliated with or endorsed by Roku, Inc.

This plugin adds the [`roku-mcp`](https://www.npmjs.com/package/roku-mcp) MCP server and a set of workflow skills for Roku app development: sideload deploy, ECP remote control, screenshots, the BrightScript debug console, runtime SceneGraph UI editing, BrightScript and Perfetto profiling, stream failure diagnosis, and Roku Cloud Emulator (RCE) Cloud Devices.

## Install

```
/plugin install roku-mcp --marketplace jack1590/RokuMCP
```

## What the plugin runs, sends and fetches

- **Runs:** one local stdio MCP server, started as `npx -y roku-mcp@<exact version>`. The version is pinned in `.mcp.json` and matches the plugin version. The plugin folder contains no scripts, hooks or package files.
- **Fetches:** `npx` downloads that pinned `roku-mcp` release and its dependencies from the npm registry on first start. Node 18 or later is required.
- **Sends:** requests to the Roku device you target on your local network; requests to Roku Cloud Emulator (`https://api.rce.roku.com` and `*.rce.roku.com`) only when you use a Cloud Device; requests to stream URLs that you pass to the stream diagnosis tool. There is no telemetry.

## Settings

Claude Code asks for these when the plugin is enabled. All are optional.

| Setting | Purpose |
|---|---|
| `ROKU_DEVICE_HOST` | IP address or hostname of the Roku device. Empty means SSDP discovery. |
| `ROKU_DEVICE_PASSWORD` | Developer mode password of the device. Stored as sensitive. |
| `ROKU_RCE_TOKEN` | Roku Cloud Emulator token. Needed only for Cloud Devices. Stored as sensitive. |
| `ROKU_RCE_DEVICE` | Default Cloud Device id or exact name. |
| `ROKU_RCE_PASSWORD` | Developer password of the Cloud Device. Stored as sensitive. |

Roku Cloud Emulator Runs are billed by Roku at $0.20 per hour and never stop when idle. Always stop a Run with `roku_rce_stop`.

## More

Full tool reference, privacy statement and source: https://github.com/jack1590/RokuMCP

License: MIT.
