import { gate, runWorkflowGate } from './workflow-gate.js';
import { inferTaskTypes } from './infer-task-type.js';
import { installClaude, uninstallClaude } from './setup.js';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('inferTaskTypes', () => {
  it('returns empty array for unrelated text', () => {
    expect(inferTaskTypes('hello world')).toEqual([]);
  });

  it('infers multiple types for a cross-category request', () => {
    const types = inferTaskTypes('fix the API endpoint and update docs');
    expect(types).toContain('bug-fix');
    expect(types).toContain('public-api');
    expect(types).toContain('docs');
  });

  it('matches inflected forms - crashes, fixed, migration', () => {
    expect(inferTaskTypes('app crashes on startup')).toContain('bug-fix');
    expect(inferTaskTypes('this was already fixed')).toContain('bug-fix');
    expect(inferTaskTypes('write a migration for the users table')).toContain('migration');
  });

  it('is case-insensitive', () => {
    expect(inferTaskTypes('FIX the BUG in the API')).toContain('bug-fix');
  });

  it('does not match keywords mid-word', () => {
    expect(inferTaskTypes('renew the subscription')).not.toContain('feature');
  });
});

// ── runner output format ──────────────────────────────────────────────────────

import { Readable } from 'node:stream';
import { runHook } from './runner.js';

function withStdin(input: string, fn: () => Promise<void>): Promise<void> {
  const readable = Readable.from([Buffer.from(input)]);
  const originalStdin = process.stdin;
  Object.defineProperty(process, 'stdin', { value: readable, configurable: true });
  return fn().finally(() => {
    Object.defineProperty(process, 'stdin', { value: originalStdin, configurable: true });
  });
}

function captureStdout(fn: () => Promise<void>): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = '';
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: unknown) => { output += String(chunk); return true; };
    fn()
      .then(() => { process.stdout.write = originalWrite; resolve(output); })
      .catch(err => { process.stdout.write = originalWrite; reject(err as Error); });
  });
}

describe('runHook', () => {
  it('claude: emits correct shape with inferred types', async () => {
    let output = '';
    await withStdin(JSON.stringify({ prompt: 'add a new login page' }), async () => {
      output = await captureStdout(() => runHook('claude'));
    });
    const parsed = JSON.parse(output.trim()) as Record<string, unknown>;
    const hookOut = parsed['hookSpecificOutput'] as Record<string, unknown>;
    expect(parsed['continue']).toBe(true);
    expect(hookOut['hookEventName']).toBe('UserPromptSubmit');
    expect(hookOut['additionalContext'] as string).toContain('feature');
  });

  it('claude: emits fallback when no types match', async () => {
    let output = '';
    await withStdin(JSON.stringify({ prompt: 'hello' }), async () => {
      output = await captureStdout(() => runHook('claude'));
    });
    const hookOut = (JSON.parse(output.trim()) as Record<string, unknown>)['hookSpecificOutput'] as Record<string, unknown>;
    expect(hookOut['additionalContext'] as string).toContain('get_standards');
  });

  it('codex: uses UserPromptSubmit event and reads task_description', async () => {
    let output = '';
    await withStdin(JSON.stringify({ task_description: 'fix the broken signup flow' }), async () => {
      output = await captureStdout(() => runHook('codex'));
    });
    const hookOut = (JSON.parse(output.trim()) as Record<string, unknown>)['hookSpecificOutput'] as Record<string, unknown>;
    expect(hookOut['hookEventName']).toBe('UserPromptSubmit');
    expect(hookOut['additionalContext'] as string).toContain('bug-fix');
  });

  it('codex: falls back to raw string when stdin is not JSON', async () => {
    let output = '';
    await withStdin('refactor the payment module', async () => {
      output = await captureStdout(() => runHook('codex'));
    });
    const hookOut = (JSON.parse(output.trim()) as Record<string, unknown>)['hookSpecificOutput'] as Record<string, unknown>;
    expect(hookOut['additionalContext'] as string).toContain('refactor');
  });
});

// ── workflow-gate unit tests ──────────────────────────────────────────────────

function toolResponse(obj: unknown) {
  return { content: [{ type: 'text', text: JSON.stringify(obj) }] };
}

