import { describe, test, expect } from 'bun:test';
import { buildUserPrompt, buildSystemPrompt } from './prompt';
import type { Rule, RuleSource } from './types';

const source: RuleSource = {
  sourcePath: '/tmp/test/SKILL.md',
  rulesJsonPath: '/tmp/test/scripts/agent-ruler/rules.json',
  checkersDir: '/tmp/test/scripts/agent-ruler',
  label: 'skill:code-style',
};

const makeRule = (overrides: Partial<Rule> = {}): Rule => ({
  id: 'test-rule',
  source: 'SKILL.md',
  description: 'Test rule description',
  tool_matcher: '.*',
  checker: 'test-rule.ts',
  activated_by_skill: null,
  required_skills: [],
  requires_skill: null,
  message: 'Test rule violated',
  source_instruction: 'Always use semicolons',
  ...overrides,
});

describe('buildUserPrompt', () => {
  test('with no previous rules, omits previous section', () => {
    const result = buildUserPrompt(source, 'abc123', []);
    expect(result).not.toContain('Previously extracted rules');
    expect(result).toContain(source.sourcePath);
    expect(result).toContain(source.checkersDir);
    expect(result).toContain('abc123');
  });

  test('with previous rules, includes rule IDs and source_instructions', () => {
    const rules = [
      makeRule({ id: 'no-console', checker: 'no-console.ts', source_instruction: 'Never use console.log' }),
      makeRule({ id: 'use-const', checker: 'use-const.ts', source_instruction: 'Prefer const over let' }),
    ];
    const result = buildUserPrompt(source, 'abc123', rules);

    expect(result).toContain('Previously extracted rules');
    expect(result).toContain('**no-console**');
    expect(result).toContain('(checker: no-console.ts)');
    expect(result).toContain('"Never use console.log"');
    expect(result).toContain('**use-const**');
    expect(result).toContain('"Prefer const over let"');
    expect(result).toContain('NEW instructions');
  });

  test('falls back to description when source_instruction is empty', () => {
    const rules = [
      makeRule({ id: 'old-rule', source_instruction: '', description: 'Fallback description' }),
    ];
    const result = buildUserPrompt(source, 'abc123', rules);
    expect(result).toContain('"Fallback description"');
  });

  test('includes diff instructions for keep/delete/create', () => {
    const rules = [makeRule()];
    const result = buildUserPrompt(source, 'abc123', rules);

    expect(result).toContain('instruction still exists in the source');
    expect(result).toContain('instruction was removed from the source');
    expect(result).toContain('NEW instructions in the source not covered');
  });
});

describe('buildSystemPrompt', () => {
  test('includes source_instruction in rules.json format', () => {
    const result = buildSystemPrompt();
    expect(result).toContain('source_instruction');
    expect(result).toContain('verbatim instruction text');
  });
});
