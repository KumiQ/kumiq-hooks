export type TaskType =
  | 'feature'
  | 'bug-fix'
  | 'refactor'
  | 'public-api'
  | 'config'
  | 'migration'
  | 'dependency'
  | 'docs'
  | 'architecture';

const KEYWORDS: Record<TaskType, RegExp> = {
  feature:        /\b(add|new|implement|create|build|feature|introduc|support|enabl)/i,
  'bug-fix':      /\b(fix|bug|broken|crash|incorrect|regression|fail|wrong|error|not working)/i,
  refactor:       /\b(refactor|cleanup|clean up|restructur|reorganiz|simplif|renam|extract|mov)/i,
  'public-api':   /\b(api|endpoint|interface|contract|schema|export|library|cli|event|type)/i,
  config:         /\b(config|ci|cd|pipeline|deploy|build|environment|docker|settings)/i,
  migration:      /\b(migrat|database|backfill|alter|column)/i,
  dependency:     /\b(depend|package|upgrade|install|npm|yarn|pnpm|version)/i,
  docs:           /\b(docs|documentation|readme|guide|comment|tutorial|changelog)/i,
  architecture:   /\b(architect|design|system|service|boundary|pattern|structure)/i,
};

export function inferTaskTypes(text: string): TaskType[] {
  return (Object.keys(KEYWORDS) as TaskType[]).filter(t => KEYWORDS[t].test(text));
}
