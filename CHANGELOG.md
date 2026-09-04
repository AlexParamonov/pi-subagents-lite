# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **Tool count marker renders reliably across terminal fonts.** Replaced the forced text-presentation emoji with a one-cell text symbol, avoiding the Unicode replacement glyph when that text variant is unavailable.
- **Subagent `max_tokens` injection follows pi's compat chain.** When an agent sets `max_tokens`, the injected provider field is now resolved exactly like pi resolves it: an explicit `model.compat.maxTokensField` wins, otherwise the field is auto-detected from the provider name and baseUrl (the provider families that use `max_tokens`), defaulting to `max_completion_tokens`. Previously the extension defaulted to `max_tokens` whenever the model's compat was silent, so custom models (e.g. `opencode-go` models absent from the generated catalog) sent `max_tokens` where pi sends `max_completion_tokens` and the provider rejected the request with `unknown parameter max_tokens`. The compat chain applies to openai-completions models and is resolved per request, so mid-run model changes stay in sync with pi's base params; models on other APIs keep the previous `max_tokens` injection.

## [1.13.0] - 2026-08-20

### Added

- **Agent `color` frontmatter.** Agent `.md` files can set `color: <named-color>` or `color: #RRGGBB` in frontmatter. The agent's status icon is tinted with that color across all UI surfaces, including widget connector lines and a new toggle in General settings.
- **Background agent status indicators.** When an agent is scheduled to run in the background, the UI now clearly shows its status in the call-line icon: `◆` (accent) when queued, `◈` (accent) when running, `✓` (success) when completed or turn-limited, `✗` (error) on error or abort, and `■` (dim) when stopped; foreground call lines show `▸`. The result line shows the model tag and stats for finished foreground agents and the description only for background agents (icon lives in the call line). Live status updates via invalidation map — the icon flips as the agent progresses.
- **Model picker prioritizes configured models.** The model picker (via `/model`, model settings, concurrency settings, and spawn wizard) now shows models sorted: current model first, then models from `subagents-lite.json` agent config (default + per-type overrides), then all remaining models. This makes configured models easy to find without searching. Search/filter still works correctly with the new sort order.

### Changed

- **Flattened settings menu.** Reworked setting menu into 5 top-level categories for easier navigation.
- **Unified agent status icons across all UI surfaces.** Tool call lines, the subagent status widget, and the conversation viewer now share one status→icon map (`statusIcon` in `format.ts`): `◆` queued, `◈` running, `✓` completed (success), `✓` turn-limited (warning), `✗` error/aborted, `■` stopped (dim), `▸` when no status yet.

## [1.12.0] - 2026-08-15

### Added

- **Restart last agents from debug menu.** A new "Restart last agents" command in the debug menu finds the most recent Agent tool call(s) in session history and replays them, spawning fresh agents with the same configuration. Useful when agents are cancelled by mistake or lost after reload. Running agents are skipped. Uses current config model (not historical) and spawns as background for steer support.
- **Limit-bounded AgentStatus output.** The AgentStatus tool now always lists in-progress agents (running, queued) and then shows settled agents (completed, turn_limited, aborted, stopped, error) most-recently-settled first, capped at `agentStatusLimit` settled agents; when settled agents are hidden, the output ends with "and N more settled agents". The new `agentStatusLimit` config key (Widget settings > Behavior, numeric entry) defaults to 0 = auto: 2 × the configured default concurrency (8 at the built-in default of 4), so the cap scales with how many agents can run at once. Records are unaffected — the limit only changes what the tool prints.
- **ext/none syntax suppresses extension warning.** Agent tool configs can now use `ext/none` in the tools list to explicitly register zero extension tools, suppressing the warning about missing extensions. Previously `tools: []` meant zero built-in tools but extensions were still warned about; `ext/none` now makes the intent explicit.

### Changed

