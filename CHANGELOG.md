# Changelog

## [1.5.1] - 2026-04-13

### Fixed
- Upgraded `roku-perfetto` to v1.0.1 — fixes trace analysis returning empty results. The TraceProcessor now uses CLI-based queries instead of the broken HTTP RPC protobuf transport.

## [1.5.0] - 2026-04-13

### Added
- `roku_perfetto_enable` — Enable Perfetto tracing for a Roku channel via ECP. Requires Roku OS 15.1+.
- `roku_perfetto_start` — Start recording a Perfetto trace via WebSocket binary stream to a local file.
- `roku_perfetto_stop` — Stop recording and return file path, size, and duration.
- `analyze_perfetto` — Analyze a Perfetto trace file with AI-friendly suggestions. Modes: summary, frame-drops, key-events, observers, rendezvous, set-fields, threads.
- `compare_perfetto` — Compare two Perfetto traces to detect performance regressions and improvements.
- `query_perfetto` — Run raw PerfettoSQL queries against a Perfetto trace file for custom analysis.
- New dependency: `roku-perfetto` for Roku Perfetto tracing, recording, and analysis.

## [1.4.0] - 2026-04-10

### Added
- `analyze_bsprof` — Analyze .bsprof profiler files from Roku devices. Supports memory, cpu, full, and summary modes with filtering/sorting options. Returns structured JSON reports.
- `compare_bsprof` — Compare two .bsprof profiles to detect memory regressions, improvements, new leaks, resolved leaks, and CPU time deltas.
- `bsprof_info` — Get header metadata (target name, device, format version, features) from a .bsprof file without full parsing.
- New dependency: `bsprof-cli` for BrightScript profiler file parsing and analysis.

## [1.3.0] - 2026-03-25

### Added
- `roku_type_text` — Type a text string into the focused field (each character sent as a Lit_ keypress). Ideal for search, login, and form-filling flows.
- `roku_query_media_player` — Query media player state (play, pause, buffer, stop), position, duration, and error info. Essential for video playback testing.
- `roku_find_node` — Search the app UI tree for a node by ID or attribute (subtype, text, name, etc.) and return its properties.
- `roku_get_focused_node` — Get the currently focused node with all its properties (id, subtype, text, bounds).
- `roku_sleep` — Wait for a specified duration between test steps (capped at 30 seconds).

## [1.2.2] - 2026-03-25

### Improved
- Console tools (`roku_console_read`, `roku_console_send`) now auto-disconnect after returning output, preventing stale TCP connections.
- Deploy tool includes all project files by default (`**/*`) instead of only `source/` and `components/`, and validates the manifest before deploying.
- Deploy staging isolated to temp directory to prevent interference with source files.
- Multi-client setup docs: Cursor, VS Code, Claude Desktop, Windsurf, and generic MCP clients.

## [1.2.1] - 2026-03-25

### Improved
- User-friendly error messages across all tools. Authentication failures (401), connection refused, timeouts, and missing config now return clear, actionable guidance instead of raw error strings.
- Centralized error formatting via `friendlyError()` helper so the LLM can better assist users when something goes wrong.

## [1.2.0] - 2026-03-25

### Added
- SSDP-based auto-discovery of Roku devices on the local network. When no host is configured, the server automatically finds and uses the first available device.
- New `roku_discover` tool to scan the network and list all Roku devices with their IPs.

## [1.1.1] - 2026-03-25

### Improved
- README now documents how to map custom `.env` variable names (e.g. `ROKU_IP`, `ROKU_DEV_PASSWORD`) to the expected `ROKU_DEVICE_HOST` and `ROKU_DEVICE_PASSWORD`.

## [1.1.0] - 2026-03-25

### Added
- Automatic `.env` file loading via `dotenv`. The server now reads environment variables from the working directory's `.env` file, so Roku projects with existing `.env` files work out of the box.

## [1.0.0] - 2026-03-25

### Added
- Initial release.
- **Deploy tools**: `roku_deploy`, `roku_delete_dev_channel` (via `roku-deploy`).
- **ECP tools**: `roku_keypress`, `roku_keypress_sequence`, `roku_launch`, `roku_query_device_info`, `roku_query_active_app`, `roku_query_app_ui`, `roku_query_sg_nodes`.
- **Screenshot tool**: `roku_screenshot` (returns base64 image and file path).
- **Debug console tools**: `roku_console_connect`, `roku_console_read`, `roku_console_send`, `roku_console_disconnect` (TCP socket on port 8085).
- Environment variable configuration (`ROKU_DEVICE_HOST`, `ROKU_DEVICE_PASSWORD`).
- Per-tool parameter overrides for host and password.
- stdio transport for Cursor/IDE integration.
