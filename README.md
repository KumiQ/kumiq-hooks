# KumiQ

KumiQ agent hooks - guide Claude Code, Codex, and GitHub Copilot to call `get_standards` before every task, so the right standards are loaded before the model begins work.

## Setup

Run once from the root of any repository:

```bash
npx @kumiq-app/hooks install
```

This installs hooks for all three agents. To target a specific one:

```bash
npx @kumiq-app/hooks install --agent claude
npx @kumiq-app/hooks install --agent codex
npx @kumiq-app/hooks install --agent copilot
```

Commit the generated config files so every teammate gets the hooks automatically.

To remove:

```bash
npx @kumiq-app/hooks uninstall
```

The setup is idempotent - running it again on an already-configured repo prints "already installed" and exits cleanly.

## How it works

| Agent | Mechanism | Trigger |
|---|---|---|
| Claude Code | `UserPromptSubmit` hook in `.claude/settings.json` | Before every prompt |
| Codex | `startup` hook in `.codex/hooks.json` | At task start |
| GitHub Copilot | Block appended to `.github/copilot-instructions.md` | Every chat request |

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
- A KumiQ MCP server configured in your agent

## License

MIT - see [LICENSE](LICENSE)