- **No explicit `any` type usage remains in test code.** `typecheck` already covered `test/`; every explicit `any` annotation across the test suite is now replaced with the real `src/` or pi-package type, or with a structural fake asserted at a single call boundary. Type-level only: all 1592 tests behave identically.
- **Test `any` regression gate.** `npm run test:any-gate` scans `test/` for explicit `any` annotations and fails if any are found (whitelisting the two documented load-bearing sites and `expect.any(...)` vitest matchers). Import specifiers in test files unified to `.js` (no `.ts` extensions in import paths).
- **Typed test context helpers.** `fakeCtx()` and `createMockCtx()` in `test/fixtures.ts` now return properly typed `ExtensionContext` / `ExtensionCommandContext` with typed defaults and an options parameter for overrides, eliminating the two documented `any` return annotations.
- **`subscribeToSessionEvents` annotation corrected.** The function's parameter type now references `RunCallbacks` (the interface that defines the callback keys) instead of `RunOptions` (which carries extra fields the function never reads). Purely defensive; no call sites changed.
- **TypeScript 7 toolchain and test typechecking.** The development toolchain now uses TypeScript 7.0.2 (the native compiler, `tsc`); the package swap is behavior-neutral for the extension itself. `npm run typecheck` now covers `test/` as well as `src/` (tests were previously transpiled by vitest but never typechecked); the type errors this surfaced were fixed in test code only (stale mock typings, fixtures, and imports), with no change to extension behavior.
- **Subagents honor pi's `defaultTools` setting.** Agent types without explicit tool config now use pi's `defaultTools` (global `~/.pi/agent/settings.json` + project `.pi/settings.json`) as their registered built-in tool set. Unconfigured keeps the hardcoded `read`/`bash`/`edit`/`write` set, explicit `[]` means zero built-in tools, and explicit agent tool config (whitelist, `exclude_tools`, `tools: false`, read-only sets) still wins. Extension tools remain always-enabled. On pi < 0.84.2 the setting is honored via the merged-settings read; only the `getDefaultTools` API is missing (pi ≤ 0.84.1 lacks the accessor — 0.84.2 ships it — so the read feature-detects and falls back to the merged settings field).
- **Model settings grouped by resolved model.** Per-type overrides are grouped alphabetically by the model they resolve to; each row shows the spawn-effective (clamped) thinking level and the winning layer's tag (`[session]`/`[project]`, global-won rows untagged). Only explicit per-type overrides are listed; frontmatter-only and inheriting types stay hidden (hint arrows gone). The session default is a session-wide override that beats config per-type overrides and frontmatter models. Concurrency settings share the style: rows set targets inline with a nested Clear, section headers in bold accent, and clear/remove pickers offer only the levels that carry the setting ("All levels" only when at least two do), and `j`/`k` navigate list submenus.
- **Debug menu shows each agent type's effective tool set.** The Agent types listing and the Agent briefing now display the tools an agent actually gets: the explicit `registeredTools` when configured, otherwise pi's `defaultTools` setting, otherwise the hardcoded `read`/`bash`/`edit`/`write` set. The generic "all built-in tools" placeholder is gone, the briefing always includes a Tools line, and an explicitly empty set renders as `(none)`. The menu reads `defaultTools` through the same version-tolerant accessor as the spawn path, so the two displays and the session gate cannot diverge. `tools: []` in an agent config now means zero built-in tools everywhere — no consumer silently falls back to the default set.

### Fixed

- **Agent tool error display shows ✗ instead of ✓.** Agent and StopAgent tools now throw on errors instead of returning `errorResult()`, matching how built-in tools (bash, edit, read, write) handle errors. Agent-loop's catch block sets `isError: true`, so the renderResult callbacks use `context?.isError` (from the agent-loop's correct error flag) instead of `result.isError`, which is absent from the production data flow. Failed tool calls now correctly display a red cross (✗) and error background color.
- **nanoid bumped to 3.3.18.** The dev-only transitive dependency (via postcss) is now locked at 3.3.18, clearing the high-severity `npm audit` finding for nanoid's zero-size generator loop (GHSA-2v37-7h3g-55p8). No runtime or extension behavior change.
- **Agents status line stays visible for the session.** The status line's visibility is now: after the last agent finishes and its row ages out, the line keeps showing the session done count and cost in its dimmed form, and it hides only when no agent records exist.
- **Git-root discovery during skill loading is constant-time per ancestor level.** `findGitRoot` now probes `.git` with a single `existsSync` per level instead of reading the full directory listing
- **Tool-argument summaries truncate with the ellipsis character.** Long single string arguments to arbitrary tools now end with `…` (U+2026) like bash commands, instead of three ASCII dots.
- **Write-tool summaries show the real file path.** `summarizeToolArgs` now reads the `path` argument key that pi's write tool actually sends, so summaries render as `write("/path/to/file", N chars)` instead of `write("", N chars)`.

