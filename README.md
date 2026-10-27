# KumiQ

KumiQ reminder hooks encourage Claude Code, Codex, and GitHub Copilot to call KumiQ before a task. They are experimental guidance and do not enforce standards or guarantee retrieval.

## Setup

Run once from the root of any repository:

```bash
npx --yes @kumiq-app/hooks@0.1.2 install
```

This installs hooks for all three agents. To target a specific one:

```bash
npx @kumiq-app/hooks install --agent claude
npx @kumiq-app/hooks install --agent codex
npx @kumiq-app/hooks install --agent copilot
```

Generated hook commands use the pinned package version, so they do not refer to the installing developer's npm cache or checkout. Commit generated config and `.kumiq-hooks-state.json` together when that state file exists; it records MCP entries created by the installer so uninstall preserves pre-existing entries. A teammate needs Node.js and network access the first time the hook runs.

To remove:

```bash
npx --yes @kumiq-app/hooks@0.1.2 uninstall
```

The setup is idempotent - running it again on an already-configured repo prints "already installed" and exits cleanly.

## How it works

| Agent | Mechanism | Trigger |
|---|---|---|
| Claude Code | `UserPromptSubmit` hook in `.claude/settings.json` + MCP server in `.claude/mcp.json` | Before every prompt |
| Codex | `UserPromptSubmit` hook in `.codex/hooks.json` | Before each prompt |
| GitHub Copilot | Block appended to `.github/copilot-instructions.md` | Every chat request |

For Claude Code, the install also writes `.claude/mcp.json` with the KumiQ MCP server so the `get_standards` tool is available without any manual configuration.

Each hook infers KumiQ task types from the prompt text and injects an instruction to call `get_standards` with those types before starting work.

## Task type inference

| task_type | Keywords |
|---|---|
| feature | add, new, implement, create, build |
| bug-fix | fix, bug, broken, crash, regression |
| refactor | refactor, cleanup, restructure, rename |
| public-api | API, endpoint, interface, contract, schema |
| config | config, CI, CD, deployment, environment |
| migration | migration, database, backfill, alter |
| dependency | dependency, package, upgrade, install, npm |
| docs | docs, documentation, README, guide |
| architecture | architecture, design, system, service |

Multiple types are inferred when a request spans categories.

## Requirements

- Node.js 18+
- Claude Code, Codex, or GitHub Copilot

No manual MCP configuration needed - the install command sets it up automatically for Claude Code.

## License

MIT - see [LICENSE](LICENSE)
