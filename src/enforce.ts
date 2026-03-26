import * as path from 'path';
import type { Rule, RuleSource, CheckerModule, CheckResult, SessionState, PostToolContext, EnforcementLogEntry } from './types';
import { loadAllRules } from './storage';

const CHECKER_TIMEOUT_MS = 10_000;

function resolveCheckerPath(checkersDir: string, checker: string): string {
  // Handle cases where checker already includes "checkers/" prefix
  const normalized = checker.replace(/^checkers\//, '');
  return path.join(checkersDir, normalized);
}

export interface EnforceResult {
  allowed: boolean;
  violations: { rule: Rule; message: string }[];
  logEntry?: EnforcementLogEntry;
}

/** Extra context injected into toolInput as `__agent_ruler_context__` for checker use */
export interface CheckerContext {
  transcriptPath?: string;
  sessionId?: string;
  hookEvent?: 'pre' | 'post' | 'stop';
  toolResponse?: unknown;
  cwd?: string;
  sessionState?: SessionState;
}

export async function enforce(
  toolName: string,
  toolInput: Record<string, unknown>,
  sources: RuleSource[],
  state: SessionState,
  context?: CheckerContext
): Promise<EnforceResult> {
  const allRules = await loadAllRules(sources);
  const violations: { rule: Rule; message: string }[] = [];
  const currentHook = context?.hookEvent || 'pre';
  const rulesChecked: EnforcementLogEntry['rulesChecked'] = [];

  // Enrich toolInput with session context so checkers can inspect transcript history.
  // Existing checkers that ignore `__agent_ruler_context__` are unaffected.
  const enrichedInput: Record<string, unknown> = context
    ? { ...toolInput, __agent_ruler_context__: context }
    : toolInput;

  // Build PostToolContext for checkers that accept it
  const postToolContext: PostToolContext | undefined = context
    ? {
        hookEvent: currentHook,
        toolResponse: context.toolResponse,
        cwd: context.cwd || process.cwd(),
        filePath: typeof toolInput.file_path === 'string' ? toolInput.file_path : undefined,
        sessionState: context.sessionState,
      }
    : undefined;

  for (const { source, rules } of allRules) {
    for (const rule of rules.rules) {
      if (!matchesTool(rule.tool_matcher, toolName)) continue;
      if (!isRuleActive(rule, state)) continue;

      // Filter by hook_event — default is 'pre'
      const ruleHook = rule.hook_event || 'pre';
      if (ruleHook !== 'both' && ruleHook !== currentHook) continue;

      // Skill gate: if skill already loaded, skip this gate entirely
      if (rule.requires_skill) {
        if (state.skillsInvoked.includes(rule.requires_skill)) {
          continue;
        }
        const checkerPath = resolveCheckerPath(source.checkersDir, rule.checker);
        try {
          const result = await runCheckerWithTimeout(checkerPath, enrichedInput, postToolContext);
          const msg = !result.pass
            ? `You must invoke the "${rule.requires_skill}" skill first. ${result.message || rule.message}`
            : undefined;
          rulesChecked.push({ ruleId: rule.id, source: source.label, passed: result.pass, message: msg });
          if (!result.pass) {
            violations.push({ rule, message: msg! });
          }
        } catch (err) {
          console.error(`[agent-ruler] Failed to run skill gate checker ${rule.checker}:`, err);
        }
        continue;
      }

      const checkerPath = resolveCheckerPath(source.checkersDir, rule.checker);
      try {
        const result = await runCheckerWithTimeout(checkerPath, enrichedInput, postToolContext);
        const msg = !result.pass ? (result.message || rule.message) : undefined;
        rulesChecked.push({ ruleId: rule.id, source: source.label, passed: result.pass, message: msg });
        if (!result.pass) {
          violations.push({ rule, message: msg! });
        }
      } catch (err) {
        console.error(`[agent-ruler] Failed to run checker ${rule.checker}:`, err);
      }
    }
  }

  const logEntry: EnforcementLogEntry = {
    timestamp: new Date().toISOString(),
    hookEvent: currentHook,
    toolName,
    toolInput,
    rulesChecked,
    violations: violations.map((v) => ({ ruleId: v.rule.id, message: v.message })),
  };

  return {
    allowed: violations.length === 0,
    violations,
    logEntry,
  };
}

async function runCheckerWithTimeout(
  checkerPath: string,
  toolInput: Record<string, unknown>,
  postToolContext?: PostToolContext
): Promise<CheckResult> {
  const mod = (await import(checkerPath)) as CheckerModule;
  const resultOrPromise = mod.check(toolInput, postToolContext);

  // Wrap in Promise.race with timeout — fail open on timeout
  const result = await Promise.race([
    Promise.resolve(resultOrPromise),
    new Promise<CheckResult>((resolve) =>
      setTimeout(() => {
        console.error(`[agent-ruler] Checker timed out after ${CHECKER_TIMEOUT_MS}ms: ${checkerPath}`);
        resolve({ pass: true, message: 'Checker timed out — failing open' });
      }, CHECKER_TIMEOUT_MS)
    ),
  ]);

  return result;
}

function matchesTool(pattern: string, toolName: string): boolean {
  try {
    const regex = new RegExp(`^${pattern}$`);
    return regex.test(toolName);
  } catch {
    return pattern === toolName || pattern === '.*';
  }
}

function isRuleActive(rule: Rule, state: SessionState): boolean {
  // If rule requires a specific skill to be invoked first
  if (rule.activated_by_skill && !state.skillsInvoked.includes(rule.activated_by_skill)) {
    return false;
  }

  // If rule requires specific skills to have been invoked
  if (rule.required_skills.length > 0) {
    const allPresent = rule.required_skills.every((s) => state.skillsInvoked.includes(s));
    if (!allPresent) return false;
  }

  return true;
}
