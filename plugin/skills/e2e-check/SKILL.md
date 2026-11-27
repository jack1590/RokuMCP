---
name: e2e-check
description: Run or write an end-to-end check of a Roku channel (launch, navigate, assert UI and playback), in chat or as a test file, and run it from CI with rokuctl. Use when the user asks for an end-to-end test, a smoke test, a regression check after a change, or a scripted flow that must pass or fail.
---

# Run an end-to-end check

## Steps

1. Read the project's existing tests first and match their framework, naming and helpers.
2. Write the flow as navigate, wait, assert. Every assertion follows a wait.
3. Prefer stable selectors: `uiElementId` (`RTA_<digits>`) when RTA is present, then node `id`, then visible text.
4. Run it once against the device and report each step's result. Fix the flow, not the assertion, when a step fails because the UI was not ready.
5. For CI, use `rokuctl` (one JSON object on stdout; exit 0 ok, 1 device error, 2 usage error, 3 timeout).

### In code mode (`roku_run`)

The whole check is one call; it fails with the first error's `code` and `message`.

```js
const steps = [];
const check = (name, ok, detail) => { steps.push({ name, ok, detail }); if (!ok) throw Object.assign(new Error(name), { code: 'check_failed' }); };
await roku.device.launch({ appId: 'dev', restart: true });
await roku.device.sleep({ durationMs: 4000 });
check('home visible', (await roku.ui.find({ nodeId: 'homeScreen' })).length > 0);
await roku.input.keys({ keys: ['Down', 'Select'], delayMs: 400 });
await roku.device.sleep({ durationMs: 3000 });
const player = await roku.device.mediaPlayer();
check('video playing', player.player?.['@_state'] === 'play', player);
return steps;
```

### From a shell or CI (`rokuctl`)

```sh
set -e
rokuctl app.deploy ./dist --rce-device "$ROKU_RCE_DEVICE"
rokuctl console.capture "HomeScreen ready" --timeout-ms 60000 --settle-ms 0
rokuctl input.keys Down Select --delay-ms 400
rokuctl device.sleep 3000
rokuctl device.media-player | jq -e '.data.player["@_state"] == "play"'
```

`rokuctl console.capture` exits 3 when the line never appears. Secrets come from the environment or `.env`, never flags.

## When it goes wrong

| Symptom | Cause | Fix |
|---|---|---|
| Passes alone, fails in a sequence | Earlier step left the app on another screen | Start each check with `roku.device.launch({ appId: 'dev', restart: true })` or a deploy |
| `console.capture` times out after `device.launch restart` | The channel uses `sdk_instant_resume` and resumed instead of starting | Deploy for a cold start |
| Exit 2 `usage` from `rokuctl` | Unknown option, wrong type, or a password passed as a flag | Run `rokuctl help`; put passwords in the environment |
| `roku_run` error `timeout` | The flow took longer than `timeoutMs` (default 30 s) | Raise `timeoutMs` (max 300 s) or split the check |
| Media player `state` is `buffer` | Stream still starting | Wait, then read it again before failing |
