import { inferTaskTypes } from './infer-task-type.js';

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

  it('codex: uses startup event and reads task_description', async () => {
    let output = '';
    await withStdin(JSON.stringify({ task_description: 'fix the broken signup flow' }), async () => {
      output = await captureStdout(() => runHook('codex'));
    });
    const hookOut = (JSON.parse(output.trim()) as Record<string, unknown>)['hookSpecificOutput'] as Record<string, unknown>;
    expect(hookOut['hookEventName']).toBe('startup');
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
