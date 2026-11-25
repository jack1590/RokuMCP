---
name: install
description: Install and configure the roku-mcp plugin (Claude Code or Cursor) against a Roku dev device. Use when the user asks how to install roku-mcp, point it at a different Roku, or hits "No Roku device found" or "developer password required".
---

# Install & configure roku-mcp

## Install

Claude Code:

```text
/plugin marketplace add jack1590/RokuMCP
/plugin install roku-mcp@roku-mcp-marketplace
```

Run `/reload-plugins`. The server is registered as `roku`.

Cursor: add the repo as a plugin marketplace (`.cursor-plugin/marketplace.json`) or copy it to `~/.cursor/plugins/local/roku-mcp/`.

The plugin starts the server with `npx -y roku-mcp@<version>`, pinned to the release that matches the plugin. The first launch downloads that version from the npm registry (needs Node 18+ and network access).

## Device credentials

Target resolution order, highest first:

1. Tool parameter `host` (a LAN device)
2. Tool parameter `rceDevice` (a Roku Cloud Emulator Cloud Device id or exact name)
3. Env var `ROKU_RCE_DEVICE`
4. Env var `ROKU_DEVICE_HOST` (aliases `ROKU_IP`, `ROKU_HOST`, `ROKU_DEV_TARGET`), also read from a project `.env`
5. SSDP discovery on the LAN (host only)

The password comes from the `password` parameter, then, for a Cloud Device, `ROKU_RCE_PASSWORD`, then `ROKU_DEVICE_PASSWORD` (aliases `ROKU_DEV_PASSWORD`, `ROKU_PASSWORD`). A LAN device never reads `ROKU_RCE_PASSWORD`. Any Cloud Device use also needs `ROKU_RCE_TOKEN`; see the `rce-cloud-emulator` skill.

Do not invent an IP or password. If neither is available, ask the user.

## Verify

1. `roku_discover`: SSDP sees the device.
2. `roku_query_device_info`: ECP on 8060 answers.
3. `roku_query_active_app`: foreground app reports correctly.
