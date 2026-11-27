---
name: stream-diagnosis
description: Find out why an HLS or DASH stream fails on Roku (start failure, playback error, DRM license rejected) from the evidence the developer has, no device required. Use when a Roku video errors, will not start, or a DRM license request is refused.
---

# Diagnose a failing stream

## Steps

1. Collect what exists; any combination works:
   - `errorInfo`: the Video node error (`errorCode` -1 to -6, `errorInfo` with `category`, `errcode`, `dbgmsg`, `drmerrcode`), as JSON or pasted log text.
   - `url` or `content`: the manifest. Use `content` when the URL is token-gated.
   - `charlesSessionPath`: a Charles `.chlsj` or a `.har` file. Binary `.chls` does not work; ask the user to export `.chlsj` or `.har`.
   - `drm`: `keySystem`, `licenseServerUrl`, `licenseHeaders`.
2. Call `roku_diagnose_stream` with them.
3. Report the ranked findings (`cause`, `evidence`, `confidence`, `fix`, `docUrl`). Correlated findings, such as `errorCode -6` plus a 403 on the license POST, rank highest. Spec hints are heuristic; say so.
4. No `errorInfo` and a LAN device available: set `captureLive: true` with a fetchable `url`. This replaces the dev channel with the StreamProbe harness, plays the stream and captures the device error. Ask before doing it.

### In code mode (`roku_run`)

```js
return await roku.stream.diagnose({ errorInfo: '{"errorCode":-6,"errorInfo":{"category":"drm","drmerrcode":13}}', charlesSessionPath: 'captures/session.har' });
```

### From a shell (`rokuctl`)

```sh
rokuctl stream.diagnose --url https://example.com/master.m3u8 --error-info '{"errorCode":-3}'
```

## When it goes wrong

| Symptom | Cause | Fix |
|---|---|---|
| "Provide at least one evidence source" | Nothing to correlate | Pass at least one of the inputs above |
| Note "Charles session could not be read/parsed" | Binary `.chls`, or a wrong path | Export `.chlsj` or `.har`; check the path |
| "captureLive is not supported on Roku Cloud Emulator devices" | Live capture needs a LAN device | Pass `host`, or play the stream in the user's channel on the Cloud Device and pass the reported error as `errorInfo` |
| Note "captureLive was requested but no url was provided" | Live capture needs a fetchable stream | Pass `url` |
