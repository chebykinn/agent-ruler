#!/usr/bin/env bun
import * as path from 'path';
import { Command } from 'commander';
import { resolveProjectRoot } from './project';
import { getAllRuleSources, getStaleSources, loadAllRules } from './storage';
import { generateRules, fixRules } from './generate';
import { enforce } from './enforce';
import type { EnforcementLogEntry } from './types';

const program = new Command();

// Claude Code may invoke hooks as: agent-ruler --output-format json hook
// Extract the subcommand and its args, dropping any unknown leading flags
const SUBCOMMANDS = new Set(['enforce', 'compile', 'revise', 'resign', 'verify', 'test', 'status', 'review', 'hook']);
const rawArgs = process.argv.slice(2);
const cmdIdx = rawArgs.findIndex((a) => SUBCOMMANDS.has(a));
const reorderedArgs = cmdIdx > 0
  ? rawArgs.slice(cmdIdx)
  : rawArgs;

program
  .name('agent-ruler')
  .description('Claude Code rule enforcement')
  .version('0.1.1');

program
  .command('enforce')
  .description('Install hooks into .claude/settings.json and generate rules')
  .option('--project <dir>', 'Project root (default: auto-detect from cwd)')
  .option('--force', 'Regenerate all rules, even if sources haven\'t changed')
  .option('--max-parallel <n>', 'Max parallel Claude instances for generation', parseInt)
  .action(async (opts) => {
    const projectRoot = opts.project ? path.resolve(opts.project) : resolveProjectRoot();
    await cmdEnforce(projectRoot, opts.force ?? false, opts.maxParallel);
  });

program
  .command('compile')
  .description('Generate/regenerate checker scripts from CLAUDE.md and SKILL.md')
  .option('--project <dir>', 'Project root (default: auto-detect from cwd)')
  .option('--force', 'Regenerate all rules, even if sources haven\'t changed')
  .option('--max-parallel <n>', 'Max parallel Claude instances for generation', parseInt)
  .action(async (opts) => {
    const projectRoot = opts.project ? path.resolve(opts.project) : resolveProjectRoot();
    await cmdCompile(projectRoot, opts.force ?? false, opts.maxParallel);
  });

program
  .command('revise')
  .description('Fix checker(s) — target: rule-id, skill-name, claude.md, or all')
  .argument('<target>', 'rule-id, skill-name, claude.md, or all')
  .argument('<message...>', 'Problem description')
  .option('--project <dir>', 'Project root (default: auto-detect from cwd)')
  .action(async (target, messageParts, opts) => {
    const projectRoot = opts.project ? path.resolve(opts.project) : resolveProjectRoot();
    await cmdRevise(projectRoot, target, messageParts.join(' '));
  });

program
  .command('resign')
  .description('Remove hooks from .claude/settings.json (keeps rules intact)')
  .option('--project <dir>', 'Project root (default: auto-detect from cwd)')
  .action(async (opts) => {
    const projectRoot = opts.project ? path.resolve(opts.project) : resolveProjectRoot();
    await cmdResign(projectRoot);
  });

program
  .command('verify')
  .description('Verify all rules load and checkers compile')
  .option('--project <dir>', 'Project root (default: auto-detect from cwd)')
  .action(async (opts) => {
    const projectRoot = opts.project ? path.resolve(opts.project) : resolveProjectRoot();
    await cmdVerify(projectRoot);
  });

program
  .command('test')
  .description('Test enforcement against a tool call')
  .argument('<json>', 'JSON payload with tool_name and tool_input')
  .option('--hook <event>', 'Hook event type: pre, post, or stop', 'pre')
  .option('--project <dir>', 'Project root (default: auto-detect from cwd)')
  .action(async (jsonStr, opts) => {
    const projectRoot = opts.project ? path.resolve(opts.project) : resolveProjectRoot();
    await cmdTest(projectRoot, jsonStr, opts.hook);
  });

program
  .command('status')
  .description('Show rule sources and staleness')
  .option('--project <dir>', 'Project root (default: auto-detect from cwd)')
  .action(async (opts) => {
    const projectRoot = opts.project ? path.resolve(opts.project) : resolveProjectRoot();
    await cmdStatus(projectRoot);
  });

program
  .command('review')
  .description('Review a session\'s enforcement log for false negatives')
  .argument('<session-id>', 'Claude Code session ID or path to state JSON')
  .option('--project <dir>', 'Project root (default: auto-detect from cwd)')
  .action(async (sessionId, opts) => {
    const projectRoot = opts.project ? path.resolve(opts.project) : resolveProjectRoot();
    await cmdReview(projectRoot, sessionId);
  });

program
  .command('hook')
  .description('Run as hook (reads HookEvent from stdin) — used by .claude/settings.json')
  .option('--project <dir>', 'Project root (default: auto-detect from cwd)')
  .allowUnknownOption()
  .allowExcessArguments()
  .action(async (opts) => {
    const projectRoot = opts.project ? path.resolve(opts.project) : resolveProjectRoot();
    await cmdHook(projectRoot);
  });

async function cmdEnforce(projectRoot: string, force: boolean, maxParallel?: number): Promise<void> {
  const fs = await import('fs/promises');
  const settingsPath = path.join(projectRoot, '.claude/settings.json');
  const hookCmd = `${process.argv[1]} hook`;

  await fs.mkdir(path.join(projectRoot, '.claude'), { recursive: true });

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

  await cmdCompile(projectRoot, force, maxParallel);
}

async function cmdCompile(projectRoot: string, force: boolean, maxParallel?: number): Promise<void> {
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

  await generateRules(toGenerate, projectRoot, maxParallel);
  console.log('Done.');
}

async function cmdRevise(projectRoot: string, target: string, problem: string): Promise<void> {
  const fs = await import('fs/promises');

  const sources = await getAllRuleSources(projectRoot);
  const allRules = await loadAllRules(sources);

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

async function cmdTest(projectRoot: string, jsonStr: string, hookEvent: string): Promise<void> {
  let payload: { tool_name: string; tool_input: Record<string, unknown> };
  try {
    payload = JSON.parse(jsonStr);
  } catch {
    console.error('Invalid JSON payload');
    process.exit(1);
  }

  const validEvents = ['pre', 'post', 'stop'] as const;
  const event = validEvents.includes(hookEvent as typeof validEvents[number])
    ? (hookEvent as typeof validEvents[number])
    : 'pre';

  const sources = await getAllRuleSources(projectRoot);
  const state = { skillsInvoked: [], editsPerformed: false, filesCreated: false, transcriptOffset: 0, log: [] as EnforcementLogEntry[] };
  const result = await enforce(payload.tool_name, payload.tool_input || {}, sources, state, {
    hookEvent: event,
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

async function cmdReview(projectRoot: string, sessionIdOrPath: string): Promise<void> {
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

program.parseAsync([process.argv[0], process.argv[1], ...reorderedArgs]).catch((err) => {
  console.error('[agent-ruler] Fatal error:', err);
  process.exit(1);
});
