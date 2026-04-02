import * as fs from 'fs/promises';
import * as path from 'path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Rule, RuleSource, RulesFile } from './types';
import { hashFile, loadRulesFile } from './storage';
import { buildSystemPrompt, buildUserPrompt, buildFixPrompt } from './prompt';

const LOCK_FILE = '/tmp/agent-ruler-generating.lock';
const LOCK_MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes

async function acquireLock(): Promise<boolean> {
  try {
    const stat = await fs.stat(LOCK_FILE);
    if (Date.now() - stat.mtimeMs < LOCK_MAX_AGE_MS) {
      return false;
    }
    await fs.unlink(LOCK_FILE).catch(() => {});
  } catch {
    // no lock file exists
  }

  try {
    await fs.writeFile(LOCK_FILE, String(process.pid), { flag: 'wx' });
    return true;
  } catch {
    return false;
  }
}

async function releaseLock(): Promise<void> {
  await fs.unlink(LOCK_FILE).catch(() => {});
}

export const DEFAULT_MAX_PARALLEL = 3;

export async function generateRules(
  sources: RuleSource[],
  projectRoot: string,
  maxParallel: number = DEFAULT_MAX_PARALLEL,
): Promise<void> {
  const locked = await acquireLock();
  if (!locked) {
    console.error('[agent-ruler] Generation already in progress (lock held), skipping.');
    return;
  }

  try {
    const queue = [...sources];
    const running: Promise<void>[] = [];

    while (queue.length > 0 || running.length > 0) {
      while (running.length < maxParallel && queue.length > 0) {
        const source = queue.shift()!;
        const p = generateRulesForSource(source, projectRoot).then(() => {
          running.splice(running.indexOf(p), 1);
        });
        running.push(p);
      }
      if (running.length > 0) {
        await Promise.race(running);
      }
    }
  } finally {
    await releaseLock();
  }
}

async function loadExistingRules(source: RuleSource): Promise<Rule[]> {
  const existing = await loadRulesFile(source.rulesJsonPath);
  if (!existing) return [];
  return existing.rules;
}

async function generateRulesForSource(source: RuleSource, projectRoot: string): Promise<void> {
  console.error(`[agent-ruler] Generating rules for ${source.label}...`);

  const previousRules = await loadExistingRules(source);
  const sourceHash = await hashFile(source.sourcePath);
  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt(source, sourceHash, previousRules);

  const queryInstance = query({
    prompt: userPrompt,
    options: {
      cwd: projectRoot,
      model: 'sonnet',
      permissionMode: 'acceptEdits',
      maxTurns: 50,
      allowedTools: ['Read', 'Glob', 'Grep', 'Write', 'Bash', 'Edit'],
      systemPrompt,
      stderr: (data: string) => {
        if (data.trim()) console.error(`  [${source.label}] stderr: ${data.trim()}`);
      },
    },
  });

  for await (const message of queryInstance) {
    if (message.type === 'assistant') {
      const content = (message as any).message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block.type === 'tool_use') {
          console.error(`  [${source.label}] ${block.name}${block.input?.file_path ? ` ${block.input.file_path}` : block.input?.command ? ` ${String(block.input.command).slice(0, 80)}` : ''}`);
        }
      }
    } else if (message.type === 'result') {
      if (message.subtype === 'success') {
        console.error(`[agent-ruler] Rules generated for ${source.label}`);
      } else {
        console.error(`[agent-ruler] Rule generation failed for ${source.label}:`, message);
      }
    }
  }
}

export async function fixRules(
  matches: { rule: Rule; source: RuleSource }[],
  problem: string,
  projectRoot: string
): Promise<void> {
  const claudeDir = path.join(projectRoot, '.claude');

  const entries: { rule: Rule; checkerPath: string; checkerContent: string }[] = [];
  for (const { rule, source } of matches) {
    const absCheckerPath = path.join(source.checkersDir, rule.checker.replace(/^checkers\//, ''));
    try {
      const checkerContent = await fs.readFile(absCheckerPath, 'utf-8');
      const checkerPath = path.relative(claudeDir, absCheckerPath);
      entries.push({ rule, checkerPath, checkerContent });
    } catch {
      console.error(`[agent-ruler] Checker file not found: ${absCheckerPath}, skipping`);
    }
  }

  if (entries.length === 0) return;

  const ruleIds = entries.map((e) => e.rule.id).join(', ');
  console.error(`[agent-ruler] Fixing ${entries.length} rule(s): ${ruleIds}`);

  const prompt = buildFixPrompt(entries, problem);

  const queryInstance = query({
    prompt,
    options: {
      cwd: claudeDir,
      model: 'sonnet',
      permissionMode: 'acceptEdits',
      maxTurns: 50,
      allowedTools: ['Read', 'Write', 'Edit', 'Bash'],
      systemPrompt: 'You are a checker script fixer. Fix the checker scripts based on the problem description. All file paths are relative to the .claude/ directory (your cwd). Test your fixes before finalizing.',
      stderr: (data: string) => {
        if (data.trim()) console.error(`  [fix] stderr: ${data.trim()}`);
      },
    },
  });

  for await (const message of queryInstance) {
    if (message.type === 'assistant') {
      const content = (message as any).message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block.type === 'text' && block.text) {
          process.stderr.write(block.text);
        } else if (block.type === 'tool_use') {
          console.error(`\n[tool] ${block.name}${block.input?.file_path ? ` ${block.input.file_path}` : block.input?.command ? ` ${String(block.input.command).slice(0, 80)}` : ''}`);
        }
      }
    } else if (message.type === 'result') {
      console.error('');
      if (message.subtype === 'success') {
        console.error(`[agent-ruler] Fixed ${entries.length} rule(s)`);
      } else {
        console.error(`[agent-ruler] Fix failed:`, message);
      }
    }
  }
}
