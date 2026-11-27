---
name: deploy-debug
description: Sideload a Roku channel, redeploy after a change, and read what the BrightScript debug console says (crashes, prints, a log line you are waiting for). Use when the user wants to deploy or redeploy, find out why the channel crashed, or wait for a specific log line.
---

# Deploy and read the console

## Steps

1. Check that `<rootDir>/manifest` exists. Deploy the build folder, not the repo root.
2. Start a console capture before the deploy, so startup output is kept: `roku_console_capture_start` (port 8085 takes one client: detach the VS Code debugger first).
3. Deploy: `roku_deploy rootDir=<absolute path>`. It replaces the dev channel and cold-starts it.
4. Wait for the line that proves the step worked: `roku_console_wait pattern="<regex>"` (add `predicate=jwtValid` to require an unexpired `Authorization: Bearer` token).
5. Stop: `roku_console_capture_stop`. Read the matched line from the capture file; do not paste raw console output into chat.
6. After a crash, connect and ask for the backtrace: `roku_console_connect`, then `roku_console_send command=bt` (each connect serves one read or send).

### In code mode (`roku_run`)

```js
const cap = await roku.console.captureStart({ settleMs: 0 });
await roku.app.deploy({ rootDir: 'dist' });
const line = await roku.console.wait({ pattern: 'HomeScreen ready', timeoutMs: 60000 });
const summary = await roku.console.captureStop();
return { line, file: summary.file };
```

Captures from `roku_run` are written under `roku-run/`. A deploy from `roku_run` refuses a `rootDir` that holds secret files or symlinks, and refuses `files` and `stagingDir`.

### From a shell (`rokuctl`)

```sh
rokuctl app.deploy ./dist
rokuctl console.capture "HomeScreen ready" --timeout-ms 60000 --settle-ms 0 --file logs/startup.log
```

## When it goes wrong

| Symptom | Cause | Fix |
|---|---|---|
| "No manifest file found at ..." | `rootDir` is not the channel folder | Point it at the folder with `manifest` |
| `reason: "waiting_for_debugger"` | Channel was sideloaded by the VS Code debugger and waits on 8081 | Redeploy with `roku_deploy` |
| `reason: "timeout"` after `roku_launch restart=true` | Instant resume: no startup code ran | Use `roku_deploy` for a cold start |
| "Capture already active" or console connect refused | Port 8085 holds one client | `roku_console_capture_stop`, or detach the other client |
| "developer password is required" | No password in the environment | Ask the user to set `ROKU_DEVICE_PASSWORD` (or `ROKU_RCE_PASSWORD`) in `.env` |
| "stagingDir must not be rootDir, inside it, or contain it" | roku-deploy empties and deletes the staging folder | Leave `stagingDir` unset |
