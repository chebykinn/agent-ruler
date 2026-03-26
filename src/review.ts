import * as fs from 'fs/promises';
import * as path from 'path';
import * as readline from 'readline';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SessionState, EnforcementLogEntry } from './types';
import { getAllRuleSources, loadAllRules } from './storage';
import { fixRules } from './generate';

function statePath(sessionId: string): string {
  return `/tmp/agent-ruler-${sessionId}.json`;
}

async function findSessionLog(sessionIdOrPath: string): Promise<SessionState> {
  const filePath = sessionIdOrPath.includes('/')
    ? sessionIdOrPath
    : statePath(sessionIdOrPath);

  const content = await fs.readFile(filePath, 'utf-8');
  const state = JSON.parse(content) as SessionState;
  if (!Array.isArray(state.log)) state.log = [];
  return state;
}

function formatReport(state: SessionState): void {
  const log = state.log;
  const totalCalls = log.length;
  const totalRulesChecked = log.reduce((sum, e) => sum + e.rulesChecked.length, 0);
  const totalViolations = log.reduce((sum, e) => sum + e.violations.length, 0);

  console.log('=== Session Review ===\n');
  console.log(`Tool calls logged:    ${totalCalls}`);
  console.log(`Rules checked:        ${totalRulesChecked}`);
  console.log(`Violations caught:    ${totalViolations}`);
  console.log(`Skills invoked:       ${state.skillsInvoked.length > 0 ? state.skillsInvoked.join(', ') : '(none)'}`);
  console.log();

  if (totalViolations > 0) {
    console.log('--- Violations Caught ---\n');
    for (const entry of log) {
      for (const v of entry.violations) {
        console.log(`  [${entry.hookEvent}] ${entry.toolName} → ${v.ruleId}: ${v.message}`);
      }
    }
    console.log();
  }

  const cleanCalls = log.filter((e) => e.violations.length === 0);
  if (cleanCalls.length > 0) {
    console.log('--- Clean Tool Calls ---\n');
    for (const entry of cleanCalls) {
      const rulesStr = entry.rulesChecked.length > 0
        ? ` (${entry.rulesChecked.length} rules passed)`
        : ' (no rules matched)';
      console.log(`  [${entry.hookEvent}] ${entry.toolName}${rulesStr}`);
    }
    console.log();
  }
}

async function analyzeWithAI(state: SessionState, projectRoot: string): Promise<string> {
  console.log('--- AI Analysis ---\n');

  const sources = await getAllRuleSources(projectRoot);
  const allRules = await loadAllRules(sources);

  // Build rule definitions + checker source for the AI
  const ruleDefinitions: string[] = [];
  for (const { source, rules } of allRules) {
    for (const rule of rules.rules) {
      const checkerPath = path.join(source.checkersDir, rule.checker.replace(/^checkers\//, ''));
      let checkerSource = '(could not read)';
      try {
        checkerSource = await fs.readFile(checkerPath, 'utf-8');
      } catch {}

      ruleDefinitions.push(
        `## Rule: ${rule.id} (${source.label})\n` +
        `Description: ${rule.description}\n` +
        `Tool matcher: ${rule.tool_matcher}\n` +
        `Hook event: ${rule.hook_event || 'pre'}\n` +
        `Message: ${rule.message}\n` +
        `Requires skill: ${rule.requires_skill || 'none'}\n` +
        `Activated by skill: ${rule.activated_by_skill || 'none'}\n\n` +
        `### Checker source (${rule.checker}):\n\`\`\`typescript\n${checkerSource}\n\`\`\``
      );
    }
  }

  const logJson = JSON.stringify(state.log, null, 2);

  const prompt = `You are reviewing a Claude Code session's enforcement log to find enforcement gaps.

## All Rule Definitions and Checker Source Code

${ruleDefinitions.join('\n\n---\n\n')}

## Full Enforcement Log (${state.log.length} entries)

\`\`\`json
${logJson}
\`\`\`

## Session Info
- Skills invoked: ${state.skillsInvoked.length > 0 ? state.skillsInvoked.join(', ') : '(none)'}
- Edits performed: ${state.editsPerformed}
- Files created: ${state.filesCreated}

## Your Task

Analyze the enforcement log and identify:

1. **False negatives**: A rule was checked and passed, but the tool input suggests it should have failed. For each, explain why the checker missed it and suggest a concrete fix to the checker code.

2. **Missing rules**: Tool calls that look problematic (unsafe commands, style violations, missing checks) but no rule covers them. Suggest a new rule definition.

Format each finding clearly with:
- The specific log entry (timestamp + tool call)
- What went wrong or what's missing
- Proposed solution (code fix or new rule)

If the session looks clean with no issues found, say so explicitly.`;

  let analysisText = '';

  const queryInstance = query({
    prompt,
    options: {
      cwd: projectRoot,
      model: 'sonnet',
      permissionMode: 'default',
      maxTurns: 20,
      allowedTools: ['Read', 'Glob', 'Grep'],
      systemPrompt: 'You are a security auditor reviewing Claude Code session enforcement logs. Analyze the logs and rule definitions to find enforcement gaps. Be specific and actionable in your findings.',
    },
  });

  for await (const message of queryInstance) {
    if (message.type === 'assistant') {
      const content = (message as any).message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block.type === 'text' && block.text) {
          process.stderr.write(block.text);
          analysisText += block.text;
        } else if (block.type === 'tool_use') {
          console.error(`\n[tool] ${block.name}${block.input?.file_path ? ` ${block.input.file_path}` : ''}`);
        }
      }
    } else if (message.type === 'result') {
      console.error('');
      if (message.subtype !== 'success') {
        console.error('[agent-ruler] AI analysis failed:', message);
      }
    }
  }

  return analysisText;
}

export async function reviewSession(sessionIdOrPath: string, projectRoot: string): Promise<void> {
  let state: SessionState;
  try {
    state = await findSessionLog(sessionIdOrPath);
  } catch (err) {
    const filePath = sessionIdOrPath.includes('/') ? sessionIdOrPath : statePath(sessionIdOrPath);
    console.error(`Error: Could not read session log at ${filePath}`);
    console.error('Make sure the session ID is correct and the session has enforcement logging enabled.');
    process.exit(1);
  }

  if (state.log.length === 0) {
    console.log('No enforcement log entries found for this session.');
    console.log('This session may predate enforcement logging or had no tool calls.');
    return;
  }

  formatReport(state);
  const analysisText = await analyzeWithAI(state, projectRoot);

  const sessionLabel = sessionIdOrPath.includes('/')
    ? path.basename(sessionIdOrPath, '.json')
    : sessionIdOrPath;

  // Always save suggestions to file
  const outPath = `/tmp/agent-ruler-review-${sessionLabel}.md`;
  await fs.writeFile(outPath, analysisText);
  console.error(`\nSuggestions saved to ${outPath}`);

  // Ask user if they want to revise rules now
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  const answer = await new Promise<string>(resolve => {
    rl.question('\nWould you like to revise the rules now? (y/n) ', resolve);
  });
  rl.close();

  if (answer.trim().toLowerCase().startsWith('y')) {
    const sources = await getAllRuleSources(projectRoot);
    const allRulesData = await loadAllRules(sources);
    const allMatches = allRulesData.flatMap(({ source, rules }) =>
      rules.rules.map(rule => ({ rule, source }))
    );
    await fixRules(allMatches, analysisText, projectRoot);
  }
}