## [1.11.0] - 2026-08-14

### Added

- **Parent interrupt forwarding.** Foreground subagents are now bound to the parent's interrupt signal. Stopping the parent stops all foreground children. Background agents are not affected.
- **Project-level config.** `.pi/subagents-lite.json` in a trusted project is an override layer over the global `~/.pi/agent/subagents-lite.json`: it may hold only model and concurrency settings, and each key it sets overrides the global value; clearing a project value falls back to global. `/agents` menu changes now pick a write target — session, global, or project — and persist only that level's keys; the merged config is never written to a file. Unknown keys in a hand-edited project file are ignored with a warning; a malformed project file is ignored and the project level is not offered. Loaded only in trusted projects, same as `.pi/agents`.
- **Agent menu clear actions.** Individual `Clear` action removes a settled agent. `Clear all`/`Clear done` bulk-removes all/done agents from the widget.
- **Time-based finished retention.** Replaced turn-based eviction with a configurable time window. Finished agents stay visible for `finishedRetentionMinutes` (default 1 min) instead of a fixed number of turns.
- **Transient transport error retry.** Brief stream failures (ECONNRESET, EPIPE, ETIMEDOUT, EAI_AGAIN) are retried automatically instead of failing the run.
- **Continue settled agents.** `steer()` now resumes a settled agent (completed, errored, aborted, stopped, turn-limited) that still has a live session, instead of requiring a re-spawn. The viewer footer/composer switches from "steer" to "continue" for settled agents.
- **Per-agent context and prompt inclusion.** New `include_context_files` and `include_system_prompt` frontmatter fields on agent definition files override the global settings per agent: whether AGENTS.md/CLAUDE.md context files load as `<project_context>`, and whether the parent's system prompt is included (inherit, replace, or global mode).
- **Stop notes for never-started agents.** Agents stopped before they started (queued stop, aborted spawn) now report that the task was NOT attempted instead of claiming partial output. Applies to tool results and background nudges.

### Removed

