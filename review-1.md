Status: NEEDS_REVISION

# Review Summary

Files reviewed:
- `src/agent-runner.ts`
- `src/prompts.ts`
- `src/config-store.ts`
- `src/config-io.ts`
- `src/model-precedence.ts`
- `src/menus.ts`
- `src/types.ts`
- `test/agent-runner.test.ts`
- `test/config-store.test.ts`
- `test/menus.test.ts`
- `test/prompts.test.ts`

Issues found:
- 0 critical, 4 important, 2 suggestions

---

## [IMPORTANT] agent-runner.ts test shell mock missing `setSystemPromptMode` and not parameterizable

Confidence: 95/100
Location: `test/agent-runner.test.ts:74-84`

Problem: The `vi.mock("../src/shell.js")` in `agent-runner.test.ts` hardcodes `systemPromptMode: "replace"` and omits `setSystemPromptMode` from `mutate.agent`. The `systemPromptMode` value cannot be changed per-test (unlike `mockIncludeContextFiles` which is a hoisted variable). This means zero test coverage for the inherit and custom mode code paths in `runAgent()`.

Why it matters: The acceptance criteria explicitly requires *"Tests cover all three modes, fallback behavior, and empty/missing custom file."* The prompts.test.ts covers `buildAgentPrompt` in isolation, but the runtime orchestration in `runAgent()` — fetching parent prompt via `ctx.getSystemPrompt()`, reading the custom file via `fs.readFileSync`, notification on fallback — is entirely untested through agent-runner. The ~50 lines of new runtime code in `runAgent()` (lines 538-590) have no integration-level test coverage.

Fix: Make `systemPromptMode` a parameterizable mock variable (like `mockIncludeContextFiles`), and add tests for the three modes:

```ts
// In vi.hoisted:
mockModules.mockSystemPromptMode: "replace" as string,

// In vi.mock("../src/shell.js"):
systemPromptMode: mockModules.mockSystemPromptMode,

// New tests:
it("calls ctx.getSystemPrompt() when mode is inherit", async () => {
  mockModules.mockSystemPromptMode = "inherit";
  const ctx = fakeCtx();
  ctx.getSystemPrompt = vi.fn().mockReturnValue("parent prompt");
  // ... runAgent ...
  expect(ctx.getSystemPrompt).toHaveBeenCalled();
  expect(mockModules.mockBuildAgentPrompt).toHaveBeenCalledWith(
    expect.anything(), expect.anything(), expect.anything(),
    expect.objectContaining({ parentSystemPrompt: "parent prompt" }),
    "inherit",
  );
});

it("falls back to replace when getSystemPrompt throws in inherit mode", async () => {
  mockModules.mockSystemPromptMode = "inherit";
  const ctx = fakeCtx();
  ctx.getSystemPrompt = vi.fn().mockImplementation(() => { throw new Error("no prompt"); });
  // ... runAgent ... verify notify called, mode still "inherit" but parentSystemPrompt undefined
});
```

---

## [IMPORTANT] menus.test.ts shell mock incomplete — missing `systemPromptMode` getter and `setSystemPromptMode` mutation

Confidence: 90/100
Location: `test/menus.test.ts:100-170`

Problem: The menus.test.ts shell mock has two gaps:
1. The `agent` getter does not include `systemPromptMode` (so `store.agent.systemPromptMode` returns `undefined`).
2. `mutate.agent` does not include `setSystemPromptMode`.
3. The `clearAllModelOverrides` mock preserves `includeContextFiles` but NOT `systemPromptMode`.

This means:
- The existing test "positions after 'Grace turns' and before 'System prompt mode'" would see `"System prompt mode · undefined"` as the menu label instead of `"System prompt mode · replace"`.
- Any future test that exercises the mode-select action would crash on `store.mutate.agent.setSystemPromptMode(mode)`.
- A "Clear all overrides" test would lose `systemPromptMode`.

Why it matters: The mock diverges from the real `ConfigStore` interface, creating a maintenance trap. If `menus.ts` ever adds logic that reads `systemPromptMode` outside the menu label (e.g., conditional UI), tests would behave differently than production.

Fix:
```ts
// In the agent getter (around line 110):
systemPromptMode: a.systemPromptMode ?? "replace",

// In clearAllModelOverrides preserved keys (around line 152):
for (const key of [...existing..., 'systemPromptMode']) {

// In mutate.agent (around line 163):
setSystemPromptMode(mode: string) { mockModules.mockConfig.agent.systemPromptMode = mode; },
```

