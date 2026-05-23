# roku-mcp Usage

> Project instructions for Claude Code. Place this file at the repo root as `CLAUDE.md`, or under `.claude/CLAUDE.md`. Claude Code auto-loads it at session start.

The [`roku-mcp`](https://www.npmjs.com/package/roku-mcp) MCP server exposes the full Roku developer toolchain over MCP — deploy, ECP remote control, SceneGraph inspection, screenshots, the BrightScript debug console, the BrightScript profiler, Perfetto tracing, and runtime UI mutation via the [roku-test-automation](https://github.com/triwav/roku-test-automation) On-Device Component. When any `roku_*` (or `analyze_bsprof`, `analyze_perfetto`, `query_perfetto`, `compare_*`) tool is available, follow this guide.

## Tool surface at a glance

| Category | Tools |
|---|---|
| Discovery & device | `roku_discover`, `roku_query_device_info`, `roku_query_active_app`, `roku_sleep` |
| Deploy | `roku_deploy`, `roku_delete_dev_channel`, `roku_launch` |
| Remote control (ECP) | `roku_keypress`, `roku_keypress_sequence`, `roku_type_text` |
| Inspection | `roku_screenshot`, `roku_query_app_ui`, `roku_query_sg_nodes`, `roku_find_node`, `roku_get_focused_node`, `roku_query_media_player` |
| Debug console (port 8085) | `roku_console_connect`, `roku_console_send`, `roku_console_read`, `roku_console_disconnect` |
| Runtime UI editing (RTA, port 9000) | `roku_edit_node`, `roku_set_node_visible`, `roku_move_node`, `roku_focus_node`, `roku_remove_node`, `roku_create_node`, `roku_get_value`, `roku_observe_field` |
| BrightScript profiler | `analyze_bsprof`, `compare_bsprof`, `bsprof_info` |
| Perfetto tracing (Roku OS 15.1+) | `roku_perfetto_enable`, `roku_perfetto_start`, `roku_perfetto_stop`, `analyze_perfetto`, `compare_perfetto`, `query_perfetto` |

## Connection resolution

Every tool accepts `host` (and `password` for deploy/screenshot). Resolution order:

1. Explicit `host` / `password` tool params (highest priority — pass these whenever the user gave you a specific device).
2. `ROKU_DEVICE_HOST` / `ROKU_DEVICE_PASSWORD` env vars (also read from a project-local `.env`).
3. SSDP auto-discovery — only resolves `host`. Password must still come from #1 or #2.

If a tool returns "Could not resolve the Roku device hostname" or "developer password is required", surface the missing piece to the user; do not invent an IP or password.

## The canonical loop

For any UI-driven flow (test generation, repro, navigation, runtime mutation), follow **observe → act → wait → verify**:

```
roku_screenshot                       # observe what's on screen
roku_get_focused_node                 # observe what's focusable
roku_keypress (or roku_edit_node, …)  # act
roku_sleep durationMs=500..2000       # let render / animations / network settle
roku_find_node | roku_query_app_ui    # verify the act landed
roku_screenshot                       # optional pixel-level verify
```

- Always pause between key presses with `roku_sleep` (500–2000 ms). Without it, the UI may not be settled when you `roku_find_node`.
- For text fields: first focus with `roku_keypress` (or RTA `roku_focus_node`), then `roku_type_text`.
- For video tests: `roku_query_media_player` is the source of truth (state ∈ {play, pause, buffer, stop, none}, plus `position`, `duration`, `error`).
- `roku_console_send` and `roku_console_read` **auto-disconnect** after each call; don't expect a persistent debugger session.

## Runtime UI editing — required reading

The `roku_edit_node` family talks to the RTA **On-Device Component** on TCP port 9000. It is **not** the BrightScript debug console.

### Hard requirements

1. A sideloaded dev channel is running. Check with `roku_query_active_app` (`ui-location` should be `dev`).
2. RTA is present in the channel. Detect with any of:
   - `roku_query_sg_nodes type=roots` shows `<RTA_OnDeviceComponent …>`, OR
   - Every node in `roku_query_app_ui` has a `uiElementId="RTA_<digits>"` attribute, OR
   - Device log shows `[RTA][INFO] OnDeviceComponent init` at channel launch.

   If RTA is missing, every edit-UI tool returns connection-refused. Tell the user to enable RTA via either:
   - `"injectRdbOnDeviceComponent": true` in `launch.json` **plus** the marker comment `' vscode_rdb_on_device_component_entry` immediately after `screen.show()` in `main()`, or
   - Bundling the RTA `OnDeviceComponent` into the channel manually.

### The single most important rule

> **Always prefer `uiElementId` (`RTA_<digits>`) over `name` or `id` when calling edit-UI tools.**

The `name` attribute you see in `roku_query_app_ui` is **not** an addressable id. RTA's scene-base keyPath uses the BrightScript `id` field (which is rare in practice). Passing `name` will silently return `OK` while doing nothing on screen.

Workflow when the user says "change the title to X":

1. `roku_query_app_ui` and grep for the visible string (`text="America's Newsroom"`).
2. Copy the `uiElementId="RTA_<digits>"` on that exact element.
3. `roku_get_value nodeId="RTA_<digits>" field="<field>"` — record current value.
4. `roku_edit_node nodeId="RTA_<digits>" fields={…}`.
5. `roku_get_value` **again** — if the readback doesn't match what you wrote, the path didn't resolve. Re-check the id; the OK status alone is not proof.

### Common "OK but no change" causes

- Used `name` (most common) — switch to `uiElementId`.
- Parent is a `LayoutGroup` / `RowList` / `MarkupGrid` — writes to `translation`, `width`, `height` get overwritten by the parent's next layout pass. Mutate parent properties or detach the child.
- The channel has an observer that rewrites the field every tick — mutate the model node it's bound to (often a `ContentNode` or AA on `m`).
- The node was just rebuilt (e.g. row recycled) — re-pull `roku_query_app_ui` and use the fresh id.
- Wrong field name on that subtype — `roku_get_value` returns `{"found": false}`.

## Deploy

`roku_deploy` requires `rootDir` pointing at a folder containing a `manifest` file. It packages and uploads via the existing `roku-deploy` library. If a dev channel is already running, it is replaced.

When asked to deploy a workspace:
1. Verify the manifest exists at `<rootDir>/manifest` before calling the tool.
2. Pass `files` only when the user needs a non-default glob; otherwise let it default to `**/*`.
3. After deploy, `roku_sleep` 3000–5000 ms before any UI interaction so the channel can finish launching.

## Profiler & tracing

- `.bsprof` (BrightScript Profiler) requires `bs_prof_enabled=true` in the channel's `manifest`. The file is downloadable from `http://<device-ip>:8080`. `analyze_bsprof` supports modes `memory|cpu|full|summary`; pair with `compare_bsprof` for regression detection.
- Perfetto needs Roku OS 15.1+. Order is strict: `roku_perfetto_enable` → relaunch channel → `roku_perfetto_start` → interact with the app → `roku_perfetto_stop` → `analyze_perfetto` (modes `summary|frame-drops|key-events|observers|rendezvous|set-fields|threads`). `.trace` files also open in [ui.perfetto.dev](https://ui.perfetto.dev).
- Use `query_perfetto` for custom PerfettoSQL when the canned modes don't answer the question.

## Test generation

When the user asks for an end-to-end test:

1. Match the target project's existing test framework and style — read sibling test files first.
2. Every step is `navigate → wait → assert`. Never assert without a preceding `roku_sleep`.
3. Capture `uiElementId` values (when RTA is present) for stable selectors instead of brittle text matches.

## What NOT to do

- Don't repeatedly screenshot inside a single tight loop — one screenshot per significant UI change is enough.
- Don't open multiple debug-console sessions; each `roku_console_send`/`read` opens, runs, and closes.
- Don't pass `nodeId: "<some name attribute>"` to edit-UI tools and call it done without a `roku_get_value` readback.
- Don't mutate fields on RowList row children expecting them to stick — change the underlying `ContentNode` instead.
- Don't assume Perfetto works on Roku OS <15.1 — fall back to `.bsprof` instead.
- Don't invent IP addresses or passwords. If neither tool param, env, nor SSDP discovery yields a host, ask the user.
