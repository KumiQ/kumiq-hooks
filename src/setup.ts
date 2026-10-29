import { readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

type Logger = (msg: string) => void;
type AgentTarget = 'claude' | 'codex' | 'copilot' | 'all';

const COPILOT_MARKER = '<!-- kumiq-instructions -->';
const PACKAGE_VERSION = '0.1.3';
const STATE_FILE = '.kumiq-hooks-state.json';

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

const KUMIQ_MCP_SERVER = {
  url: 'https://mcp-dzv7.onrender.com/mcp',
  type: 'http',
} as const;

async function readState(root: string): Promise<Record<string, unknown>> {
  return readJSON(join(root, STATE_FILE));
}

async function updateState(root: string, key: string, value: boolean): Promise<void> {
  const state = await readState(root);
  if (value) state[key] = true;
  else delete state[key];
  if (Object.keys(state).length) await atomicWrite(join(root, STATE_FILE), JSON.stringify(state, null, 2) + '\n');
  else if (existsSync(join(root, STATE_FILE))) await unlink(join(root, STATE_FILE));
}

function hookCommand(agent: 'claude' | 'codex'): string {
  return `npx --yes --package=@kumiq-app/hooks@${PACKAGE_VERSION} kumiq run --agent ${agent}`;
}

function workflowGateCommand(): string {
  return `npx --yes --package=@kumiq-app/hooks@${PACKAGE_VERSION} kumiq workflow-gate`;
}

function isManagedHookCommand(command: string | undefined, agent: 'claude' | 'codex'): boolean {
  if (!command) return false;
  return command.includes('@kumiq-app/hooks@') ||
    (command.includes('node ') && command.includes('dist/cli.js') && command.includes(`run --agent ${agent}`));
}

function isManagedWorkflowGateCommand(command: string | undefined): boolean {
  if (!command) return false;
  return command.includes('kumiq workflow-gate') ||
    (command.includes('node ') && command.includes('dist/cli.js') && command.includes('workflow-gate'));
}

const WORKFLOW_GATE_MATCHER = 'get_standards|list_workflow_skills|get_workflow_skill';

// ── Claude Code ───────────────────────────────────────────────────────────────

async function installClaudeMcp(root: string, log: Logger): Promise<void> {
  const path = join(root, '.claude', 'mcp.json');
  const file = await readJSON(path);
  const servers = (file['mcpServers'] as Record<string, unknown> | undefined) ?? {};
  if (servers['KumiQ']) { log('Claude Code MCP: already configured.'); return; }
  await atomicWrite(path, JSON.stringify({ ...file, mcpServers: { ...servers, KumiQ: KUMIQ_MCP_SERVER } }, null, 2) + '\n');
  await updateState(root, 'claudeMcpCreated', true);
  log('Claude Code MCP: KumiQ server added to .claude/mcp.json');
}

async function uninstallClaudeMcp(root: string, log: Logger): Promise<void> {
  const path = join(root, '.claude', 'mcp.json');
  if (!existsSync(path)) return;
  const file = await readJSON(path);
  const servers: Record<string, unknown> = { ...(file['mcpServers'] as Record<string, unknown> | undefined) };
  const state = await readState(root);
  if (!state['claudeMcpCreated'] || JSON.stringify(servers['KumiQ']) !== JSON.stringify(KUMIQ_MCP_SERVER)) return;
  delete servers['KumiQ'];
  await atomicWrite(path, JSON.stringify({ ...file, mcpServers: servers }, null, 2) + '\n');
  log('Claude Code MCP: KumiQ server removed.');
  await updateState(root, 'claudeMcpCreated', false);
}

export async function installClaude(root: string, log: Logger): Promise<void> {
  const path = join(root, '.claude', 'settings.json');
  const settings = await readJSON(path);
  const existing = (settings['hooks'] as Record<string, unknown> | undefined) ?? {};

  const promptEntries = ((existing['UserPromptSubmit'] as unknown[]) ?? []) as Array<{ hooks?: Array<{ command?: string }> }>;
  const promptAlready = promptEntries.some(m => (m.hooks ?? []).some(h => isManagedHookCommand(h.command, 'claude')));

  const gateEntries = ((existing['PostToolUse'] as unknown[]) ?? []) as Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>;
  const gateAlready = gateEntries.some(m => (m.hooks ?? []).some(h => isManagedWorkflowGateCommand(h.command)));

  if (promptAlready && gateAlready) { log('Claude Code: already installed.'); }
  else {
    const updatedPrompt = promptAlready
      ? promptEntries
      : [...promptEntries, { hooks: [{ type: 'command', command: hookCommand('claude') }] }];
    const updatedGate = gateAlready
      ? gateEntries
      : [...gateEntries, { matcher: WORKFLOW_GATE_MATCHER, hooks: [{ type: 'command', command: workflowGateCommand() }] }];
    await atomicWrite(path, JSON.stringify({
      ...settings,
      hooks: { ...existing, UserPromptSubmit: updatedPrompt, PostToolUse: updatedGate },
    }, null, 2) + '\n');
    log('Claude Code: hooks added to .claude/settings.json');
  }
  await installClaudeMcp(root, log);
}

export async function uninstallClaude(root: string, log: Logger): Promise<void> {
  const path = join(root, '.claude', 'settings.json');
  if (existsSync(path)) {
    const settings = await readJSON(path);
    const existing = (settings['hooks'] as Record<string, unknown> | undefined) ?? {};

    const promptEntries = ((existing['UserPromptSubmit'] as unknown[]) ?? []) as Array<{ hooks?: Array<{ command?: string }> }>;
    const filteredPrompt = promptEntries
      .map(m => ({ ...m, hooks: (m.hooks ?? []).filter(h => !isManagedHookCommand(h.command, 'claude')) }))
      .filter(m => (m.hooks ?? []).length > 0);

    const gateEntries = ((existing['PostToolUse'] as unknown[]) ?? []) as Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>;
    const filteredGate = gateEntries
      .map(m => ({ ...m, hooks: (m.hooks ?? []).filter(h => !isManagedWorkflowGateCommand(h.command)) }))
      .filter(m => (m.hooks ?? []).length > 0);

    const updatedHooks: Record<string, unknown> = { ...existing };
    if (filteredPrompt.length) updatedHooks['UserPromptSubmit'] = filteredPrompt;
    else delete updatedHooks['UserPromptSubmit'];
    if (filteredGate.length) updatedHooks['PostToolUse'] = filteredGate;
    else delete updatedHooks['PostToolUse'];

    await atomicWrite(path, JSON.stringify({ ...settings, hooks: updatedHooks }, null, 2) + '\n');
    log('Claude Code: hooks removed.');
  } else {
    log('Claude Code: not installed.');
  }
  await uninstallClaudeMcp(root, log);
}

// ── Codex ─────────────────────────────────────────────────────────────────────

async function installCodex(root: string, log: Logger): Promise<void> {
  const path = join(root, '.codex', 'hooks.json');
  const file = await readJSON(path);
  const hooks = (file['hooks'] as Record<string, unknown> | undefined) ?? {};
  const entries = (hooks['UserPromptSubmit'] as Array<{ hooks?: Array<{ command?: string; type?: string }> }> | undefined) ?? [];
  if (entries.some(m => (m.hooks ?? []).some(h => isManagedHookCommand(h.command, 'codex')))) { log('Codex: already installed.'); return; }

  const hookCmd = hookCommand('codex');
  const updated = { ...file, hooks: { ...hooks, UserPromptSubmit: [...entries, { hooks: [{ type: 'command', command: hookCmd }] }] } };
  await atomicWrite(path, JSON.stringify(updated, null, 2) + '\n');
  log('Codex: hook added to .codex/hooks.json');
  log('Codex: review and trust the project hook in Codex before it runs.');
}

async function uninstallCodex(root: string, log: Logger): Promise<void> {
  const path = join(root, '.codex', 'hooks.json');
  if (!existsSync(path)) { log('Codex: not installed.'); return; }
  const file = await readJSON(path);
  const hooks = (file['hooks'] as Record<string, unknown> | undefined) ?? {};
  const entries = (hooks['UserPromptSubmit'] as Array<{ hooks?: Array<{ command?: string; name?: string }> }> | undefined) ?? [];
  const filtered = entries.map(m => ({ ...m, hooks: (m.hooks ?? []).filter(h => !isManagedHookCommand(h.command, 'codex')) })).filter(m => (m.hooks ?? []).length);
  const updatedHooks: Record<string, unknown> = { ...hooks };
  if (filtered.length) updatedHooks['UserPromptSubmit'] = filtered;
  else delete updatedHooks['UserPromptSubmit'];
  await atomicWrite(path, JSON.stringify({ ...file, hooks: updatedHooks }, null, 2) + '\n');
  log('Codex: hook removed.');
}

// ── GitHub Copilot ────────────────────────────────────────────────────────────

async function installCopilotMcp(root: string, log: Logger): Promise<void> {
  const path = join(root, '.vscode', 'settings.json');
  const file = await readJSON(path);
  const mcp = (file['mcp'] as Record<string, unknown> | undefined) ?? {};
  const servers = (mcp['servers'] as Record<string, unknown> | undefined) ?? {};
  if (servers['KumiQ']) { log('Copilot MCP: already configured.'); return; }
  const updated = { ...file, mcp: { ...mcp, servers: { ...servers, KumiQ: KUMIQ_MCP_SERVER } } };
  await atomicWrite(path, JSON.stringify(updated, null, 2) + '\n');
  await updateState(root, 'copilotMcpCreated', true);
  log('Copilot MCP: KumiQ server added to .vscode/settings.json');
}

async function uninstallCopilotMcp(root: string, log: Logger): Promise<void> {
  const path = join(root, '.vscode', 'settings.json');
  if (!existsSync(path)) return;
  const file = await readJSON(path);
  const mcp = (file['mcp'] as Record<string, unknown> | undefined) ?? {};
  const servers: Record<string, unknown> = { ...(mcp['servers'] as Record<string, unknown> | undefined) };
  const state = await readState(root);
  if (!state['copilotMcpCreated'] || JSON.stringify(servers['KumiQ']) !== JSON.stringify(KUMIQ_MCP_SERVER)) return;
  delete servers['KumiQ'];
  await atomicWrite(path, JSON.stringify({ ...file, mcp: { ...mcp, servers } }, null, 2) + '\n');
  log('Copilot MCP: KumiQ server removed.');
  await updateState(root, 'copilotMcpCreated', false);
}

async function installCopilot(root: string, log: Logger): Promise<void> {
  const path = join(root, '.github', 'copilot-instructions.md');
  const existing = existsSync(path) ? await readFile(path, 'utf8') : '';
  if (existing.includes(COPILOT_MARKER)) { log('Copilot: already installed.'); }
  else {
    const content = existing.trimEnd()
      ? existing.trimEnd() + '\n\n' + COPILOT_BLOCK + '\n'
      : COPILOT_BLOCK + '\n';
    await atomicWrite(path, content);
    log('Copilot: instructions added to .github/copilot-instructions.md');
  }
  await installCopilotMcp(root, log);
}

async function uninstallCopilot(root: string, log: Logger): Promise<void> {
  const path = join(root, '.github', 'copilot-instructions.md');
  if (existsSync(path)) {
    const existing = await readFile(path, 'utf8');
    const cleaned = existing
      .replace(/\n*<!-- kumiq-instructions -->[\s\S]*?<!-- \/kumiq-instructions -->\n*/g, '\n')
      .trimEnd();
    await atomicWrite(path, cleaned ? cleaned + '\n' : '');
    log('Copilot: instructions removed.');
  } else {
    log('Copilot: not installed.');
  }
  await uninstallCopilotMcp(root, log);
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function install(agentTarget: string, log: Logger): Promise<void> {
  const root = gitRoot(process.cwd());
  const agents: AgentTarget[] = (agentTarget === 'all' || !agentTarget)
    ? ['claude', 'codex', 'copilot']
    : [agentTarget as AgentTarget];

  for (const agent of agents) {
    if (agent === 'claude')  await installClaude(root, log);
    if (agent === 'codex')   await installCodex(root, log);
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
