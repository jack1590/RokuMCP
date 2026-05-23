# Agent rules

Drop-in rules / system prompts that teach AI coding agents how to use the `roku-mcp` tools correctly. Each agent ecosystem expects a slightly different file format (extension, frontmatter, install path), so the rules are organized per agent.

The **content is identical** across all variants — the canonical text in [`cursor/roku-mcp.mdc`](./cursor/roku-mcp.mdc). Only the wrapper (frontmatter or header) differs to match what each agent auto-loads.

## Pick your agent

| Agent | File | Install path |
|---|---|---|
| **Cursor** | [`cursor/roku-mcp.mdc`](./cursor/roku-mcp.mdc) | `.cursor/rules/roku-mcp.mdc` (project) or `~/.cursor/rules/roku-mcp.mdc` (user) |
| **Claude Code** | [`claude-code/CLAUDE.md`](./claude-code/CLAUDE.md) | `CLAUDE.md` at repo root (or `.claude/CLAUDE.md`) |
| **Claude Desktop** | [`claude-desktop/roku-mcp.md`](./claude-desktop/roku-mcp.md) | Paste into Settings → System Prompt (no auto-load) |
| **Windsurf** | [`windsurf/roku-mcp.md`](./windsurf/roku-mcp.md) | `.windsurf/rules/roku-mcp.md` (project) |
| **Codex CLI / OpenCode / Aider** | [`../AGENTS.md`](../AGENTS.md) (root) | `AGENTS.md` at the repo root of the target project |

## Install commands

### Cursor — project scope (recommended for teams)

```bash
mkdir -p .cursor/rules
cp rules/cursor/roku-mcp.mdc .cursor/rules/roku-mcp.mdc
```

Reload the window. Cursor picks it up automatically (`alwaysApply: true` in the frontmatter).

### Cursor — user scope (applies to every project on this machine)

```bash
mkdir -p ~/.cursor/rules
cp rules/cursor/roku-mcp.mdc ~/.cursor/rules/roku-mcp.mdc
```

### Claude Code

```bash
cp rules/claude-code/CLAUDE.md ./CLAUDE.md
```

Claude Code auto-loads `CLAUDE.md` from the current working directory at session start. If you already have a project `CLAUDE.md`, append the body instead of overwriting.

### Claude Desktop

There's no on-disk auto-load for Claude Desktop. Open **Settings → Profile** (or your custom-instruction surface) and paste the body of [`claude-desktop/roku-mcp.md`](./claude-desktop/roku-mcp.md) starting from the `# roku-mcp Usage` heading.

### Windsurf

```bash
mkdir -p .windsurf/rules
cp rules/windsurf/roku-mcp.md .windsurf/rules/roku-mcp.md
```

Reload Cascade. The `trigger: always_on` frontmatter activates the rule on every turn.

### Codex CLI / OpenCode / Aider / any AGENTS.md-aware agent

The canonical [`AGENTS.md`](../AGENTS.md) already lives at the repo root, which is exactly where these agents look. To use it in *another* Roku project:

```bash
cp /path/to/roku-mcp/AGENTS.md ./AGENTS.md
```

## Keeping variants in sync

The body is the same text in each file; only the wrapper changes (Cursor YAML frontmatter with `alwaysApply: true`, Windsurf YAML frontmatter with `trigger: always_on`, Claude Code/Desktop plain Markdown, AGENTS.md plain Markdown). When the canonical guidance changes, update [`cursor/roku-mcp.mdc`](./cursor/roku-mcp.mdc) first and propagate the body to the others.
