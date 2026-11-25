---
name: stream-diagnosis
description: Diagnose why an HLS or DASH stream fails on Roku, using roku_diagnose_stream to correlate the Video node errorInfo, the manifest, a Charles or HAR capture, and DRM config. Use when a Roku video errors, fails to start, or a DRM license request is rejected.
---

# Stream failure diagnosis

`roku_diagnose_stream` works without a device. Pass any combination:

- `errorInfo`: Video-node error (`errorCode` -1..-6, `errorInfo` `category`, `errcode`, `dbgmsg`, `drmerrcode`). JSON or pasted log text.
- `url` and/or `content`: manifest to analyze. Use `content` for token-gated URLs.
- `charlesSessionPath`: Charles `.chlsj` or `.har`. Binary `.chls` is not supported; ask the user to export `.chlsj` or `.har`.
- `drm`: `keySystem`, `licenseServerUrl`, `licenseHeaders`.

Output: ranked findings with `cause`, `evidence[]`, `confidence`, `fix`, `docUrl`. Correlated findings (for example `errorCode -6` plus a 403 on the license POST) rank highest. Spec hints are heuristic.

Fallback: if there is no `errorInfo` and a device is available, set `captureLive: true` with a fetchable `url`; `host` and `password` fall back to the environment and SSDP. `captureLive` is not supported on Roku Cloud Emulator Cloud Devices. This deploys the StreamProbe harness, plays the stream, and captures the real device error.
