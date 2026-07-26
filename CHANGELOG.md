# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- **Finished agents no longer vanish mid-navigation.** Widget eviction unified with manager retention — one configurable clock instead of two conflicting ones.

### Added
- **`finishedRetentionMinutes` setting** (Widget Settings, default 10, min 1). Controls how long finished agents stay visible.
- **Navigation highlight clamps** when roster shrinks from agent eviction.

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
