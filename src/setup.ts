import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

type Logger = (msg: string) => void;
type AgentTarget = 'claude' | 'codex' | 'copilot' | 'all';

const COPILOT_MARKER = '<!-- kumiq-instructions -->';
const CODEX_HOOK_NAME = 'kumiq-task-hint';

const COPILOT_BLOCK = `${COPILOT_MARKER}
## KumiQ Standards

Before starting any task, call the \`get_standards\` MCP tool with the inferred task_types.
Infer task_types from the request using these keywords:
- **feature**: add / new / implement / create / build / introduce
- **bug-fix**: fix / bug / broken / crash / incorrect / regression
- **refactor**: refactor / cleanup / restructure / simplify / rename
- **public-api**: API / endpoint / interface / contract / schema / export / CLI
- **config**: config / CI / CD / build / deployment / environment
- **migration**: migration / database / schema / backfill / alter
- **dependency**: dependency / package / upgrade / install / npm / yarn
- **docs**: docs / documentation / README / guide / changelog
- **architecture**: architecture / design / system / service / boundary

Use multiple types when the request spans categories. Call with no task_types when uncertain.
Follow returned standards and workflow guidance before writing any code.
<!-- /kumiq-instructions -->`;

function gitRoot(from: string): string {
  try {
    return execSync('git rev-parse --show-toplevel', {
      cwd: from, stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000,
    }).toString().trim();
  } catch {
    return from;
  }
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tmp = join(dirname(filePath), `.kumiq-tmp-${randomBytes(6).toString('hex')}`);
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, filePath);
}

async function readJSON(filePath: string): Promise<Record<string, unknown>> {
  if (!existsSync(filePath)) return {};
  const raw = await readFile(filePath, 'utf8');
  try { return JSON.parse(raw) as Record<string, unknown>; } catch {
    throw new Error(`Cannot parse ${filePath} - fix or remove it before running setup.`);
  }
}

// ── Claude Code ───────────────────────────────────────────────────────────────

async function installClaude(root: string, cliPath: string, log: Logger): Promise<void> {
  const path = join(root, '.claude', 'settings.json');
  const settings = await readJSON(path);
  const existing = (settings['hooks'] as Record<string, unknown> | undefined) ?? {};
  const entries = ((existing['UserPromptSubmit'] as unknown[]) ?? []) as Array<{ hooks?: Array<{ command?: string }> }>;
  const hookCmd = `node ${cliPath} run --agent claude`;
  const already = entries.some(m => (m.hooks ?? []).some(h => h.command?.includes('run --agent claude')));
  if (already) { log('Claude Code: already installed.'); return; }

  const updated = {
    ...settings,
    hooks: { ...existing, UserPromptSubmit: [...entries, { hooks: [{ type: 'command', command: hookCmd }] }] },
  };
  await atomicWrite(path, JSON.stringify(updated, null, 2) + '\n');
  log(`Claude Code: hook added to .claude/settings.json`);
}

async function uninstallClaude(root: string, log: Logger): Promise<void> {
  const path = join(root, '.claude', 'settings.json');
  if (!existsSync(path)) { log('Claude Code: not installed.'); return; }
  const settings = await readJSON(path);
  const existing = (settings['hooks'] as Record<string, unknown> | undefined) ?? {};
  const entries = ((existing['UserPromptSubmit'] as unknown[]) ?? []) as Array<{ hooks?: Array<{ command?: string }> }>;
  const filtered = entries
    .map(m => ({ ...m, hooks: (m.hooks ?? []).filter(h => !h.command?.includes('run --agent claude')) }))
    .filter(m => (m.hooks ?? []).length > 0);
  const updatedHooks: Record<string, unknown> = { ...existing };
  if (filtered.length) updatedHooks['UserPromptSubmit'] = filtered;
  else delete updatedHooks['UserPromptSubmit'];
  await atomicWrite(path, JSON.stringify({ ...settings, hooks: updatedHooks }, null, 2) + '\n');
  log('Claude Code: hook removed.');
}

