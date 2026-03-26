export interface Rule {
  id: string;
  source: string;
  description: string;
  tool_matcher: string;
  checker: string;
  activated_by_skill: string | null;
  required_skills: string[];
  /** If set, this rule is a skill gate — blocks unless the named skill has been invoked */
  requires_skill: string | null;
  message: string;
  /** When this rule runs: 'pre' (default), 'post', 'stop', or 'both' */
  hook_event?: 'pre' | 'post' | 'stop' | 'both';
  /** The verbatim instruction from the source MD that generated this rule */
  source_instruction: string;
}

export interface RulesFile {
  source_hash: string;
  rules: Rule[];
}

export interface EnforcementLogEntry {
  timestamp: string;              // ISO 8601
  hookEvent: 'pre' | 'post' | 'stop';
  toolName: string;
  toolInput: Record<string, unknown>;
  rulesChecked: {
    ruleId: string;
    source: string;
    passed: boolean;
    message?: string;
  }[];
  violations: { ruleId: string; message: string }[];
}

export interface SessionState {
  skillsInvoked: string[];
  editsPerformed: boolean;
  filesCreated: boolean;
  /** Byte offset into transcript we've already scanned */
  transcriptOffset: number;
  log: EnforcementLogEntry[];
}

export interface HookEvent {
  hook_event_name: 'PreToolUse' | 'PostToolUse' | 'Stop';
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  session_id: string;
  transcript_path?: string;
  cwd?: string;
}

export interface CheckResult {
  pass: boolean;
  message?: string;
}

/** Context passed as second argument to checkers during enforcement */
export interface PostToolContext {
  hookEvent: 'pre' | 'post' | 'stop';
  toolResponse?: unknown;
  cwd: string;
  filePath?: string;
  /** Session state snapshot — available in stop checkers for inspecting what happened */
  sessionState?: SessionState;
}

export interface CheckerModule {
  check: (toolInput: Record<string, unknown>, context?: PostToolContext) => CheckResult | Promise<CheckResult>;
}

export interface RuleSource {
  /** Path to the source file (CLAUDE.md or SKILL.md) */
  sourcePath: string;
  /** Where rules.json should be stored */
  rulesJsonPath: string;
  /** Directory for checker scripts */
  checkersDir: string;
  /** Label for this source (e.g. "CLAUDE.md", "skill:code-style") */
  label: string;
}

export interface HookResponse {
  decision?: 'block' | 'approve';
  reason?: string;
}
