import type { HookEvent, HookResponse } from '../types';
import { getAllRuleSources, loadAllRules } from '../storage';
import { loadState, saveState, syncSkillsFromTranscript } from '../state';

export async function handleUserPromptSubmit(event: HookEvent, projectRoot: string): Promise<HookResponse> {
  const prompt = event.prompt || '';
  if (!prompt) return {};

  const state = await loadState(event.session_id).catch(() => ({
    skillsInvoked: [] as string[],
    editsPerformed: false,
    filesCreated: false,
    transcriptOffset: 0,
    log: [] as import('../types').EnforcementLogEntry[],
  }));

  // Sync skills from transcript in case some were already loaded
  if (event.transcript_path) {
    const changed = await syncSkillsFromTranscript(event.transcript_path, state);
    if (changed) {
      await saveState(event.session_id, state);
    }
  }

  const sources = await getAllRuleSources(projectRoot);
  const allRules = await loadAllRules(sources);

  // Collect skill gates where the skill hasn't been loaded yet
  const suggestions: { skill: string; description: string }[] = [];
  const seen = new Set<string>();

  for (const { rules } of allRules) {
    for (const rule of rules.rules) {
      if (!rule.requires_skill) continue;
      if (state.skillsInvoked.includes(rule.requires_skill)) continue;
      if (seen.has(rule.requires_skill)) continue;

      // Run a lightweight keyword match against the prompt to predict relevance
      if (isSkillRelevant(rule.requires_skill, rule.description, prompt)) {
        seen.add(rule.requires_skill);
        suggestions.push({
          skill: rule.requires_skill,
          description: rule.description,
        });
      }
    }
  }

  if (suggestions.length > 0) {
    const lines = suggestions.map((s) => `- /${s.skill} — ${s.description}`);
    // Output to stderr as guidance to the agent
    console.error(`[agent-ruler] Based on your request, consider loading these skills first:\n${lines.join('\n')}`);
  }

  return {};
}

/** Simple keyword-based relevance check between a skill and the user's prompt */
function isSkillRelevant(skillName: string, description: string, prompt: string): boolean {
  const lower = prompt.toLowerCase();

  // Build keyword sets from skill name and description
  const keywords = new Set<string>();

  // Add skill name parts (e.g., "code-style" → ["code", "style"])
  for (const part of skillName.split('-')) {
    if (part.length > 2) keywords.add(part);
  }

  // Add significant words from description
  const stopWords = new Set(['the', 'and', 'for', 'that', 'this', 'with', 'from', 'are', 'was', 'not', 'but', 'has', 'have', 'will']);
  for (const word of description.toLowerCase().split(/\W+/)) {
    if (word.length > 3 && !stopWords.has(word)) {
      keywords.add(word);
    }
  }

  // Check if any keywords appear in the prompt
  for (const kw of keywords) {
    if (lower.includes(kw)) return true;
  }

  // Broad heuristic: if prompt mentions editing/changing/fixing code, code-style is relevant
  if (skillName === 'code-style' && /\b(edit|change|fix|refactor|update|modify|implement|add|create|write)\b/i.test(prompt)) {
    return true;
  }

  // If prompt mentions types/typescript, type-check is relevant
  if (skillName === 'type-check' && /\b(type|typescript|tsc|typecheck)\b/i.test(prompt)) {
    return true;
  }

  return false;
}
