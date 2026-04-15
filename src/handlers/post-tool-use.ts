import type { HookEvent, HookResponse } from '../types';
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

    // Run post-hook enforcement (most rules now default to post)
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
      // Structure feedback as corrective guidance
      const feedback = result.violations.map((v) => {
        if (v.rule.requires_skill) {
          return `This operation is in the domain of the "${v.rule.requires_skill}" skill. Run /${v.rule.requires_skill} first, then continue.`;
        }
        return v.message;
      });
      return { decision: 'block', reason: `[agent-ruler] Fix needed after ${toolName}:\n${feedback.join('\n')}` };
    }
  } catch (err) {
    console.error('[agent-ruler] Error in PostToolUse handler, failing open:', err);
  }
  return {};
}
