import * as fs from 'fs/promises';
import type { SessionState } from './types';

function statePath(sessionId: string): string {
  return `/tmp/agent-ruler-${sessionId}.json`;
}

const DEFAULT_STATE: SessionState = {
  skillsInvoked: [],
  editsPerformed: false,
  filesCreated: false,
  transcriptOffset: 0,
  log: [],
};

export async function loadState(sessionId: string): Promise<SessionState> {
  try {
    const content = await fs.readFile(statePath(sessionId), 'utf-8');
    const state = JSON.parse(content) as SessionState;
    // Backcompat: add missing fields
    if (state.transcriptOffset === undefined) state.transcriptOffset = 0;
    if (!Array.isArray(state.log)) state.log = [];
    return state;
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export async function saveState(sessionId: string, state: SessionState): Promise<void> {
  await fs.writeFile(statePath(sessionId), JSON.stringify(state, null, 2));
}

/**
 * Incrementally scan the session transcript for new Skill invocations.
 * Only reads bytes after the last known offset, so it's fast for long sessions.
 */
export async function syncSkillsFromTranscript(
  transcriptPath: string,
  state: SessionState
): Promise<boolean> {
  let changed = false;
  try {
    const handle = await fs.open(transcriptPath, 'r');
    const stat = await handle.stat();
    const size = stat.size;

    if (size <= state.transcriptOffset) {
      await handle.close();
      return false;
    }

    const buf = Buffer.alloc(size - state.transcriptOffset);
    await handle.read(buf, 0, buf.length, state.transcriptOffset);
    await handle.close();

    const chunk = buf.toString('utf-8');
    const lines = chunk.split('\n').filter(Boolean);

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.type !== 'assistant' || !entry.message?.content) continue;
        for (const block of entry.message.content) {
          if (block.type === 'tool_use' && block.name === 'Skill' && block.input?.skill) {
            const skillName = block.input.skill as string;
            if (!state.skillsInvoked.includes(skillName)) {
              state.skillsInvoked.push(skillName);
              changed = true;
            }
          }
        }
      } catch {
        // skip malformed lines
      }
    }

    state.transcriptOffset = size;
    changed = true; // offset changed at minimum
  } catch {
    // transcript not readable
  }
  return changed;
}
