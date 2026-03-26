import type { HookEvent, HookResponse } from '../types';
import { loadState, saveState } from '../state';
import { getAllRuleSources } from '../storage';
import { enforce } from '../enforce';

export async function handleStop(event: HookEvent, projectRoot: string): Promise<HookResponse> {
  try {
    const state = await loadState(event.session_id);

    // Run stop-hook enforcement (e.g. missed typecheck, missed tests)
    const sources = await getAllRuleSources(projectRoot);
    const result = await enforce('.*', {}, sources, state, {
      transcriptPath: event.transcript_path,
      sessionId: event.session_id,
      hookEvent: 'stop',
      cwd: event.cwd || projectRoot,
      sessionState: state,
    });

    if (result.logEntry) {
      state.log.push(result.logEntry);
      await saveState(event.session_id, state);
    }

    if (!result.allowed) {
      const reasons = result.violations.map((v) => v.message).join('; ');
      return {
        decision: 'block',
        reason: reasons,
      };
    }
  } catch (err) {
    console.error('[agent-ruler] Error in Stop handler, failing open:', err);
  }
  return {};
}
