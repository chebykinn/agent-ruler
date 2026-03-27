#!/usr/bin/env bun
import * as path from 'path';
import { resolveProjectRoot } from './project';
import { getAllRuleSources, getStaleSources, loadAllRules } from './storage';
import { generateRules, fixRules } from './generate';
import { enforce } from './enforce';

const AGENT_RULER_BIN = process.argv[1];

const USAGE = `agent-ruler — Claude Code rule enforcement

Usage:
  agent-ruler enforce               Install hooks into .claude/settings.json and generate rules
  agent-ruler compile [--force]     Generate/regenerate checker scripts from CLAUDE.md and SKILL.md
  agent-ruler revise <target> <msg> Fix checker(s) — target: rule-id, skill-name, claude.md, or all
  agent-ruler resign                Remove hooks from .claude/settings.json (keeps rules intact)
  agent-ruler verify                Verify all rules load and checkers compile
  agent-ruler test [--hook pre|post|stop] <json>   Test enforcement against a tool call
  agent-ruler status                Show rule sources and staleness
  agent-ruler review <session-id>   Review a session's enforcement log for false negatives
  agent-ruler hook                  Run as hook (reads HookEvent from stdin) — used by .claude/settings.json

Options:
  --project <dir>   Project root (default: auto-detect from cwd)
  --force           Regenerate all rules, even if sources haven't changed

Examples:
  agent-ruler enforce                                     # Wire hooks + generate rules
  agent-ruler compile                                     # Generate rules for stale sources
  agent-ruler compile --force                             # Regenerate all rules
  agent-ruler status                                      # Show all rule sources and their status
  agent-ruler test '{"tool_name":"Bash","tool_input":{"command":"npm install"}}'
  agent-ruler revise find-code "gate checker is too broad, matches piped head/tail"
  agent-ruler revise all "checkers should handle missing fields gracefully"
  agent-ruler resign                                      # Remove hooks from settings
  agent-ruler verify                                      # Verify all checkers load correctly
`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === '--help' || command === '-h') {
    console.error(USAGE);
    process.exit(0);
  }

  const projectFlagIdx = args.indexOf('--project');
  const projectDir = projectFlagIdx !== -1
    ? path.resolve(args[projectFlagIdx + 1])
    : resolveProjectRoot();

  const force = args.includes('--force');

  switch (command) {
    case 'enforce':
      await cmdEnforce(projectDir, force);
      break;
    case 'compile':
      await cmdCompile(projectDir, force);
      break;
    case 'revise':
      await cmdRevise(projectDir, args.slice(1));
      break;
    case 'resign':
      await cmdResign(projectDir);
      break;
    case 'verify':
      await cmdVerify(projectDir);
      break;
    case 'test':
      await cmdTest(projectDir, args.slice(1));
      break;
    case 'status':
      await cmdStatus(projectDir);
      break;
    case 'review':
      await cmdReview(projectDir, args.slice(1));
      break;
    case 'hook':
      await cmdHook(projectDir);
      break;
    default:
      console.error(`Unknown command: ${command}`);
      console.error(USAGE);
      process.exit(1);
  }
}

async function cmdEnforce(projectRoot: string, force: boolean): Promise<void> {
  const fs = await import('fs/promises');
  const settingsPath = path.join(projectRoot, '.claude/settings.json');
  const hookCmd = `${AGENT_RULER_BIN} hook`;

  // Ensure .claude/ exists
  await fs.mkdir(path.join(projectRoot, '.claude'), { recursive: true });

  // Load or create settings
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(await fs.readFile(settingsPath, 'utf-8'));
  } catch {
    // No existing settings
  }

  const hooks = (settings.hooks || {}) as Record<string, unknown[]>;

  const agentRulerHook = { matcher: '*', hooks: [{ type: 'command', command: hookCmd }] };

  for (const event of ['PreToolUse', 'PostToolUse', 'Stop'] as const) {
    const existing = (hooks[event] || []) as Array<{ matcher: string; hooks: Array<{ command: string }> }>;
    const alreadyWired = existing.some((entry) =>
      entry.hooks?.some((h) => h.command.includes('agent-ruler'))
    );
    if (alreadyWired) {
      console.log(`${event}: already wired`);
    } else {
      existing.push(agentRulerHook);
      hooks[event] = existing;
      console.log(`${event}: hooked`);
    }
  }

  settings.hooks = hooks;
  await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  console.log(`Wrote ${settingsPath}\n`);

  // Generate rules
  await cmdCompile(projectRoot, force);
}

async function cmdCompile(projectRoot: string, force: boolean): Promise<void> {
  console.log(`Project root: ${projectRoot}`);
  const sources = await getAllRuleSources(projectRoot);
  console.log(`Found ${sources.length} rule source(s)`);

  const toGenerate = force ? sources : await getStaleSources(sources);

  if (toGenerate.length === 0) {
    console.log('All rules are up to date.');
    return;
  }

  console.log(`Generating rules for ${toGenerate.length} source(s):`);
  for (const s of toGenerate) {
    console.log(`  - ${s.label}`);
  }

  await generateRules(toGenerate, projectRoot);
  console.log('Done.');
}

