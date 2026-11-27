---
name: perfetto-tracing
description: Find why a Roku channel drops frames or feels slow (rendering cost, observer storms, rendezvous waits, threading) by recording and analyzing a Perfetto trace on Roku OS 15.1+, or compare two traces. Use when the user reports jank, slow key response, or a performance regression on a LAN device.
---

# Trace frame drops and slow UI

Perfetto needs Roku OS 15.1+ on a LAN device. On a Cloud Device or older OS, use the `bsprof-profiling` skill.

## Steps

The order is strict; skipping a step gives an empty trace.

1. `roku_perfetto_enable` (channel `dev` by default).
2. Relaunch the channel: `roku_deploy`, or `roku_launch appId=dev restart=true`, then `roku_sleep` 3000 to 5000 ms.
3. `roku_perfetto_start`.
4. Reproduce the slow interaction (`roku_keypress_sequence`, etc.).
5. `roku_perfetto_stop`: returns the `.trace` path, size and duration.
6. `analyze_perfetto mode=summary`, then the mode the summary points to: `frame-drops`, `key-events`, `observers`, `rendezvous`, `set-fields`, `threads`.
7. `query_perfetto` for custom PerfettoSQL; `compare_perfetto` to diff two traces. Traces also open at ui.perfetto.dev.

### In code mode (`roku_run`)

```js
await roku.perfetto.enable({});
await roku.device.launch({ appId: 'dev', restart: true });
await roku.device.sleep({ durationMs: 4000 });
await roku.perfetto.start({ outDir: 'traces' });
await roku.input.keys({ keys: ['Down', 'Down', 'Down', 'Right'], delayMs: 200 });
const trace = await roku.perfetto.stop();
return await roku.perfetto.analyze({ filePath: trace.filePath, mode: 'frame-drops', top: 10 });
```

In `roku_run`, `outDir` is under `roku-run/`. Recording keeps state between calls, so the CLI cannot record; it can analyze (`rokuctl perfetto.analyze <file> summary`).

## When it goes wrong

| Symptom | Cause | Fix |
|---|---|---|
| Empty trace | Channel not relaunched after enable | Follow the order: enable, relaunch, start |
| "not supported on Roku Cloud Emulator devices" | Perfetto needs direct LAN access | Use a LAN device, or `bsprof-profiling` |
| "No active Perfetto recording" | Stop without start, or the server restarted | Start again |
| First analysis is slow | `trace_processor` downloads on first use | Expected once |
| `roku_run` error `output_too_large` | The report is over 100 KiB | Lower `top`, or `roku.fs.write('trace-report.json', JSON.stringify(report))` and return the path |
