---
name: perfetto-tracing
description: Record and analyze Perfetto traces from Roku devices (Roku OS 15.1+) to find frame drops, scene-graph rendering cost, observer storms, rendezvous timing, and threading issues. Use when the user asks to capture a trace, debug a performance regression, or diff two traces.
---

# Perfetto tracing

Strict order. Skipping a step produces an empty trace. Perfetto needs a LAN device: on a Roku Cloud Emulator Cloud Device, `roku_perfetto_enable` and `roku_perfetto_start` return an error, so profile with a `.bsprof` capture instead.

1. `roku_perfetto_enable`
2. Relaunch the channel (`roku_launch` or `roku_deploy`), then `roku_sleep` 3000–5000 ms
3. `roku_perfetto_start`
4. Interact with the app (`roku_keypress_sequence`, etc.)
5. `roku_perfetto_stop`: returns the `.trace` path, size, duration
6. `analyze_perfetto` with `mode` = `summary` | `frame-drops` | `key-events` | `observers` | `rendezvous` | `set-fields` | `threads`
7. `query_perfetto` for custom PerfettoSQL when the modes do not answer the question. `compare_perfetto` diffs two traces.

On Roku OS below 15.1, use `bsprof-profiling` instead. `.trace` files also open at ui.perfetto.dev.
