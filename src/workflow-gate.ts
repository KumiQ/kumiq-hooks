// PostToolUse hook: blocks at workflow stage transitions and names the exact next required call.

type Stage = 'specification' | 'planning' | 'implementation' | 'review';

interface PostToolUseEvent {
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: {
    content?: { type: string; text?: string }[];
  };
}

interface HookOutput {
  continue: boolean;
  hookSpecificOutput: {
    hookEventName: 'PostToolUse';
    additionalContext: string;
  };
}

function parseResponseStages(event: PostToolUseEvent): Stage[] {
  try {
    const text = event.tool_response?.content?.[0]?.text;
    if (!text) return [];
    const parsed = JSON.parse(text) as { stages?: unknown };
    if (!Array.isArray(parsed.stages)) return [];
    return parsed.stages.filter(
      (s): s is Stage =>
        s === 'specification' ||
        s === 'planning' ||
        s === 'implementation' ||
        s === 'review',
    );
  } catch {
    return [];
  }
}

function buildOutput(shouldBlock: boolean, context: string): HookOutput {
  return {
    continue: !shouldBlock,
    hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: context },
  };
}

export function gate(event: PostToolUseEvent): HookOutput | null {
  const tool = event.tool_name;
  const input = event.tool_input ?? {};

  if (tool === 'get_standards') {
    return buildOutput(false, [
      '[kumiq-workflow-gate] Standards loaded.',
      '',
      'REQUIRED NEXT CALL: list_workflow_skills',
      '  { stage: "specification" }  — if requirements or acceptance criteria are unclear',
      '  { stage: "planning" }       — if requirements are already agreed with the user',
      '',
      'Do not begin planning or implementation without completing the appropriate stage first.',
    ].join('\n'));
  }

  if (tool === 'list_workflow_skills') {
    const stage = input['stage'] as string | undefined;

    if (stage === 'implementation') {
      return buildOutput(false, [
        '[kumiq-workflow-gate] Implementation stage.',
        '',
        'Proceed with implementation per the approved plan.',
        '',
        'REQUIRED NEXT CALL when implementation is complete:',
        '  list_workflow_skills { stage: "review" }',
      ].join('\n'));
    }

    const label = stage ? `${stage} ` : '';
    return buildOutput(false, [
      `[kumiq-workflow-gate] ${label}skills discovered.`,
      '',
      'REQUIRED NEXT CALL: get_workflow_skill',
      '  { skill_id: "<chosen_skill_id>", revision: "<revision_from_above>" }',
    ].join('\n'));
  }

  if (tool === 'get_workflow_skill') {
    const stages = parseResponseStages(event);

    if (stages.includes('specification')) {
      return buildOutput(true, [
        '[kumiq-workflow-gate] SPECIFICATION GATE',
        '',
        'Present the requirements and acceptance criteria to the user now.',
        'Wait for explicit user confirmation before proceeding.',
        '',
        'REQUIRED NEXT CALL after user confirmation:',
        '  list_workflow_skills { stage: "planning" }',
      ].join('\n'));
    }

    if (stages.includes('planning')) {
      return buildOutput(true, [
        '[kumiq-workflow-gate] PLANNING GATE',
        '',
        'Present your complete implementation plan to the user now.',
        'DO NOT write any code until the user explicitly approves the plan.',
        '',
        'REQUIRED NEXT CALL after user approval:',
        '  list_workflow_skills { stage: "implementation" }',
      ].join('\n'));
    }

    if (stages.includes('review')) {
      return buildOutput(true, [
        '[kumiq-workflow-gate] REVIEW GATE',
        '',
        'Execute the review per the retrieved skill checklist now.',
        'Do not suggest committing, pushing, or opening a PR until the review is complete.',
      ].join('\n'));
    }

    return null;
  }

  return null;
}

async function readStdin(): Promise<string> {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk as string;
  return raw;
}

export async function runWorkflowGate(): Promise<void> {
  const raw = await readStdin();
  if (!raw.trim()) return;

  let event: PostToolUseEvent = {};
  try {
    event = JSON.parse(raw) as PostToolUseEvent;
  } catch {
    return;
  }

  const result = gate(event);
  if (result) process.stdout.write(JSON.stringify(result) + '\n');
}
