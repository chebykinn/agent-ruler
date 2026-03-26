import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import type { RulesFile, RuleSource } from './types';

export async function hashFile(filePath: string): Promise<string> {
  const content = await fs.readFile(filePath, 'utf-8');
  return crypto.createHash('sha256').update(content).digest('hex');
}

export function discoverRuleSources(projectRoot: string): RuleSource[] {
  return [
    {
      sourcePath: path.join(projectRoot, 'CLAUDE.md'),
      rulesJsonPath: path.join(projectRoot, '.claude/agent-ruler/rules.json'),
      checkersDir: path.join(projectRoot, '.claude/agent-ruler'),
      label: 'CLAUDE.md',
    },
  ];
}

export async function discoverSkillSources(projectRoot: string): Promise<RuleSource[]> {
  const sources: RuleSource[] = [];
  const skillsDir = path.join(projectRoot, '.claude/skills');

  try {
    const entries = await fs.readdir(skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillMdPath = path.join(skillsDir, entry.name, 'SKILL.md');
      try {
        await fs.access(skillMdPath);
        sources.push({
          sourcePath: skillMdPath,
          rulesJsonPath: path.join(skillsDir, entry.name, 'scripts/agent-ruler/rules.json'),
          checkersDir: path.join(skillsDir, entry.name, 'scripts/agent-ruler'),
          label: `skill:${entry.name}`,
        });
      } catch {
        // No SKILL.md in this directory
      }
    }
  } catch {
    // No skills directory
  }

  return sources;
}

export async function getAllRuleSources(projectRoot: string): Promise<RuleSource[]> {
  const base = discoverRuleSources(projectRoot);
  const skills = await discoverSkillSources(projectRoot);
  return [...base, ...skills];
}

export async function loadRulesFile(rulesJsonPath: string): Promise<RulesFile | null> {
  try {
    const content = await fs.readFile(rulesJsonPath, 'utf-8');
    return JSON.parse(content) as RulesFile;
  } catch {
    return null;
  }
}

export async function isStale(source: RuleSource): Promise<boolean> {
  const existing = await loadRulesFile(source.rulesJsonPath);
  if (!existing) return true;

  try {
    const currentHash = await hashFile(source.sourcePath);
    return currentHash !== existing.source_hash;
  } catch {
    // Source file doesn't exist — can't generate rules
    return false;
  }
}

export async function getStaleSources(sources: RuleSource[]): Promise<RuleSource[]> {
  const results = await Promise.all(
    sources.map(async (source) => ({
      source,
      stale: await isStale(source),
    }))
  );
  return results.filter((r) => r.stale).map((r) => r.source);
}

export async function loadAllRules(sources: RuleSource[]): Promise<{ source: RuleSource; rules: RulesFile }[]> {
  const loaded: { source: RuleSource; rules: RulesFile }[] = [];
  for (const source of sources) {
    const rules = await loadRulesFile(source.rulesJsonPath);
    if (rules) {
      loaded.push({ source, rules });
    }
  }
  return loaded;
}