describe('gate', () => {
  it('returns a soft hint after get_standards naming list_workflow_skills', () => {
    const result = gate({ tool_name: 'get_standards' });
    expect(result).not.toBeNull();
    expect(result!.continue).toBe(true);
    expect(result!.hookSpecificOutput.hookEventName).toBe('PostToolUse');
    expect(result!.hookSpecificOutput.additionalContext).toContain('list_workflow_skills');
    expect(result!.hookSpecificOutput.additionalContext).toContain('specification');
    expect(result!.hookSpecificOutput.additionalContext).toContain('planning');
  });

  it('hints get_workflow_skill after list_workflow_skills for any stage', () => {
    for (const stage of ['specification', 'planning', 'review', undefined]) {
      const result = gate({ tool_name: 'list_workflow_skills', tool_input: stage ? { stage } : {} });
      expect(result!.continue).toBe(true);
      expect(result!.hookSpecificOutput.additionalContext).toContain('get_workflow_skill');
    }
  });

  it('hints review after list_workflow_skills for implementation stage', () => {
    const result = gate({ tool_name: 'list_workflow_skills', tool_input: { stage: 'implementation' } });
    expect(result!.continue).toBe(true);
    expect(result!.hookSpecificOutput.additionalContext).toContain('review');
  });

  it('hard-blocks after specification skill with planning as next call', () => {
    const result = gate({
      tool_name: 'get_workflow_skill',
      tool_response: toolResponse({ stages: ['specification'] }),
    });
    expect(result!.continue).toBe(false);
    expect(result!.hookSpecificOutput.additionalContext).toContain('SPECIFICATION GATE');
    expect(result!.hookSpecificOutput.additionalContext).toContain('planning');
  });

  it('hard-blocks after planning skill with implementation as next call', () => {
    const result = gate({
      tool_name: 'get_workflow_skill',
      tool_response: toolResponse({ stages: ['planning'] }),
    });
    expect(result!.continue).toBe(false);
    expect(result!.hookSpecificOutput.additionalContext).toContain('PLANNING GATE');
    expect(result!.hookSpecificOutput.additionalContext).toContain('DO NOT write any code');
    expect(result!.hookSpecificOutput.additionalContext).toContain('implementation');
  });

  it('hard-blocks after review skill before PR', () => {
    const result = gate({
      tool_name: 'get_workflow_skill',
      tool_response: toolResponse({ stages: ['review'] }),
    });
    expect(result!.continue).toBe(false);
    expect(result!.hookSpecificOutput.additionalContext).toContain('REVIEW GATE');
    expect(result!.hookSpecificOutput.additionalContext).toContain('PR');
  });

  it('returns null for implementation-only skills', () => {
    expect(gate({ tool_name: 'get_workflow_skill', tool_response: toolResponse({ stages: ['implementation'] }) })).toBeNull();
  });

  it('returns null for missing or invalid response', () => {
    expect(gate({ tool_name: 'get_workflow_skill' })).toBeNull();
    expect(gate({ tool_name: 'get_workflow_skill', tool_response: { content: [{ type: 'text', text: 'not-json' }] } })).toBeNull();
  });

  it('returns null for non-KumiQ tools', () => {
    expect(gate({ tool_name: 'Bash' })).toBeNull();
    expect(gate({})).toBeNull();
  });
});

