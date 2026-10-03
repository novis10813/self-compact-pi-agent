# self-compact

The Pi (v0.85.1) extension. The story, the demo, and the install steps are in the [root README](../../README.md). This page is the reference.

## Run

```bash
pi -e extensions/self-compact/self-compact.ts                                                  # shipped defaults: 10% / 20% / 30%
pi -e extensions/self-compact/self-compact.ts --compact-soft-at 15% --compact-at 40% --compact-buffer 5%
pi -e extensions/self-compact/self-compact.ts --compact-soft-at 100k --compact-at 200k --compact-buffer 50k
```

| Flag | Meaning | Default |
| --- | --- | --- |
| `--compact-soft-at` | notice line: awareness only, nothing changes | `10%` |
| `--compact-at` | warning line: time to write a note and compact soon | `20%` |
| `--compact-buffer` | allowance above the warning before every other tool is blocked (`0` = block at the warning) | `10%` (hard cutoff 30%) |
| `--compact-prompt` | literal text that replaces the compaction summary system prompt | unset |

CLI values are percentages of the model window (`20%`) or token counts (`270000`, `100k`, `1.5m`). In legacy CLI mode the hard cutoff is `min(warning + buffer, 90% of the window)`. Defaults live in `extensions/self-compact/defaults.ts`.

## Global settings

Add `selfCompact` to `~/.pi/agent/settings.json` (or the agent directory selected by `PI_CODING_AGENT_DIR`):

```json
{
  "selfCompact": {
    "noticeAt": "10%",
    "warningAt": "20%",
    "hardAt": "30%"
  }
}
```

Percentage strings refer to the active model's context window. Integer numbers are absolute token counts, and the two units can be mixed:

```json
{
  "selfCompact": {
    "noticeAt": 50000,
    "warningAt": 100000,
    "hardAt": 120000
  }
}
```

Token numbers must be non-negative safe integers. String token counts (`"50000"`) and k/m suffixes are CLI-only, not settings values. Missing settings fields default to 10%, 20%, and 30%. Only global settings are read. Project `.pi/settings.json` does not override this section, and Pi's own `compaction` settings remain independent.

`hardAt` is a direct threshold, not a buffer above `warningAt`. Thresholds must satisfy `noticeAt <= warningAt <= hardAt`. The hard cutoff is capped at 90% of the window with a diagnostic note. A warning above that cap is rejected. Percentages re-resolve on model changes, while token counts stay fixed and may become invalid on a smaller model.

CLI flags take priority per field: `--compact-soft-at` overrides `noticeAt`, and `--compact-at` overrides `warningAt`. An explicit `--compact-buffer` replaces direct `hardAt` with warning + buffer. Without a configured `hardAt`, an explicit `--compact-at` retains the legacy warning + default buffer behavior. With no `selfCompact` section, all previous CLI behavior is preserved.

Settings are read at session start, session switch, tree navigation, or extension reload. `/self-compact-info` reports effective values, sources and errors. Invalid settings or flags block ordinary tools until fixed and reloaded, but `view_context` remains available. This configuration does not change or integrate with the footer.

## Tools and commands

- `self_compact(note_to_self)`: saves the note (1 to 24,000 chars), ends the run, compacts once idle, returns the note verbatim as the next message. Refuses when Pi would find nothing to compact (the session still fits inside `keepRecentTokens`).
- `view_context()`: the agent's own gauge as JSON: used tokens, percent, window, level, the three thresholds, tokens left before each, lock state, cycle count. Allowed even while other tools are locked.
- `/self-compact-info`: settings, resolved thresholds, usage, state, cycles, prompt sources, pending note. No model turn.
- `/self-compact-now`: asks the agent to write its note and call `self_compact` (reuses a saved note on retry). Built-in `/compact` is untouched and uses the same summary prompt.

## Prompt files

`.pi/self-compact/` is looked up in the current directory first, then next to this app. Files are read fresh on every use.

| File | When the model sees it |
| --- | --- |
| `USER_PROMPT_SOFT_SELF_COMPACT.md` | transient message on each call past the notice line |
| `USER_PROMPT_WARNING_SELF_COMPACT.md` | transient message on each call past the warning line |
| `USER_PROMPT_COMPACTION_MESSAGE.md` | system prompt of the summary call (`--compact-prompt` overrides it) |
| `USER_PROMPT_SUMMARY_INSTRUCTIONS.md` | optional: replaces Pi's user instructions for the summary call |

Placeholders: `{{used_tokens}}`, `{{used_percent}}`, `{{context_window}}`, `{{cached_tokens}}`, `{{soft_tokens}}`, `{{soft_percent}}`, `{{warning_tokens}}`, `{{warning_percent}}`, `{{forced_tokens}}`, `{{forced_percent}}`, `{{remaining_to_forced}}`, `{{cycle}}`, `{{note_max_chars}}`. Each threshold crossing also prints the rendered message once in the TUI. Empty or unreadable override files report an error instead of silently falling back.

## Tests

```bash
npm run test:unit            # thresholds, bar, prompts, recovery reducer
npm run test:parity          # the extension through Pi's loader with a fake session
npm run test:e2e             # real `pi --mode rpc` with a scripted provider, zero API cost
SC_REAL=1 npm run test:real  # live model; SC_REAL_MODEL picks it (just real uses openrouter/deepseek/deepseek-v4.1-flash)
bash scripts/verify.sh       # all of the above plus a tmux footer capture; logs in verification/ (gitignored)
```

No npm dependencies: Pi's loader supplies its packages at runtime and Node 24 strips types for the tests.

## Layout

```
extensions/self-compact/
  self-compact.ts   entry: flags, tools, commands, events, footer, handoff
  defaults.ts       shipped thresholds (10% / 20% / 30%) and the 90% cap
  thresholds.ts     parse (tokens / k / m / %), validate, resolve against the window, level
  context-bar.ts    20-cell bar renderer
  prompts.ts        prompt lookup, templating, precedence, built-in fallbacks
  summary.ts        native compaction call with the replacement prompt; nothing-to-compact check
  state.ts          state snapshot, durable handoff id, recovery reducer
.pi/self-compact/   the prompt files above
tests/              unit, parity, harness (scripted provider, RPC client), e2e
scripts/            verify.sh, tui-smoke.sh
```
