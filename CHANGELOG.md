# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Watchdog for stuck agents.** Detects agents stuck in long tool calls or idle states and stops them automatically. Configurable timeouts: `watchdogToolTimeoutMinutes` (default 5) and `watchdogIdleTimeoutMinutes` (default 10). Surface in widget, results, and nudges.
- **Scroll-viewport navigation.** Widget navigation now tracks a scroll window that follows the highlighted agent, keeping the selected row visible when the roster overflows the available space.
- **Identity-based nav highlight with deferred rerank.** Navigation highlight now tracks agent IDs instead of positional indexes, so the highlight survives roster reordering between renders.
- **Tool and idle timeout entries in Spawn Options menu.** Configure watchdog timeouts per-agent at spawn time.

### Changed

- **`navHint` setting now respected during active navigation.** The nav hint in the widget heading shows only when not actively navigating.
- **Widget navigation refactored.** `navUp`/`navDown` merged into `moveNav`, nav state extraction unified behind `resolveNavState`, and rendering split into focused methods.

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

- **Extension tools no longer missing from subagent sessions.** `createAgentSession({ tools })` is a registry allowlist gate in pi; a builtins-only list silently filtered out every extension tool before registration. Fix: expand `tavily/*` and bare extension tool names in the whitelist *before* session creation so they enter the gate. `resolveSessionAllowedTools` (new, in `agent-types.ts`) owns this policy; in whitelist mode the gate derives from the expansion alone (no raw wildcards, no unlisted builtins leak). `tools: undefined` agents register all loaded extension tools consistent with pi's own `includeAllExtensionTools` semantics.
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
