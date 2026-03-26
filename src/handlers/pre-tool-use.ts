import type { HookEvent, HookResponse } from '../types';
import { getAllRuleSources, getStaleSources } from '../storage';
import { generateRules } from '../generate';
import { enforce } from '../enforce';
import { loadState, saveState, syncSkillsFromTranscript } from '../state';

export async function handlePreToolUse(event: HookEvent, projectRoot: string): Promise<HookResponse> {
  const toolName = event.tool_name || '';
  const toolInput = event.tool_input || {};

  // Never block Skill tool calls (prevents deadlock)
  if (toolName === 'Skill') {
    return {};
  }

  const state = await loadState(event.session_id).catch(
    () => ({ skillsInvoked: [], editsPerformed: false, filesCreated: false, transcriptOffset: 0, log: [] as import('../types').EnforcementLogEntry[] })
  );

  try {
    const sources = await getAllRuleSources(projectRoot);

    // Regenerate stale sources — isolated so generation failures
    // don't kill enforcement of existing rules
    try {
      const stale = await getStaleSources(sources);
      if (stale.length > 0) {
        await generateRules(stale, projectRoot);
      }
    } catch (genErr) {
      console.error('[agent-ruler] Rule generation failed (enforcing with existing rules):', genErr);
    }

    // Sync skills from transcript (Skill tool doesn't trigger hooks)
    if (event.transcript_path) {
      const changed = await syncSkillsFromTranscript(event.transcript_path, state);
      if (changed) {
        await saveState(event.session_id, state);
      }
    }

    const result = await enforce(toolName, toolInput, sources, state, {
      transcriptPath: event.transcript_path,
      sessionId: event.session_id,
      hookEvent: 'pre',
    });

    if (result.logEntry) {
      state.log.push(result.logEntry);
      await saveState(event.session_id, state);
    }

    if (!result.allowed) {
      const reasons = result.violations.map((v) => v.message).join('; ');
      return { decision: 'block', reason: reasons };
    }

    return {};
  } catch (err) {
    // Fail open — but record the error so it's visible in enforcement logs
    console.error('[agent-ruler] Error in PreToolUse handler, failing open:', err);
    const errorEntry: import('../types').EnforcementLogEntry = {
      timestamp: new Date().toISOString(),
      hookEvent: 'pre',
      toolName,
      toolInput,
      rulesChecked: [],
      violations: [],
    };
    (errorEntry as any).error = String(err);
    state.log.push(errorEntry);
    try { await saveState(event.session_id, state); } catch {}
    return {};
  }
}
