import type { HookEvent, HookResponse, EnforcementLogEntry } from '../types';
import { loadState, saveState } from '../state';
import { getAllRuleSources } from '../storage';
import { enforce } from '../enforce';

export async function handlePostToolUse(event: HookEvent, projectRoot: string): Promise<HookResponse> {
  try {
    const toolName = event.tool_name || '';
    const toolInput = event.tool_input || {};
    const state = await loadState(event.session_id);

    if (toolName === 'Edit') {
      state.editsPerformed = true;
    }

    if (toolName === 'Write') {
      state.filesCreated = true;
      state.editsPerformed = true;
    }

    await saveState(event.session_id, state);

    const sources = await getAllRuleSources(projectRoot);

    // Fallback: if pre-enforcement didn't run for this tool call,
    // run pre-rules now so they aren't silently skipped
    const lastPreEntry = findLastPreEntry(state.log, toolName);
    if (!lastPreEntry) {
      console.error(`[agent-ruler] No pre-entry found for ${toolName}, running pre-rules as fallback`);
      const preResult = await enforce(toolName, toolInput, sources, state, {
        transcriptPath: event.transcript_path,
        sessionId: event.session_id,
        hookEvent: 'pre',
      });

      if (preResult.logEntry) {
        (preResult.logEntry as any).fallback = true;
        state.log.push(preResult.logEntry);
      }

      if (!preResult.allowed) {
        const reasons = preResult.violations.map((v) => v.message).join('; ');
        await saveState(event.session_id, state);
        return { decision: 'block', reason: `[fallback] ${reasons}` };
      }
    }

    // Run post-hook enforcement
    const result = await enforce(toolName, toolInput, sources, state, {
      transcriptPath: event.transcript_path,
      sessionId: event.session_id,
      hookEvent: 'post',
      toolResponse: event.tool_response,
      cwd: event.cwd || projectRoot,
    });

    if (result.logEntry) {
      state.log.push(result.logEntry);
      await saveState(event.session_id, state);
    }

    if (!result.allowed) {
      const reasons = result.violations.map((v) => v.message).join('; ');
      return { decision: 'block', reason: reasons };
    }
  } catch (err) {
    console.error('[agent-ruler] Error in PostToolUse handler, failing open:', err);
  }
  return {};
}

/** Check if there's a recent pre-entry for this tool in the log (within last 5 entries) */
function findLastPreEntry(log: EnforcementLogEntry[], toolName: string): EnforcementLogEntry | undefined {
  const recent = log.slice(-5);
  for (let i = recent.length - 1; i >= 0; i--) {
    if (recent[i].hookEvent === 'pre' && recent[i].toolName === toolName) {
      return recent[i];
    }
  }
  return undefined;
}
