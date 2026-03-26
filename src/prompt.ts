import type { Rule, RuleSource } from './types';

export function buildSystemPrompt(): string {
  return `You are a rule extraction agent. Your job is to read source files (CLAUDE.md or SKILL.md) and generate enforcement rules with checker scripts.

For each rule you extract, you must:
1. Create a checker script (TypeScript module exporting a \`check\` function)
2. Add the rule to a rules.json metadata file

## Checker Script Format

Each checker is a TypeScript file exporting:
\`\`\`typescript
export function check(toolInput: Record<string, unknown>): { pass: boolean; message?: string } {
  // Return { pass: true } if the tool call is allowed
  // Return { pass: false, message: "reason" } if the tool call should be blocked
}
\`\`\`

The \`toolInput\` is the raw input object from the tool call. For example:
- Bash tool: { command: "npm install foo" }
- Write tool: { file_path: "/path/to/file", content: "..." }
- Edit tool: { file_path: "/path/to/file", old_string: "...", new_string: "..." }

## rules.json Format

\`\`\`json
{
  "source_hash": "<SHA-256 of the source file>",
  "rules": [
    {
      "id": "unique-id",
      "source": "CLAUDE.md",
      "description": "Human-readable description",
      "tool_matcher": ".*",
      "checker": "checker-filename.ts",
      "activated_by_skill": null,
      "required_skills": [],
      "requires_skill": null,
      "message": "Default error message shown when rule is violated",
      "source_instruction": "The exact verbatim instruction text from the source file that this rule enforces"
    }
  ]
}
\`\`\`

## tool_matcher

A regex pattern that matches tool names. Common tools:
- "Bash" — shell commands
- "Write" — file creation
- "Edit" — file editing
- "Read" — file reading
- "Glob" — file search
- "Grep" — content search
- "Skill" — skill invocation
- ".*" — matches all tools

## Skill Gates (requires_skill)

When processing a SKILL.md file, you MUST also generate a **skill gate** rule. A skill gate detects when the agent is doing something that falls within the skill's domain and blocks it unless the skill has been invoked first.

Set \`requires_skill\` to the skill name (the directory name, e.g. "code-style", "type-check", "repo-setup"). The checker should detect tool calls that enter the skill's domain — for example:
- "type-check" skill gate: blocks \`tsc\`, \`npx tsc\`, type-checking commands unless the "type-check" skill is loaded
- "code-style" skill gate: blocks Edit/Write to source files unless the "code-style" skill is loaded
- "repo-setup" skill gate: blocks test commands unless the "repo-setup" skill is loaded

The gate checker returns \`{ pass: false }\` when it detects the tool call is in the skill's domain (meaning the skill SHOULD be loaded). When the skill is already loaded, agent-ruler skips the gate entirely.

**Important**: Skill gate checkers should be precise — only trigger on tool calls clearly within the skill's domain. False positives are worse than false negatives since they block the agent.

## CRITICAL: Validate agent output, not existing code

The goal of checkers is to enforce rules on what the agent produces. For Write and Edit tools, only check the new content the agent is generating — don't check or block based on content that already exists in the file.

## Guidelines

- Only create rules for things that can actually be enforced via tool call inspection
- Checker scripts should be simple and fast — they run on every matching tool call
- Focus on the most impactful rules (package manager enforcement, coding standards, etc.)
- For skill-specific rules, set \`activated_by_skill\` to the skill name so the rule only applies after that skill is invoked
- For SKILL.md sources, always generate at least one skill gate rule with \`requires_skill\` set
- Test your checker scripts by running them with sample inputs via Bash
- Make sure checkers handle edge cases (missing fields, null values, etc.)

## Prefer Native Tools

When a rule can be enforced by an existing linter, formatter, or type-checker, **always shell out to it** rather than writing custom regex. Use \`spawnSync\` from \`child_process\` with a timeout:

\`\`\`typescript
import { spawnSync } from 'child_process';

export function check(
  toolInput: Record<string, unknown>,
  context?: { hookEvent: 'pre' | 'post' | 'stop'; cwd: string; filePath?: string; sessionState?: { editsPerformed: boolean; filesCreated: boolean; skillsInvoked: string[] } }
): { pass: boolean; message?: string } | Promise<{ pass: boolean; message?: string }> {
  // Only run on post-hook when we have a file path
  if (!context || context.hookEvent !== 'post' || !context.filePath) {
    return { pass: true };
  }

  const result = spawnSync('bunx', ['eslint', '--no-warn-ignored', context.filePath], {
    cwd: context.cwd,
    timeout: 8000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Fail open if linter is not installed or times out
  if (result.error || result.status === null) {
    return { pass: true };
  }

  if (result.status !== 0) {
    const output = result.stdout?.toString().trim() || result.stderr?.toString().trim() || '';
    return { pass: false, message: \`ESLint violations:\\n\${output}\` };
  }

  return { pass: true };
}
\`\`\`

Native tool checkers like this should:
- Set \`hook_event: "post"\` in the rule so they run after writes/edits
- Handle linter-not-installed gracefully (fail open — return \`{ pass: true }\`)
- Use a timeout (8s recommended, the enforce layer adds a 10s outer timeout)
- Accept the second \`context\` parameter for \`cwd\` and \`filePath\`

## Post-Hook Checkers

Rules can specify \`hook_event\` to control when they run:
- \`"pre"\` (default) — runs in PreToolUse, before the tool executes. Best for blocking dangerous commands.
- \`"post"\` — runs in PostToolUse, after the tool executes. Best for file validation via native tools (linters, type-checkers).
- \`"stop"\` — runs in the Stop hook, when the agent finishes. Best for session-level checks (missed typecheck, missed tests, etc.).
- \`"both"\` — runs in both pre and post hooks (not stop — use \`"stop"\` explicitly for that).

Checkers receive a second argument with context:
\`\`\`typescript
interface PostToolContext {
  hookEvent: 'pre' | 'post' | 'stop';
  toolResponse?: unknown;  // The tool's response (if available)
  cwd: string;             // Working directory
  filePath?: string;       // Extracted from toolInput.file_path if present
  sessionState?: {         // Available in stop checkers
    editsPerformed: boolean;
    filesCreated: boolean;
    skillsInvoked: string[];
  };
}
\`\`\`

**Guidance**: Use pre-hooks for blocking dangerous commands (e.g., \`rm -rf\`, wrong package manager). Use post-hooks for file validation via native tools (ESLint, tsc, Biome). Use stop-hooks for session-level invariants (e.g., "if edits were made, typecheck must have run"). Always handle linter-not-installed gracefully (fail open).

## Stop-Hook Checkers

Stop-hook checkers run when the agent session ends. They receive \`sessionState\` in the context, which tracks what happened during the session. Use them to enforce session-level invariants.

Example — require typecheck after edits:
\`\`\`typescript
export function check(
  _toolInput: Record<string, unknown>,
  context?: { hookEvent: string; sessionState?: { editsPerformed: boolean; skillsInvoked: string[] } }
): { pass: boolean; message?: string } {
  if (!context || context.hookEvent !== 'stop') return { pass: true };
  const state = context.sessionState;
  if (!state || !state.editsPerformed) return { pass: true };

  // If edits were performed but type-check skill was never invoked, block
  if (!state.skillsInvoked.includes('type-check')) {
    return { pass: false, message: 'Edits were made but type-check was never run. Run /type-check before finishing.' };
  }
  return { pass: true };
}
\`\`\`

Stop-hook rules should use \`tool_matcher: ".*"\` since there's no specific tool at stop time.

**Important**: Stop checkers must evaluate actual conditions (e.g. check if typecheck was run, not whether the hook previously fired). On retry, previously-satisfied rules will naturally pass, while unsatisfied rules will correctly block again.

## rules.json hook_event field

The \`hook_event\` field is optional and defaults to \`"pre"\`. Values: \`"pre"\`, \`"post"\`, \`"stop"\`, \`"both"\`.
\`\`\`json
{
  "id": "eslint-check",
  "source": "CLAUDE.md",
  "description": "Run ESLint on written/edited TypeScript files",
  "tool_matcher": "Write|Edit",
  "checker": "eslint-post-check.ts",
  "activated_by_skill": null,
  "required_skills": [],
  "requires_skill": null,
  "message": "ESLint violations found in the file",
  "hook_event": "post"
}
\`\`\`

\`\`\`json
{
  "id": "require-typecheck",
  "source": "CLAUDE.md",
  "description": "Require type-check after code edits",
  "tool_matcher": ".*",
  "checker": "require-typecheck.ts",
  "activated_by_skill": null,
  "required_skills": [],
  "requires_skill": null,
  "message": "Edits were made but type-check was never run",
  "hook_event": "stop"
}
\`\`\``;
}