// ── Codex ─────────────────────────────────────────────────────────────────────

async function installCodex(root: string, cliPath: string, log: Logger): Promise<void> {
  const path = join(root, '.codex', 'hooks.json');
  const file = await readJSON(path);
  const hooks = ((file['hooks'] as unknown[]) ?? []) as Array<{ name?: string; command?: string }>;
  if (hooks.some(h => h.name === CODEX_HOOK_NAME)) { log('Codex: already installed.'); return; }

  const hookCmd = `node ${cliPath} run --agent codex`;
  const updated = {
    ...file,
    version: file['version'] ?? '1',
    hooks: [...hooks, { name: CODEX_HOOK_NAME, event: 'startup', command: hookCmd }],
  };
  await atomicWrite(path, JSON.stringify(updated, null, 2) + '\n');
  log('Codex: hook added to .codex/hooks.json');
  log('Codex: open .codex/hooks.json in Codex and follow the trust prompt to activate it.');
}

async function uninstallCodex(root: string, log: Logger): Promise<void> {
  const path = join(root, '.codex', 'hooks.json');
  if (!existsSync(path)) { log('Codex: not installed.'); return; }
  const file = await readJSON(path);
  const hooks = ((file['hooks'] as unknown[]) ?? []) as Array<{ name?: string; command?: string }>;
  const filtered = hooks.filter(h => h.name !== CODEX_HOOK_NAME && !h.command?.includes('run --agent codex'));
  await atomicWrite(path, JSON.stringify({ ...file, hooks: filtered }, null, 2) + '\n');
  log('Codex: hook removed.');
}

// ── GitHub Copilot ────────────────────────────────────────────────────────────

async function installCopilot(root: string, log: Logger): Promise<void> {
  const path = join(root, '.github', 'copilot-instructions.md');
  const existing = existsSync(path) ? await readFile(path, 'utf8') : '';
  if (existing.includes(COPILOT_MARKER)) { log('Copilot: already installed.'); return; }

  const content = existing.trimEnd()
    ? existing.trimEnd() + '\n\n' + COPILOT_BLOCK + '\n'
    : COPILOT_BLOCK + '\n';
  await atomicWrite(path, content);
  log('Copilot: instructions added to .github/copilot-instructions.md');
}

async function uninstallCopilot(root: string, log: Logger): Promise<void> {
  const path = join(root, '.github', 'copilot-instructions.md');
  if (!existsSync(path)) { log('Copilot: not installed.'); return; }
  const existing = await readFile(path, 'utf8');
  const cleaned = existing
    .replace(/\n*<!-- kumiq-instructions -->[\s\S]*?<!-- \/kumiq-instructions -->\n*/g, '\n')
    .trimEnd();
  await atomicWrite(path, cleaned ? cleaned + '\n' : '');
  log('Copilot: instructions removed.');
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function install(agentTarget: string, log: Logger, cliPath: string): Promise<void> {
  const root = gitRoot(process.cwd());
  const agents: AgentTarget[] = (agentTarget === 'all' || !agentTarget)
    ? ['claude', 'codex', 'copilot']
    : [agentTarget as AgentTarget];

  for (const agent of agents) {
    if (agent === 'claude')  await installClaude(root, cliPath, log);
    if (agent === 'codex')   await installCodex(root, cliPath, log);
    if (agent === 'copilot') await installCopilot(root, log);
  }
}

export async function uninstall(agentTarget: string, log: Logger): Promise<void> {
  const root = gitRoot(process.cwd());
  const agents: AgentTarget[] = (agentTarget === 'all' || !agentTarget)
    ? ['claude', 'codex', 'copilot']
    : [agentTarget as AgentTarget];

  for (const agent of agents) {
    if (agent === 'claude')  await uninstallClaude(root, log);
    if (agent === 'codex')   await uninstallCodex(root, log);
    if (agent === 'copilot') await uninstallCopilot(root, log);
  }
}
