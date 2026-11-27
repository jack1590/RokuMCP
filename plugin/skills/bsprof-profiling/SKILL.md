---
name: bsprof-profiling
description: Find a memory leak or a CPU hot path in a Roku channel from a BrightScript Profiler (.bsprof) file, or compare two builds for regressions. Use when the user asks to profile the app, hunt a leak, find slow BrightScript, or diff two profiles. Works on LAN devices, Cloud Devices and Roku OS below 15.1.
---

# Profile a memory leak or CPU hot path

## Steps

1. Enable profiling: the channel `manifest` needs `bs_prof_enabled=true`. Redeploy.
2. Reproduce the scenario on the device, then download the `.bsprof` from `http://<device-ip>:8080` (ask the user if you cannot reach it).
3. Check the file: `bsprof_info filePath=<path>` (header only, instant even at 600+ MB; duration reads 0 here).
4. Start broad: `analyze_bsprof mode=summary`.
5. Drill in only where the summary points: `mode=memory` (retained bytes, leaks) or `mode=cpu` (self time). Narrow with `top`, `filterModule`, `excludeModule` (e.g. `roku_ads_lib`), `threshold`.
6. Regressions: `compare_bsprof beforePath=... afterPath=...`.

### In code mode (`roku_run`)

```js
const summary = await roku.profile.analyze({ filePath: 'profiles/after.bsprof', mode: 'summary', top: 10 });
const diff = await roku.profile.compare({ beforePath: 'profiles/before.bsprof', afterPath: 'profiles/after.bsprof', top: 10 });
return { leaks: summary.report.topMemoryLeaks, diff: diff.diff };
```

Paths must be inside the server's working directory: save the downloaded `.bsprof` in the project folder first.

### From a shell (`rokuctl`)

```sh
rokuctl profile.analyze after.bsprof summary --top 10
rokuctl profile.compare before.bsprof after.bsprof --out diff.json
```

## When it goes wrong

| Symptom | Cause | Fix |
|---|---|---|
| The first analysis takes minutes | Large file (tens of millions of entries) | Expected once; the parse is cached for the next call on the same file |
| Empty or tiny report | Profiling was not enabled for that run | Check `bs_prof_enabled=true`, redeploy, reproduce again |
| `rokuctl` exit 2 `output_too_large` | A full report is over 64 KiB | Add `--out <file>` |
| ENOENT | Wrong path | Check the path. Tools and `rokuctl` take any path |
| `path_denied` in `roku_run` | The file is outside the working directory | Save the downloaded `.bsprof` inside the project folder, then pass that path |