- **`effectiveDefault` from the model-groups builder result.** `buildModelGroups` no longer computes or returns an `effectiveDefault` field: no production code consumed it (the menu derives the default row from the config snapshot's own `default` key), and it duplicated the menu's local `effectiveDefault` under a different meaning. The `ModelGroups` interface and its tests no longer reference it.
- **`deltaInputTokens` setting and delta estimation.** Removed the vLLM-specific workaround that estimated input token deltas by subtracting consecutive `usage.input` values.

### Changed

- **Running Agents menu bulk actions grouped.** The stop row sits above the clear-actions group.
- **Case-insensitive agent type resolution.** The `Agent` tool's `agent` parameter now resolves type names case-insensitively: the exact registered name wins; a single case-insensitive match resolves; two types differing only by case produce an error naming both candidates instead of a silent pick, and nothing spawns. Applies to the initial lookup, the mid-session re-scan, and worktree-targeted spawns.

### Fixed

- **Model settings per-type provenance tag.** When the session default shadows a project key, the per-type row now shows `[session]` (the value's true source) instead of a misleading `[project]`.
- **Spawn options menu refreshes after a change.** Setting or clearing any spawn option now rebuilds the row immediately, so "Default max turns" and "Default thinking level" show their new value and `[project]` tag without reopening the menu.
- **Default concurrency limit removable per target.** The "Default concurrency limit" row now offers Edit limit / Remove limit like the per-provider and per-model rows, so the value can be cleared at the chosen level (session, global, project, or all) and fall through to the next layer.
- **Default max turns clearable per target.** The "Default max turns" row's target picker now offers "Clear...", leading to a nested per-level picker (global, project, or all levels) so the value can be removed at a chosen level and fall through to the next layer, instead of requiring an empty submission.
- **Model settings "Set globally" label aligned.** The entry now reads "Set globally (saves to config)", matching the target picker's "saves to" phrasing.
- **Target-picker wording.** The global and project entries now read "Global (saves to config)" / "Project (saves to project config)", parallel with "Session (not saved)".

- **"(inherits parent)" no longer stored as a model value.** In the Model Settings menu, picking "(inherits parent)" now deletes the key at the chosen level (session, global, or project) instead of persisting the literal sentinel string into the config file or session overrides; the effective model falls through to the next layer.
- **"All levels" clears never create a project file.** Clearing a model or concurrency key at all levels in a trusted project without `.pi/subagents-lite.json` previously wrote an empty project file out of nothing. A clear now skips the project layer entirely when no project file exists (only a set creates the file); an existing project file keeps today's behavior.

- **Conversation viewer freeze from running agents menu.** Viewer overlay now uses `{ overlay: true }` so closing it restores the menu instead of clobbering it and freezing all input.
- **View result bottom border.** Fixed mirrored corner characters in the text viewer frame.
- **Running Agents menu skips separator rows.**
  Up/down navigation no longer lands on the blank separator rows between the agent list and the bulk actions; the cursor jumps from the last agent straight to the first bulk action row. The separator-skip mechanism is now a shared helper used by both the settings-menu wrapper and the Running Agents menu.
- **`defaultMaxTurns` fallback in tool execution path.** Prevents failures when max turns is not explicitly set.
- **Stale concurrency slots cleaned up.** Removing a concurrency limit from config now frees the orphaned slots in-session.
- **`outputThinkingBufferSize` changes apply live.** The thinking-buffer size is now read from the config store at run time, so changing the setting takes effect without restarting pi.
- **Rejected abort/steer promises swallowed.** Session abort and steer calls no longer throw unhandled rejections when the session is already closed.
- **Qwen quota retry.** Qwen `insufficient_quota` errors containing "Allocated quota exceeded" are retried instead of failing immediately. These may be transient false positives when the quota check is eventually consistent.

## [1.10.0] - 2026-08-09

### Added

- **Respect pi's `hideThinkingBlock` setting.** Conversation viewer now honors the parent's thinking block visibility setting.

### Changed

- **Widget layout.** Activity expands to remaining width.
- **Compact mode layout.** Activity and description expands to remaining width.

## [1.9.0] - 2026-08-06

### Added

- **`outputTranscript` setting.** Global config option and `output_transcript` frontmatter field disable per-agent `.output` transcript writing; agent-level setting overrides global. Spawn Options menu includes toggle.
- **Model/thinking placement setting.** Controls where model name and thinking level appear in the widget: `header`, `metadata`, or `none`. Defaults to `metadata` in full mode, `header` in compact.
- **CI automation for GitHub releases.** Pushing a version tag now automatically creates a GitHub release.

### Changed

- **Migrated from Bun to npm.** Project now uses npm for package management; lockfile is `package-lock.json`.
- **Default changes.** `modelDisplayStyle` now defaults to `name`; `finishedRetentionMinutes` defaults to 1 (was 10); `outputTranscript` defaults to `false`.
- **`finishedRetentionMinutes` setting accepts decimals.** decimal values are allowed.

### Fixed

- **ConversationViewer cache invalidated on message replacement.** Ensures stale conversation state doesn't persist when messages array is replaced.
- **Model/thinking placement defaults aligned.** Internal defaults now match user-visible defaults.
- **Output-file streaming survives session compaction.** File output continues correctly after session compaction events.
- **Widget block height matches rendered lines.** `getBlockHeight` now accounts for metadata line presence.

## [1.8.0] - 2026-08-05

### Added

- **Watchdog for stuck agents.** Detects agents stuck in long tool calls or idle states and stops them automatically. Configurable timeouts: `watchdogToolTimeoutMinutes` (default 45) and `watchdogIdleTimeoutMinutes` (default 45). Surface in widget, results, and nudges.
- **Scroll-viewport navigation.** Widget navigation now tracks a scroll window that follows the highlighted agent, keeping the selected row visible when the roster overflows the available space.
- **Identity-based nav highlight with deferred rerank.** Navigation highlight now tracks agent IDs instead of positional indexes, so the highlight survives roster reordering between renders.
- **Tool and idle timeout entries in Spawn Options menu.** Configure watchdog timeouts per-agent at spawn time.
- **Optional background completion hiding.** Widget Behavior settings can hide background-agent completion cards from the TUI; results remain available to the model and Running agents. Thanks [@michalriha1](https://github.com/michalriha1).

### Changed

- **`navHint` setting now respected during active navigation.** The nav hint in the widget heading shows only when not actively navigating.
- **Widget navigation refactored.** `navUp`/`navDown` merged into `moveNav`, nav state extraction unified behind `resolveNavState`, and rendering split into focused methods.
- **Subagents without explicit tool config default to pi's active set (`read`, `bash`, `edit`, `write`)** instead of all built-ins; `grep`/`find`/`ls` must be whitelisted in `tools:` to activate.

### Fixed

- **Non-numeric input rejected in numeric menu items.** Prevents entry of invalid characters in timeout and other number fields.
- **ctrl+o shortcut detection uses `matchesKey`.** Supports all terminal input formats instead of raw character matching.
- **Hidden agents now display their configured `display_name`.** Previously, hidden agents showed "Agent" instead of their frontmatter `display_name` when spawned.

## [1.7.0] - 2026-08-02

### Added

- **Transient Codex stream error retry.** Brief stream failures (ECONNRESET, EPIPE, ETIMEDOUT, EAI_AGAIN) are now retried automatically instead of failing the run.
- **Cross-repo `worktree_path` targets.** `worktree_path` accepts a path inside any git repository on disk: a linked worktree of the parent's repo, its main checkout, or a different repo. Paths outside any git repo are rejected.

### Changed

- **Cross-repo spawns gated by project trust.** Spawning into a different git repo loads the target's project resources only when pi's trust decision (nearest ancestor) or the global `defaultProjectTrust` setting allows it. An untrusted target still spawns, but its resources (`.pi/` settings, extensions, skills, prompts, themes, system prompt files, `.agents/skills`) are ignored, `.pi/agents` types are not discovered, and a warning is surfaced. Same-repo paths are never gated.

### Fixed

- **Git path normalization on Windows.** Worktree paths use backslash separators on Windows so `git rev-parse` resolves correctly.
- **Newlines sanitized in error messages.** Prevents TUI layout breakage when error text contains `\n` or `\r` characters.

## [1.6.1] - 2026-08-01

### Changed

- **`showTools` and `deltaInputTokens` now default to off.** Reduces noise in the widget and spawn wizard for new users.

### Fixed

- **`defaultThinking` from spawn options now applied in LLM-driven spawn path.** Subagents spawned via the `Agent` tool now respect the thinking level set in spawn options when agent frontmatter does not define one. Previously they inherited the parent's thinking level instead.
- **Error message included in background agent failure nudge.** The completion nudge for a failed background subagent now appends the error text so the parent sees why the agent failed without opening the output file.
- **Subagent model errors surfaced as failed runs.** When a subagent's model fails (load error, OOM, provider error), the run is now reported as an error instead of silently completing with an empty result.
- **Agent self-stop distinguished from user stop in status notes.** Agent-initiated stops now read 'STOPPED BY YOU' matching the user stop style.
- **CRLF line endings parsed in agent frontmatter.** Agent files with Windows line endings (`\r\n`) are now parsed correctly. Previously the closing delimiter was not recognized and the agent was silently dropped.
- **Model picker uses `ctx.scopedModels` for pi 0.83+.** Model list respects provider-scoped model availability.

## [1.6.0] - 2026-07-29

### Added

- **`statusBarFormat` setting** (`'full' | 'compact'`). Full format (default) always shows active and done counts. Compact: `◈ N MΣ`.
- **Model and thinking indicators in widget.** `(modelName · thinkingLevel)` shown next to agent names. `modelDisplayStyle` toggles between short ID and full name. Independent visibility toggles in widget settings.
- **Model-aware thinking level filtering in spawn wizard.** Levels filtered by selected model's capabilities. Model change clamps current level.
- **`agentToolStrictMode` toggle.** Constrained sampling with strict json_schema for the Agent tool. Reduces malformed tool calls at higher token cost.
- **Thinking level in nudge cards.** Shown alongside model name.
- **Project agent dirs gated behind `isProjectTrusted()`.** Untrusted projects skip `.agents/agents` and `.pi/agents`. User-level agents always load.

### Changed

- **Widget settings reorganized into 4 submenus.** Layout, Display, Behavior, Stats.
- **DONE line shows token count, not cost.** `getLifetimeTotal()` returns input + output only.
- **Stats labels drop `Show` prefix.**

### Fixed

- **Spawn wizard display refreshes** after model or thinking level change.
- **Thinking level displayed in widget** when using default (inherit) thinking level.
- **Failed agent starts no longer count** toward `totalAgentCount` or `totalAgentCost`.
- **`setShowModel`/`setShowThinking` now sync stats visibility** to the widget immediately.
- **Home directory resolution on Windows.** Replaced `process.env.HOME` with `getAgentDir()` from SDK.
- **Text emoji for tools count** in spawn options.

## [1.5.2] - 2026-07-28

### Added

- **Configurable turn-based eviction for finished agents.** Widget evicts agents after a configurable number of idle turns (default 4). Gated behind `finishedEvictTurns` setting.
- **`finishedRetentionMinutes` setting** (Widget Settings, default 10, min 1). Controls how long finished agents stay visible.
- **Navigation highlight clamps** when roster shrinks from agent eviction.
- **`max` in spawn menu.** Max thinking level now selectable in the spawn wizard.

### Changed

- **Finished agents no longer vanish mid-navigation.** Widget eviction unified with manager retention.
- **Agent tool result message clearer.** Delegation confirmation now explicitly states the agent was spawned.

### Fixed

- **Turn eviction timing corrected.** Eviction now triggers on `turn_start` instead of `tool_execution_start`, preventing incorrect eviction.
- **Widget error containment.** Render, timer, and turn errors are caught and logged instead of crashing the widget.
- **Extension tools available to subagent sessions.** Tools registered by extensions now pass through to subagent sessions correctly.
- **Nav breakage after eviction fixed.** Roster navigation stays consistent when agents are evicted.

## [1.5.1] - 2026-07-26

### Fixed

- **Extension tools no longer missing from subagent sessions.** `createAgentSession({ tools })` is a registry allowlist gate in pi; a builtins-only list silently filtered out every extension tool before registration. Fix: expand `tavily/*` and bare extension tool names in the whitelist _before_ session creation so they enter the gate. `resolveSessionAllowedTools` (new, in `agent-types.ts`) owns this policy; in whitelist mode the gate derives from the expansion alone (no raw wildcards, no unlisted builtins leak). `tools: undefined` agents register all loaded extension tools consistent with pi's own `includeAllExtensionTools` semantics.
- **Whitelist no longer leaks unlisted builtins into the registry gate.** A secondary bug where `registeredTools` was used as an unconditional base alongside the whitelist. Under strict semantics, builtins not named in `tools:` do not enter the allowlist, and raw wildcard literals like `"tavily/*"` never reach pi as bogus tool names.

## [1.5.0] - 2026-07-24

### Added

- **Shared workspace agent discovery.** Agents from `.agents/agents/*.md` are now discovered alongside `.pi/agents/`. Precedence: default < user < shared < project.
- **ConversationViewer replaces ResultViewer.** Full conversation transcript with live streaming, thinking blocks, tool args (4000 char limit), success/error icons, compaction summaries, and event-driven updates (no polling). Navigation: arrow keys, vim j/k, g/G, Home/End, f fullscreen, r refresh. Steering via Enter when agent running.
- **Constrained tool sampling with strict json_schema.** Provider-side schema validation reduces malformed tool calls. Graceful fallback on unsupported providers.

### Changed

- **Agent status icons replaced with ◈/◇.** Broader terminal-font coverage than ●/○.
- **Peer dependencies updated to pi 0.82.** `@earendil-works/pi-*` peers now resolve to ^0.82.0.

### Fixed

- **Widget timer survives steer re-registration.** `clearWidget` no longer kills the timer when steer re-registers the tool.
- **ConversationViewer scroll boundary.** Scroll max computed from actual content, not stale cache.
- **Streaming deduplication.** No duplicate text when full message event catches up to streamed deltas.
- **`bun.lock` peerDep carets restored.** Lock file peer dependencies use carets for flexible resolution.

## [1.4.9] - 2026-07-17

### Added

- **`thinking: max` level support.** Import `ThinkingLevel` from `@earendil-works/pi-ai` so the `max` thinking level is available alongside `none`, `low`, `medium`, `high`, and `xhigh`.

### Fixed

- **Removed deprecated `modelRegistry` from `createAgentSession`.** Compatible with pi 0.80+ which replaced `modelRegistry` with `modelRuntime`.

## [1.4.8] - 2026-07-11

### Fixed

- **Cleanup timer preserves unconsumed agent records.** Background cleanup no longer evicts records before the LLM has read their results.

## [1.4.7] - 2026-07-08

### Added

- **Delta input token tracking for vLLM models.** Shows input token delta in the widget for models without cache stats. Opt-in, off by default.

### Fixed

- **User vs agent stops distinguished in status notes.** `StopAgent` tracks stop initiator, surfacing different notes in result output.

## [1.4.6] - 2026-07-01

### Added

- **`deltaInputTokens` widget setting.** Toggle input token delta display for models without cache reporting.

## [1.4.5] - 2026-06-25

### Added

- **Thinking buffer flush rounded to sentence boundaries.** Log file thinking content flushes at natural sentence breaks.

### Fixed

- **Nudge delivery fixed with fresh pi instance.** `SpawnCoordinator` stores the pi instance for nudge delivery, preventing stale context crashes.
- **Fallback to UI notification when nudge delivery fails.** Completion notifications surface even if `sendMessage` fails.

## [1.4.3] - 2026-06-24

### Fixed

- **Nudge messages use correct `deliverAs` mode.** Prevents delivery failures when parent session state has changed.
- **Stale context error suppressed on background agent nudge.** No spurious errors when nudging agents whose parent context was replaced.

## [1.4.2] - 2026-06-24

### Added

- **Thinking buffer ring selector in widget settings.** Configure how many lines of thinking content appear in the widget tail.
- **Agent display format flipped to `id (type)`.** Resolves `StopAgent` ambiguity when multiple agents of the same type are running.
- **Thinking blocks streamed to output file in real-time.** Thinking content written as it arrives, with deduplication when `thinking_end` fires.

### Fixed

- **Stale pi context crash in SpawnCoordinator nudge emission.** Uses current pi instance instead of captured reference.
- **Worktree validation warnings flushed via `ctx.ui.notify`.** Errors surface to the user instead of silently failing.
- **KV cache ordering improved.** `active_agent` tag moved after shared prefix; `AGENTS.md` placed before `agent_instructions`.

## [1.4.1] - 2026-06-19

### Added

- **Search in type, provider, model, and worktree selection menus.** Incremental text search across all spawn wizard and settings menus.
- **Live descriptions in SettingsList menus.** Contextual descriptions replace the Back button.

### Fixed

- **Notify calls buffered during setup.** Prevents session tree corruption when extensions call `notify()` before initialization.
- **Inline YAML array syntax parsed correctly.** `[a, b, c]` bracket notation strips brackets in frontmatter parsing.
- **System prompt menu rebuilds when switching modes.** Custom/inherit/replace changes update the submenu immediately.
- **Pi scaffolding stripped from parent prompt in all modes.** Inherit mode no longer duplicates pi's system prompt wrappers.

## [1.4.0] - 2026-06-19

### Added

- **`disableDefaultAgents` setting.** Hide built-in agents so only custom `.pi/agents/*.md` agents are advertised.
- **Status notes for non-normal agent outcomes.** Stopped, aborted, and turn-limited agents carry explicit notes for the orchestrator.
- **KV cache optimization.** System prompt reordered for maximum cache reuse across agents.

### Changed

- **Menus unified to pi-style SettingsList/SelectList.** All menus use pi's native components with consistent navigation and submenus.
- **`steered` status renamed to `turn_limited`.** More accurate naming for agents that wrapped up at their turn budget.

### Fixed

- **Disabled agents no longer advertised in tool description.** `enabled: false` agents filtered from the LLM's type list.
- **Agent tool type list built after settings load.** Description reflects persisted settings.

## [1.3.0] and earlier

AgentStatus tool, `worktree_path` parameter, manual spawn menu, cost display, compact mode sync, configurable grace turns, selective extension loading, skill whitelisting, and the foundational subagent spawning system with foreground/background modes, concurrency limits, and the `/agents` menu.