async function cmdRevise(projectRoot: string, args: string[]): Promise<void> {
  const fs = await import('fs/promises');
  const filtered = args.filter((a) => a !== '--project' && a !== '--force');
  const target = filtered[0];
  let problem = filtered.slice(1).join(' ');

  if (!target || !problem) {
    console.error('Usage: agent-ruler revise <target> <problem description>');
    console.error('\nTarget can be:');
    console.error('  rule-id          Fix a single rule by ID');
    console.error('  skill-name       Fix all rules from a skill (e.g. "code-style", "find-code")');
    console.error('  claude.md        Fix all rules from CLAUDE.md');
    console.error('  all              Fix all rules');
    console.error('\nExample: agent-ruler revise find-code-gate "matches head/tail in pipes"');
    console.error('         agent-ruler revise code-style "checkers should only inspect new code, not whole files"');
    console.error('         agent-ruler revise all "checkers should handle missing fields gracefully"');
    process.exit(1);
  }

  const sources = await getAllRuleSources(projectRoot);
  const allRules = await loadAllRules(sources);

  // Collect matching rules
  type RuleMatch = { rule: (typeof allRules)[0]['rules']['rules'][0]; source: (typeof allRules)[0]['source'] };
  const matches: RuleMatch[] = [];

  const targetLower = target.toLowerCase();

  for (const { source, rules } of allRules) {
    for (const rule of rules.rules) {
      if (targetLower === 'all') {
        matches.push({ rule, source });
      } else if (targetLower === 'claude.md' && source.label === 'CLAUDE.md') {
        matches.push({ rule, source });
      } else if (source.label === `skill:${target}`) {
        matches.push({ rule, source });
      } else if (rule.id === target) {
        matches.push({ rule, source });
      }
    }
  }

  if (matches.length === 0) {
    console.error(`No rules matched: ${target}`);
    console.error('\nAvailable targets:');
    console.error('  all              All rules');
    console.error('  claude.md        CLAUDE.md rules');
    const skillNames = new Set<string>();
    for (const { source, rules } of allRules) {
      if (source.label.startsWith('skill:')) skillNames.add(source.label.replace('skill:', ''));
      for (const rule of rules.rules) {
        console.error(`  ${rule.id}`);
      }
    }
    for (const name of skillNames) {
      console.error(`  ${name}            (skill)`);
    }
    process.exit(1);
  }

  // If problem is a file path, read its contents
  try {
    const stat = await fs.stat(problem);
    if (stat.isFile()) {
      problem = await fs.readFile(problem, 'utf-8');
    }
  } catch {}

  console.log(`Fixing ${matches.length} rule(s) for target "${target}":`);
  for (const m of matches) {
    console.log(`  - ${m.rule.id} (${m.source.label})`);
  }
  console.log(`Problem: ${problem.length > 200 ? problem.slice(0, 200) + '...' : problem}\n`);

  await fixRules(matches, problem, projectRoot);
  console.log('Done.');
}

async function cmdResign(projectRoot: string): Promise<void> {
  const fs = await import('fs/promises');
  const settingsPath = path.join(projectRoot, '.claude/settings.json');

  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(await fs.readFile(settingsPath, 'utf-8'));
  } catch {
    console.log('No settings file found.');
    return;
  }

  const hooks = (settings.hooks || {}) as Record<string, unknown[]>;
  let removed = 0;

  for (const event of ['PreToolUse', 'PostToolUse', 'Stop'] as const) {
    const existing = (hooks[event] || []) as Array<{ hooks: Array<{ command: string }> }>;
    const filtered = existing.filter(
      (entry) => !entry.hooks?.some((h) => h.command.includes('agent-ruler'))
    );
    removed += existing.length - filtered.length;
    hooks[event] = filtered;
  }

  settings.hooks = hooks;
  await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  console.log(`Removed ${removed} hook(s) from ${settingsPath}`);
}

