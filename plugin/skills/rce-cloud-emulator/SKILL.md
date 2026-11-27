---
name: rce-cloud-emulator
description: Test a Roku channel on a Roku Cloud Emulator (RCE) Cloud Device, starting and stopping its billed Run safely. Use when the user asks to test on RCE, a cloud Roku or a Cloud Device, or names a Cloud Device id or name.
---

# Use a Cloud Device

A Cloud Device is permanent; each boot of it is a Run. **A Run costs $0.20 per hour, billed per minute from the start request, and RCE never stops an idle Run.** Start one only when the user asked, keep `maxRuntimeMinutes` low (default 60, at most 240), and always stop it, after a failure too.

Configuration: `ROKU_RCE_TOKEN` (required, in the environment or `.env`, never pasted into chat), `ROKU_RCE_DEVICE` (default Cloud Device), `ROKU_RCE_PASSWORD` (developer password, for deploy, delete and screenshot).

## Steps

1. `roku_rce_list_devices`: find the Cloud Device; check that `run` is null. If another client started a Run, ask the user before touching it.
2. `roku_rce_status rceDevice=<id>`: pick a Snapshot if the user named one.
3. `roku_rce_start rceDevice=<id> [snapshotId=<id>] maxRuntimeMinutes=<n>`: waits until the device takes input (about 35 to 50 s).
4. Work with the usual tools and `rceDevice=<id>`: capture the console, deploy, wait for the marker line, press keys, take screenshots.
5. `roku_rce_stop rceDevice=<id>`, then `roku_rce_status` to confirm `status: "shutdown"`.

### In code mode (`roku_run`)

Pass `rceDevice` to `roku_run` so every call targets the Cloud Device; stop the Run in `finally`.

```js
await roku.rce.start({ rceDevice: '400', maxRuntimeMinutes: 15 });
try {
  await roku.console.captureStart({ settleMs: 0 });
  try {
    await roku.app.deploy({ rootDir: 'dist' });
    return await roku.console.wait({ pattern: 'HomeScreen ready', timeoutMs: 90000 });
  } finally {
    await roku.console.captureStop();
  }
} finally {
  await roku.rce.stop({ rceDevice: '400' }); // runs even if the capture fails
}
```

Give this `roku_run` a `timeoutMs` of about 300000: the start alone can take a minute.

### From a shell (`rokuctl`)

```sh
rokuctl rce.start 400 --max-runtime-minutes 15
rokuctl app.deploy ./dist --rce-device 400
rokuctl rce.stop 400
```

Interrupting `rokuctl rce.start` (Ctrl-C or `--timeout`) stops the Run it started; a finished `rce.start` leaves the Run up on purpose.

## When it goes wrong

| Symptom | Cause | Fix |
|---|---|---|
| "already has a Run" | A Run is up (maybe another person's) | Check `roku_rce_status`; ask before stopping it |
| "started and is billing, but it did not become ready" | The Run never took input | `roku_rce_status`, then `roku_rce_stop` if it is not needed |
| UI queries fail with "the device refused ECP ... (403: ECP command not allowed in Limited mode.)" | Snapshot in Limited ECP mode | The user switches Settings > System > Advanced system settings > Control by mobile apps > Network access > Permissive, saves a new Snapshot and starts from it. Do not retry in a loop |
| "Port 9000 did not answer through the Roku Cloud Emulator bridge" | No RTA in the channel, or RCE does not bridge 9000 (unverified) | Use a LAN device for live UI editing |
| `roku_perfetto_*`, `roku_discover`, or `captureLive` refused | Not supported on RCE | Use a LAN device |
| "needs ROKU_RCE_TOKEN" | Token not set | The user adds it to `.env`; never ask for it in chat |
