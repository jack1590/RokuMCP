---
name: bsprof-profiling
description: Analyze BrightScript Profiler (.bsprof) files from a Roku device for memory leaks, CPU hot paths, and build-to-build regressions, using bsprof_info, analyze_bsprof, and compare_bsprof. Use when the user asks to profile a Roku app, hunt a leak, or diff two profiles.
---

# BrightScript profiling

## Prerequisite

The channel `manifest` needs `bs_prof_enabled=true`. Profiles download from `http://<device-ip>:8080`.

## Tools

- `bsprof_info`: header only (target, model, firmware, format version, features). Instant even for 600+ MB files. Duration reads as 0; use `analyze_bsprof` for duration.
- `analyze_bsprof`: `mode` = `memory` | `cpu` | `full` | `summary`. Large files take minutes on the first parse. The single-entry cache reuses it for the next call on the same file.
- `compare_bsprof`: regression diff of two profiles. It parses both; the second is the one left cached.

Start with `summary`. Drill into `memory` or `cpu` only when the summary points somewhere.
