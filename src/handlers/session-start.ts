import type { HookEvent, HookResponse } from '../types';
import { getAllRuleSources, loadAllRules } from '../storage';
import { loadState, saveState } from '../state';

export async function handleSessionStart(event: HookEvent, projectRoot: string): Promise<HookResponse> {
  // Initialize session state
  const state = await loadState(event.session_id).catch(() => ({
    skillsInvoked: [] as string[],
    editsPerformed: false,
    filesCreated: false,
    transcriptOffset: 0,
    log: [] as import('../types').EnforcementLogEntry[],
  }));
  await saveState(event.session_id, state);

  // Find all skills with gate rules
  const sources = await getAllRuleSources(projectRoot);
  const allRules = await loadAllRules(sources);

  const skillGates: { skill: string; description: string }[] = [];
  for (const { rules } of allRules) {
    for (const rule of rules.rules) {
      if (rule.requires_skill) {
        skillGates.push({
          skill: rule.requires_skill,
          description: rule.description,
        });
      }
    }
  }

  // Deduplicate by skill name
  const seen = new Set<string>();
  const unique = skillGates.filter((g) => {
    if (seen.has(g.skill)) return false;
    seen.add(g.skill);
    return true;
  });

  if (unique.length > 0) {
    const lines = unique.map((g) => `- /${g.skill} — ${g.description}`);
    // Output to stderr so it appears as a system message to the agent
    console.error(`[agent-ruler] Available skills to load when working in their domains:\n${lines.join('\n')}`);
  }

  return {};
}