---

## [IMPORTANT] CUSTOM_PROMPT_PATH constant duplicated in two files

Confidence: 85/100
Location: `src/agent-runner.ts:30` and `src/menus.ts:369,373`

Problem: `CUSTOM_PROMPT_PATH` is defined as a module-level constant in `agent-runner.ts`:
```ts
const CUSTOM_PROMPT_PATH = path.join(process.env.HOME || "", ".pi", "agent", "subagents-lite-prompt.md");
```
But `menus.ts` recomputes the same path inline twice:
```ts
const customPromptPath = path.join(process.env.HOME || "", ".pi", "agent", "subagents-lite-prompt.md");
```

Why it matters: DRY violation. If the path ever changes, both files must be updated independently. The path is a user-facing configuration — a mismatch would cause the menu to check/create a file at a different path than what `runAgent` reads.

Fix: Export `CUSTOM_PROMPT_PATH` from a shared location (e.g., `agent-runner.ts` or a new `constants.ts`) and import it in `menus.ts`.

---

## [IMPORTANT] Type assertion for `systemPromptMode` in ConfigStore reads arbitrary config values without validation

Confidence: 80/100
Location: `src/config-store.ts:88`

Problem:
```ts
systemPromptMode: (a.systemPromptMode as "replace" | "inherit" | "custom") ?? DEFAULT_CONFIG.agent.systemPromptMode ?? "replace",
```
The `as` cast passes through any string from the config file without checking it's a valid mode. A hand-edited `subagents-lite.json` with `"systemPromptMode": "invalid"` would silently propagate through the system. Downstream code in `prompts.ts` checks `mode === "inherit"` and `mode === "custom"` and falls back to replace, so the practical impact is limited — but the config store should still validate.

Why it matters: Type safety. The config store is the authoritative source for resolved settings — it should reject or normalize invalid values rather than passing them through unchecked.

Fix: Add validation:
```ts
const rawMode = a.systemPromptMode;
const validModes = new Set(["replace", "inherit", "custom"]);
systemPromptMode: validModes.has(rawMode as string) ? rawMode as "replace" | "inherit" | "custom" : "replace",
```

---

## [SUGGESTION] Union type `"replace" | "inherit" | "custom"` repeated across 6+ locations

Confidence: 75/100
Location: `model-precedence.ts:29`, `config-store.ts:50,88,180`, `menus.ts:360`, `prompts.ts:40`, `agent-runner.ts:272`

Problem: The same union type is inlined in 6+ places. Any addition (e.g., a fourth mode) requires updating every location.

Fix: Define a shared type alias:
```ts
// In types.ts:
export type SystemPromptMode = "replace" | "inherit" | "custom";
```
Then reference `SystemPromptMode` everywhere.

---

## [SUGGESTION] Acceptance criteria "Create prompt file" has no test coverage

Confidence: 75/100
Location: `src/menus.ts:370-384`, `test/menus.test.ts`

Problem: The acceptance criteria states: *"Settings menu offers 'Create prompt file' when mode is custom but file doesn't exist."* The menu code implements this with `fs.existsSync(customPromptPath)`, `fs.mkdirSync`, and `fs.writeFileSync`. However, no test exercises this path. The menus.test.ts shell mock lacks `systemPromptMode` so the test can't even set the mode to "custom" to trigger this menu item.

Why it matters: File I/O side effects (creating directories and files) should be tested, especially with error paths (permission denied, disk full).

Fix: After fixing the shell mock, add tests for the "Create prompt file" menu item, mocking `fs.existsSync` and `fs.writeFileSync`.

---

## Strengths

- **prompts.test.ts is excellent**: Thorough coverage of all three modes, fallback behavior, XML escaping, context file ordering. Tests verify observable output structure, not internal implementation.
- **config-store.test.ts is solid**: Default resolution, mutation, persistence, `clearAllModelOverrides` preservation — all well-tested.
- **Non-fatal error handling in agent-runner.ts**: The inherit/custom mode code correctly falls back to replace with `notify()` rather than crashing. The try/catch granularity (ENOENT vs other errors) is thoughtful.
- **KV cache optimization preserved**: The inherit mode correctly places `<active_agent>` after the parent prompt, preserving the verbatim byte prefix.
- **`<agent_instructions>` wrapping is consistent**: The agent's own systemPrompt is always wrapped in `<agent_instructions>` tags regardless of mode — well-structured for downstream parsing.
