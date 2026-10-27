import { inferTaskTypes } from './infer-task-type.js';

export type HookAgent = 'claude' | 'codex';

async function readStdin(): Promise<string> {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk as string;
  return raw;
}

function extractText(raw: string, agent: HookAgent): string {
  try {
    const input = JSON.parse(raw) as Record<string, unknown>;
    if (agent === 'claude') return String(input['prompt'] ?? '');
    return String(input['task_description'] ?? input['task'] ?? input['prompt'] ?? '');
  } catch {
    return agent === 'codex' ? raw.trim() : '';
  }
}

function buildContext(text: string): string {
  const types = inferTaskTypes(text);
  if (types.length > 0) {
    return (
      `[kumiq-hint] Inferred task type(s): ${types.join(', ')}. ` +
      `Call get_standards with task_types=[${types.map(t => `"${t}"`).join(', ')}] before starting work.`
    );
  }
  return '[kumiq-hint] Call get_standards before starting work to load applicable standards.';
}

export async function runHook(agent: HookAgent): Promise<void> {
  const raw = await readStdin();
  const text = extractText(raw, agent);
  const hookEventName = agent === 'claude' ? 'UserPromptSubmit' : 'startup';
  const additionalContext = buildContext(text);
  process.stdout.write(
    JSON.stringify({ continue: true, hookSpecificOutput: { hookEventName, additionalContext } }) + '\n',
  );
}