async function cmdVerify(projectRoot: string): Promise<void> {
  const sources = await getAllRuleSources(projectRoot);
  const allRules = await loadAllRules(sources);
  let totalRules = 0;
  let errors = 0;

  for (const { source, rules } of allRules) {
    for (const rule of rules.rules) {
      totalRules++;
      const checkerPath = path.join(source.checkersDir, rule.checker.replace(/^checkers\//, ''));
      try {
        const mod = await import(checkerPath);
        if (typeof mod.check !== 'function') {
          console.error(`  FAIL ${rule.id}: checker does not export a check() function`);
          errors++;
          continue;
        }
        // Smoke test with empty input (supports async checkers)
        const result = await Promise.resolve(mod.check({}));
        if (typeof result?.pass !== 'boolean') {
          console.error(`  FAIL ${rule.id}: check() did not return { pass: boolean }`);
          errors++;
          continue;
        }
        console.log(`  OK   ${rule.id} (${source.label})`);
      } catch (err) {
        console.error(`  FAIL ${rule.id}: ${err}`);
        errors++;
      }
    }
  }

  console.log(`\n${totalRules} rules checked, ${errors} error(s)`);
  if (errors > 0) process.exit(1);
}

async function cmdTest(projectRoot: string, args: string[]): Promise<void> {
  // Filter out --project and its value from args
  const filtered = args.filter((a) => a !== '--project' && a !== '--force');

  // Parse --hook flag
  const hookIdx = filtered.indexOf('--hook');
  let hookEvent: 'pre' | 'post' | 'stop' = 'pre';
  let remaining = filtered;
  if (hookIdx !== -1) {
    const hookVal = filtered[hookIdx + 1];
    if (hookVal === 'post' || hookVal === 'pre' || hookVal === 'stop') {
      hookEvent = hookVal;
    }
    remaining = [...filtered.slice(0, hookIdx), ...filtered.slice(hookIdx + 2)];
  }

  const jsonStr = remaining[0];

  if (!jsonStr) {
    console.error('Usage: agent-ruler test [--hook pre|post|stop] \'{"tool_name":"Bash","tool_input":{"command":"npm install"}}\'');
    process.exit(1);
  }

  let payload: { tool_name: string; tool_input: Record<string, unknown> };
  try {
    payload = JSON.parse(jsonStr);
  } catch {
    console.error('Invalid JSON payload');
    process.exit(1);
  }

  const sources = await getAllRuleSources(projectRoot);
  const state = { skillsInvoked: [], editsPerformed: false, filesCreated: false, transcriptOffset: 0, log: [] as import('./types').EnforcementLogEntry[] };
  const result = await enforce(payload.tool_name, payload.tool_input || {}, sources, state, {
    hookEvent,
    cwd: projectRoot,
  });

  if (result.allowed) {
    console.log('ALLOWED');
  } else {
    console.log('BLOCKED');
    for (const v of result.violations) {
      console.log(`  [${v.rule.id}] ${v.message}`);
    }
    process.exit(2);
  }
}

async function cmdStatus(projectRoot: string): Promise<void> {
  console.log(`Project root: ${projectRoot}\n`);
  const sources = await getAllRuleSources(projectRoot);
  const stale = await getStaleSources(sources);
  const staleLabels = new Set(stale.map((s) => s.label));

  const allRules = await loadAllRules(sources);
  const rulesByLabel = new Map(allRules.map((r) => [r.source.label, r]));

  for (const source of sources) {
    const isStale = staleLabels.has(source.label);
    const status = isStale ? '(stale — needs regeneration)' : '(up to date)';
    console.log(`${source.label} ${status}`);
    console.log(`  Source: ${source.sourcePath}`);
    console.log(`  Rules:  ${source.rulesJsonPath}`);

    const loaded = rulesByLabel.get(source.label);
    if (loaded) {
      for (const rule of loaded.rules.rules) {
        console.log(`    - ${rule.id}: ${rule.description}`);
      }
    } else {
      console.log('    (no rules generated yet)');
    }
    console.log();
  }
}

async function cmdReview(projectRoot: string, args: string[]): Promise<void> {
  const sessionIdOrPath = args.filter((a) => a !== '--project' && a !== '--force')[0];
  if (!sessionIdOrPath) {
    console.error('Usage: agent-ruler review <session-id>');
    console.error('\nSession ID is the Claude Code session ID, or a path to an agent-ruler state JSON file.');
    process.exit(1);
  }

  const { reviewSession } = await import('./review');
  await reviewSession(sessionIdOrPath, projectRoot);
}

async function cmdHook(projectRoot: string): Promise<void> {
  const { handlePreToolUse } = await import('./handlers/pre-tool-use');
  const { handlePostToolUse } = await import('./handlers/post-tool-use');
  const { handleStop } = await import('./handlers/stop');

  const input = await Bun.stdin.text();
  let event;
  try {
    event = JSON.parse(input);
  } catch {
    console.error('[agent-ruler] Failed to parse stdin');
    process.exit(0);
  }

  let response = {};
  switch (event.hook_event_name) {
    case 'PreToolUse':
      response = await handlePreToolUse(event, projectRoot);
      break;
    case 'PostToolUse':
      response = await handlePostToolUse(event, projectRoot);
      break;
    case 'Stop':
      response = await handleStop(event, projectRoot);
      break;
  }

  if ((response as { decision?: string }).decision) {
    console.log(JSON.stringify(response));
  }
}

main().catch((err) => {
  console.error('[agent-ruler] Fatal error:', err);
  process.exit(1);
});
