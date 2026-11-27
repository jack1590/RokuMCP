---
name: install
description: Install and configure roku-mcp (Claude Code or Cursor plugin, or the rokuctl CLI), point it at a Roku dev device or Cloud Device, and choose full or code mode. Use when the user asks how to install roku-mcp, switch device, turn on code mode, or hits "No Roku device found" or "developer password is required".
---

# Install and configure roku-mcp

## Steps

1. Install the plugin. Claude Code:

   ```text
   /plugin marketplace add jack1590/RokuMCP
   /plugin install roku-mcp@roku-mcp-marketplace
   ```

   Run `/reload-plugins`; the server is registered as `roku`. Cursor: add the repo as a plugin marketplace (`.cursor-plugin/marketplace.json`). The plugin starts `npx -y roku-mcp@<version>`, pinned to the plugin's release (the first launch downloads it). Code mode needs Node.js 22.13 or later.
2. Give it a device. The target is chosen in this order: the `host` parameter, the `rceDevice` parameter, `ROKU_RCE_DEVICE`, `ROKU_DEVICE_HOST` (aliases `ROKU_IP`, `ROKU_HOST`, `ROKU_DEV_TARGET`, also read from a project `.env`), then SSDP discovery on the LAN.
3. Give it the password in the environment or `.env`: `ROKU_DEVICE_PASSWORD` (aliases `ROKU_DEV_PASSWORD`, `ROKU_PASSWORD`); for a Cloud Device `ROKU_RCE_PASSWORD`, plus `ROKU_RCE_TOKEN` (see `rce-cloud-emulator`). A LAN device never reads `ROKU_RCE_PASSWORD`.
4. Choose the mode (1.10.0 and later). Full mode (default) offers every tool. Code mode, `ROKU_MCP_MODE=code` (the plugin's "Server mode" setting, or the server environment), offers `roku_run`, `roku_sdk_docs` and `roku_screenshot`: fewer tool definitions in context and one call per multi-step flow.
5. Verify: `roku_query_device_info` (ECP on 8060 answers) and `roku_query_active_app`. In code mode: `roku_run` with `return await roku.device.info()`.
6. Shell or CI: `npx -p roku-mcp rokuctl help` lists the commands; each prints one JSON object.

Do not invent an IP or a password. If none is available, ask the user.

## When it goes wrong

| Symptom | Cause | Fix |
|---|---|---|
| "No Roku device found" | No host, no Cloud Device, SSDP found nothing | Set `ROKU_DEVICE_HOST` or pass `host`; for a Cloud Device set `ROKU_RCE_DEVICE` |
| "developer password is required" | Password not in the environment | Add `ROKU_DEVICE_PASSWORD` (or `ROKU_RCE_PASSWORD`) to `.env` |
| "Authentication failed — the Roku developer password is incorrect" | Wrong password | The user corrects it in `.env` |
| `MCP server does not exist: <name>` | Wrong server prefix | Use the tool names exactly as listed |
| `roku_run` error `unsupported_node` | Code mode needs Node 22.13+ | Upgrade Node, or use full mode |
| `roku_run` error `path_denied` | The path is outside the working directory, a secret file, or a write outside `roku-run/` | Use a path inside the project; write under `roku-run/` |