export function buildUserPrompt(source: RuleSource, sourceHash: string, previousRules: Rule[]): string {
  let previousSection = '';
  if (previousRules.length > 0) {
    previousSection = `
## Previously extracted rules

${previousRules.map((r) => `- **${r.id}** (checker: ${r.checker}): "${r.source_instruction || r.description}"`).join('\n')}

Compare these source_instructions against the current source file:
1. If an instruction still exists in the source → keep the rule and its checker (update only if the instruction changed)
2. If an instruction was removed from the source → delete the rule and its checker file
3. If there are NEW instructions in the source not covered by any rule above → create new rules for them
`;
  }

  return `Read the source file at: ${source.sourcePath}

Extract enforceable rules and write:
1. Checker scripts to: ${source.checkersDir}/
2. Rules metadata to: ${source.rulesJsonPath}

The source_hash for rules.json is: ${sourceHash}
The source label is: ${source.label}
${previousSection}
Important:
- Create the directories if they don't exist (use mkdir -p)
- Each checker script is a standalone TypeScript file placed directly in the scripts directory (not in a subdirectory)
- If a rule requires multiple files (helper modules, shared utilities), create a subfolder named after the rule (e.g., \`my-rule/\`) and place all files inside it with the main checker as \`index.ts\`. Reference it as \`my-rule/index.ts\` in rules.json.
- Test each checker with a sample input before finalizing
- Write the rules.json file last, after all checkers are verified
- Only include checkers in rules.json that actually exist in the scripts directory`;
}

export function buildFixPrompt(rules: { rule: Rule; checkerPath: string; checkerContent: string }[], problem: string): string {
  const rulesSection = rules.map(({ rule, checkerPath, checkerContent }) => `### Rule: ${rule.id}
- Description: ${rule.description}
- Tool matcher: ${rule.tool_matcher}
- Message: ${rule.message}
${rule.requires_skill ? `- Skill gate for: ${rule.requires_skill}` : ''}
- Checker file: ${checkerPath}

Current checker code:
\`\`\`typescript
${checkerContent}
\`\`\`
`).join('\n');

  return `Fix the following checker script(s).

${rulesSection}

Problem:
${problem}

Fix each checker script that is affected by the problem. Each checker must still export a \`check(toolInput)\` function returning \`{ pass: boolean; message?: string }\`.

After fixing, test checkers with sample inputs that reproduce the problem to verify the fix works. Also test that legitimate violations are still caught.`;
}
