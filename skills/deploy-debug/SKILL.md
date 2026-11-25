---
name: deploy-debug
description: Sideload a Roku BrightScript/SceneGraph app to a dev device, redeploy after changes, and read the BrightScript debug console for crashes and prints. Use when the user wants to deploy, redeploy, or attach to the console.
---

# Deploy and debug a channel

## Deploy

1. Confirm `<rootDir>/manifest` exists. The tool fails otherwise.
2. `roku_deploy` with `rootDir` (absolute path). Pass `files` only for a non-default glob; the default is `**/*`.
3. `roku_sleep` 3000–5000 ms before any UI interaction so the channel finishes launching.

Deploying replaces the installed dev channel and cold-starts it. `roku_delete_dev_channel` removes it. On a Roku Cloud Emulator Cloud Device, pass `rceDevice` (see the `rce-cloud-emulator` skill).

## Console

- `roku_console_connect` opens a connection for one `roku_console_read` or `roku_console_send` call, which then closes it. Do not expect a persistent session; use the capture tools below to stream.
- Read after a repro step, not in a loop.

## Capture to a file and wait for a line

1. `roku_console_capture_start` (optional `file`; default `./logs/<ts>-rokuDevice.log`). Detach the VS Code debugger first: 8085 takes one client.
2. `roku_deploy` for a cold start, or `roku_launch appId=dev restart=true` (instant-resume channels resume instead of restarting).
3. `roku_console_wait pattern="<regex>"` (add `predicate=jwtValid` to require a non-expired `Authorization: Bearer` token).
4. `roku_console_capture_stop`. Read the matched line from the file; don't paste raw console output into chat.

## Screenshot

`roku_screenshot` once per significant UI change. Do not screenshot in a tight loop.