describe('installClaude / uninstallClaude', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'kumiq-test-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('fresh install writes both UserPromptSubmit and PostToolUse hooks', async () => {
    await installClaude(root, () => {});
    const raw = await readFile(join(root, '.claude', 'settings.json'), 'utf8');
    const settings = JSON.parse(raw) as { hooks: Record<string, unknown> };
    const prompt = settings.hooks['UserPromptSubmit'] as Array<{ hooks: Array<{ command: string }> }>;
    const gate = settings.hooks['PostToolUse'] as Array<{ matcher: string; hooks: Array<{ command: string }> }>;
    expect(prompt).toHaveLength(1);
    expect(prompt[0].hooks[0].command).toContain('kumiq run --agent claude');
    expect(gate).toHaveLength(1);
    expect(gate[0].hooks[0].command).toContain('kumiq workflow-gate');
    expect(gate[0].matcher).toBe('get_standards|list_workflow_skills|get_workflow_skill');
  });

  it('re-running install is idempotent and logs already installed', async () => {
    const logs: string[] = [];
    await installClaude(root, msg => logs.push(msg));
    await installClaude(root, msg => logs.push(msg));
    expect(logs.some(m => m.includes('already installed'))).toBe(true);
    const raw = await readFile(join(root, '.claude', 'settings.json'), 'utf8');
    const settings = JSON.parse(raw) as { hooks: Record<string, unknown[]> };
    expect(settings.hooks['UserPromptSubmit']).toHaveLength(1);
    expect(settings.hooks['PostToolUse']).toHaveLength(1);
  });

  it('partial upgrade: only missing hook is added and logged individually', async () => {
    const settingsPath = join(root, '.claude', 'settings.json');
    await mkdir(join(root, '.claude'), { recursive: true });
    // Pre-install only the UserPromptSubmit hook (simulates old version)
    const existing = { hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: `npx --yes --package=@kumiq-app/hooks@0.1.3 kumiq run --agent claude` }] }] } };
    await writeFile(settingsPath, JSON.stringify(existing, null, 2) + '\n', 'utf8');

    const logs: string[] = [];
    await installClaude(root, msg => logs.push(msg));

    expect(logs.some(m => m.includes('PostToolUse workflow-gate hook added'))).toBe(true);
    expect(logs.every(m => !m.includes('UserPromptSubmit hook added'))).toBe(true);
    expect(logs.every(m => !m.includes('already installed'))).toBe(true);

    const settings = JSON.parse(await readFile(settingsPath, 'utf8')) as { hooks: Record<string, unknown[]> };
    expect(settings.hooks['UserPromptSubmit']).toHaveLength(1);
    expect(settings.hooks['PostToolUse']).toHaveLength(1);
  });

  it('uninstall removes KumiQ hooks and preserves foreign PostToolUse entries', async () => {
    const settingsPath = join(root, '.claude', 'settings.json');
    await mkdir(join(root, '.claude'), { recursive: true });
    const foreign = { matcher: 'SomeOtherTool', hooks: [{ type: 'command', command: 'foreign-hook' }] };
    await writeFile(settingsPath, JSON.stringify({ hooks: { PostToolUse: [foreign] } }, null, 2) + '\n', 'utf8');

    await installClaude(root, () => {});
    await uninstallClaude(root, () => {});

    const raw = await readFile(settingsPath, 'utf8');
    const settings = JSON.parse(raw) as { hooks: Record<string, unknown> };
    const remaining = settings.hooks['PostToolUse'] as Array<{ hooks: Array<{ command: string }> }>;
    expect(remaining).toHaveLength(1);
    expect(remaining[0].hooks[0].command).toBe('foreign-hook');
    expect(settings.hooks['UserPromptSubmit']).toBeUndefined();
  });
});

describe('runWorkflowGate', () => {
  it('writes gate output to stdout for a known tool', async () => {
    const event = { tool_name: 'get_standards' };
    let output = '';
    await withStdin(JSON.stringify(event), async () => {
      output = await captureStdout(() => runWorkflowGate());
    });
    const parsed = JSON.parse(output.trim()) as Record<string, unknown>;
    expect(parsed['continue']).toBe(true);
    const hookOut = parsed['hookSpecificOutput'] as Record<string, unknown>;
    expect(hookOut['hookEventName']).toBe('PostToolUse');
    expect(hookOut['additionalContext'] as string).toContain('list_workflow_skills');
  });

  it('writes nothing for non-KumiQ tools', async () => {
    let output = '';
    await withStdin(JSON.stringify({ tool_name: 'Read' }), async () => {
      output = await captureStdout(() => runWorkflowGate());
    });
    expect(output).toBe('');
  });

  it('exits cleanly on empty stdin', async () => {
    let output = '';
    await withStdin('', async () => {
      output = await captureStdout(() => runWorkflowGate());
    });
    expect(output).toBe('');
  });

  it('exits cleanly on non-JSON stdin', async () => {
    let output = '';
    await withStdin('not json', async () => {
      output = await captureStdout(() => runWorkflowGate());
    });
    expect(output).toBe('');
  });
});
