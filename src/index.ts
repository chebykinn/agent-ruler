import type { HookEvent, HookResponse } from './types';
import { handleSessionStart } from './handlers/session-start';
import { handleUserPromptSubmit } from './handlers/user-prompt-submit';
import { handlePreToolUse } from './handlers/pre-tool-use';
import { handlePostToolUse } from './handlers/post-tool-use';
import { handleStop } from './handlers/stop';
import { resolveProjectRoot } from './project';

async function main(): Promise<void> {
  const input = await Bun.stdin.text();

  let event: HookEvent;
  try {
    event = JSON.parse(input) as HookEvent;
  } catch {
    console.error('[agent-ruler] Failed to parse stdin as JSON');
    process.exit(0);
  }

  const projectRoot = resolveProjectRoot();
  let response: HookResponse = {};

  switch (event.hook_event_name) {
    case 'SessionStart':
      response = await handleSessionStart(event, projectRoot);
      break;
    case 'UserPromptSubmit':
      response = await handleUserPromptSubmit(event, projectRoot);
      break;
    case 'PreToolUse':
      response = await handlePreToolUse(event, projectRoot);
      break;
    case 'PostToolUse':
      response = await handlePostToolUse(event, projectRoot);
      break;
    case 'Stop':
      response = await handleStop(event, projectRoot);
      break;
  }

  if (response.decision) {
    console.log(JSON.stringify(response));
  }
}

main().catch((err) => {
  console.error('[agent-ruler] Fatal error:', err);
  process.exit(0);
});
