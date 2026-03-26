# agent-ruler

Rule enforcement system for [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Generates enforceable rules from your `CLAUDE.md` and `SKILL.md` files, then enforces them at runtime via Claude Code hooks.

## How it works

```
CLAUDE.md / SKILL.md files
        │
        ▼
   ┌─────────┐     ┌─────────────┐
   │ compile  │────▶│ rules.json  │
   └─────────┘     │ + checkers/ │
                    └──────┬──────┘
                           │
    Claude Code            ▼
    hook events ──▶ ┌──────────┐
   (Pre/Post/Stop)  │ enforce  │──▶ allow / block
                    └──────────┘
```

1. **Compile** — Reads your project's `CLAUDE.md` and any `SKILL.md` files. Uses Claude to generate a `rules.json` manifest and individual checker scripts (plain TypeScript functions).
2. **Enforce** — Registers as a Claude Code hook on `PreToolUse`, `PostToolUse`, and `Stop` events. Each tool call is tested against matching rules; violations block the call with an explanation.
3. **Revise** — When a checker is too strict or too loose, describe the problem and agent-ruler will regenerate just the affected checker(s).

## Quick start

```bash
# Wire hooks into .claude/settings.json and generate rules
bunx agent-ruler enforce

# That's it — rules are now enforced on every tool call
```

## Commands

| Command | Description |
|---------|-------------|
| `enforce` | Install hooks into `.claude/settings.json` and generate rules |
| `compile [--force]` | Generate/regenerate checker scripts from `CLAUDE.md` and `SKILL.md` |
| `revise <target> <msg>` | Fix checker(s) — target: rule-id, skill-name, `claude.md`, or `all` |
| `resign` | Remove hooks from `.claude/settings.json` (keeps rules intact) |
| `verify` | Verify all rules load and checkers compile |
| `test [--hook pre\|post\|stop] <json>` | Test enforcement against a tool call |
| `status` | Show rule sources and staleness |
| `review <session-id>` | Review a session's enforcement log for false negatives |
| `hook` | Run as hook (reads HookEvent from stdin) — used internally |

## Usage examples

```bash
# Generate rules for stale sources only
bunx agent-ruler compile

# Force-regenerate all rules
bunx agent-ruler compile --force

# Check what rules exist and if they're up to date
bunx agent-ruler status

# Test a tool call against rules without running Claude Code
bunx agent-ruler test '{"tool_name":"Bash","tool_input":{"command":"npm install"}}'

# Test a post-tool-use event
bunx agent-ruler test --hook post '{"tool_name":"Write","tool_input":{"file_path":"src/index.ts"}}'

# Fix a checker that's too broad
bunx agent-ruler revise find-code "gate checker is too broad, matches piped head/tail"

# Fix all checkers with a global directive
bunx agent-ruler revise all "checkers should handle missing fields gracefully"

# Remove hooks (rules stay on disk)
bunx agent-ruler resign

# Verify all checkers load and return valid results
bunx agent-ruler verify
```

## How rules are generated

Each rule source (`CLAUDE.md` or `SKILL.md`) is parsed and sent to Claude, which produces:

- **rules.json** — A manifest of rules with IDs, descriptions, tool matchers, and metadata.
- **checkers/** — One TypeScript file per rule, exporting a `check(toolInput, context?)` function that returns `{ pass: boolean; message?: string }`.

Rules are stored under `.claude/agent-ruler/` in your project directory. Checkers are plain functions with no external dependencies — they run fast and can be reviewed/edited by hand.

## Rule types

- **Pre-tool-use** — Runs before a tool executes. Can block the call.
- **Post-tool-use** — Runs after a tool executes. Can flag violations after the fact.
- **Stop** — Runs when the agent is about to stop. Validates the session as a whole.
- **Skill gates** — Blocks tool calls unless a specific skill has been invoked first.

## Development

```bash
cd agent-ruler
bun install
bun test
bun run build    # outputs to dist/
```

## License

Apache 2.0 — see [LICENSE](./LICENSE).
