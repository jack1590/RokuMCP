# Codex CLI / OpenCode / Aider / generic AGENTS.md

These agents auto-discover an `AGENTS.md` file walking up from the current working directory. The canonical copy for this project lives at the **repo root**: [`../../AGENTS.md`](../../AGENTS.md).

## How to use it in your own project

Pick one of:

```bash
# Drop into the root of any Roku project that uses roku-mcp:
curl -fsSL https://raw.githubusercontent.com/<your-org>/roku-mcp/master/AGENTS.md -o AGENTS.md

# Or copy from a clone of this repo:
cp /path/to/roku-mcp/AGENTS.md ./AGENTS.md
```

Then start a fresh agent session — Codex CLI / OpenCode / Aider will load it automatically.

## Why no file here

Keeping a duplicate in `rules/codex-opencode/` would just drift out of sync with the root one. The repo root is exactly where Codex/OpenCode look first, so the file already lives in the right place.
