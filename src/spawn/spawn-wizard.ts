/**
 * spawn-wizard.ts — Spawn agent wizard and worktree picker.
 *
 * Extracted from menus.ts to own the multi-step spawn composition flow:
 * type selection → prompt → options sub-menu → spawn.
 *
 * The worktree picker (listWorktrees, isInGitRepo, parseWorktreeList, truncatePath)
 * is co-located here because it exists solely to feed the spawn wizard's worktree_path.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { SettingsList, SelectList, Input, type SettingItem } from "@earendil-works/pi-tui";
import type { ThinkingLevel } from "../types.js";
import { getAgentConfig, getAvailableTypes, resolveType, discoverNewAgents } from "../agents/agent-types.js";
import { findModelInRegistry } from "../utils.js";
import { buildSettingsListTheme, buildSelectListTheme, validateNumeric, backSubmenuItem } from "../ui/menu/menu-helpers.js";
import { createModelSelectSubmenu } from "../ui/menu/menu-model-select-submenu.js";
import { SettingsListWrapper } from "../ui/menu/menu-settings-list-wrapper.js";
import {
  getPiInstance,
  getSessionCtx,
  getWidget,
  getStore,
  getCoordinator,
} from "../shell.js";

// ============================================================================
// Worktree picker helpers
// ============================================================================

/** Timeout for git worktree list command (ms). */
const WORKTREE_LIST_TIMEOUT_MS = 5000;

/** Max display length for a worktree path before truncation. */
const WORKTREE_PATH_TRUNCATE_LEN = 60;

interface WorktreeEntry {
  path: string;
  branch: string | null;
  isDetached: boolean;
}

/**
 * Parse `git worktree list --porcelain` output into structured entries.
 *
 * Format (one block per worktree, separated by blank lines):
 *   worktree /path/to/worktree
 *   HEAD <sha>
 *   branch refs/heads/<name>   (or: (detached))
 */
function parseWorktreeList(output: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  const blocks = output.split(/\n\n+/);
  for (const block of blocks) {
    if (!block.trim()) continue;
    const lines = block.split("\n");
    let path = "";
    let branch: string | null = null;
    let isDetached = false;
    for (const line of lines) {
      if (line.startsWith("worktree ")) {
        path = line.slice("worktree ".length);
      } else if (line.startsWith("branch refs/heads/")) {
        branch = line.slice("branch refs/heads/".length);
      } else if (line === "detached") {
        isDetached = true;
      }
    }
    if (path) {
      entries.push({ path, branch, isDetached });
    }
  }
  return entries;
}

/** Truncate a path for display, keeping the tail. */
function truncatePath(p: string): string {
  if (p.length <= WORKTREE_PATH_TRUNCATE_LEN) return p;
  return "..." + p.slice(p.length - WORKTREE_PATH_TRUNCATE_LEN + 3);
}

/**
 * Fetch worktrees via `git worktree list --porcelain`.
 * Returns null if git is unavailable or the command fails.
 */
async function listWorktrees(cwd: string): Promise<WorktreeEntry[] | null> {
  try {
    const result = await getPiInstance().exec(
      "git",
      ["worktree", "list", "--porcelain"],
      { cwd, timeout: WORKTREE_LIST_TIMEOUT_MS },
    );
    if (result.code !== 0) return null;
    return parseWorktreeList(result.stdout);
  } catch {
    return null;
  }
}

/**
 * Check whether a directory is inside a git repository.
 * Uses `git rev-parse --git-common-dir` — the same strategy as the worktree validator.
 */
async function isInGitRepo(cwd: string): Promise<boolean> {
  try {
    const result = await getPiInstance().exec(
      "git",
      ["rev-parse", "--git-common-dir"],
      { cwd, timeout: WORKTREE_LIST_TIMEOUT_MS },
    );
    return result.code === 0 && result.stdout.trim() !== "";
  } catch {
    return false;
  }
}

// ============================================================================
// Spawn agent wizard
// ============================================================================

const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

/**
 * Show the spawn agent flow as a multi-step wizard:
 *   Step 1: type selection (SelectList)
 *   Step 2: prompt entry (Input)
 *   Step 3: options sub-menu with spawn (SettingsList with submenus)
 */
export async function showSpawnAgentMenu(
  ctx: ExtensionCommandContext,
  modelOptions: string[],
): Promise<void> {
  // ---- Step 1: Type selection ----
  let selectedType: string;
  {
    const types = getAvailableTypes();
    if (types.length === 0) {
      ctx.ui.notify("No agent types available", "error");
      return;
    }

    const result = await ctx.ui.custom<string | undefined>((_tui, theme, _kb, done) => {
      const items: SettingItem[] = types.map(t => ({
        id: t,
        label: t,
        currentValue: t,
        submenu: (_v: string, _subDone: (value?: string) => void) => {
          done(t);
          return undefined as any;
        },
      }));
      const list = new SettingsList(
        items,
        10,
        buildSettingsListTheme(theme),
        (id, value) => { done(value); },
        () => done(undefined),
        { enableSearch: true },
      );
      return new SettingsListWrapper(list, { title: "Select Agent Type", theme, passthroughKeys: true });
    });
    if (result === undefined) return;

    const config = getAgentConfig(result);
    if (!config) {
      ctx.ui.notify(`Unknown agent type: ${result}`, "error");
      return;
    }
    selectedType = result;
  }

  const agentConfig = getAgentConfig(selectedType)!;

  // ---- Step 2: Prompt entry ----
  let prompt: string;
  {
    const result = await ctx.ui.custom<string | undefined>((_tui, theme, _kb, done) => {
      const input = new Input();
      input.onSubmit = (value) => {
        const trimmed = value.trim();
        if (!trimmed) {
          ctx.ui.notify("Prompt cannot be empty", "error");
          return;
        }
        done(trimmed);
      };
      input.onEscape = () => done(undefined);
      return new SettingsListWrapper(input, { title: "Agent Prompt", theme, footerText: "Enter to confirm · Esc to cancel" });
    });
    if (result === undefined) return;
    prompt = result;
  }

  // ---- Step 3: Options sub-menu with spawn ----
  const session = getSessionCtx();
  const parentCwd = session?.cwd ?? "";
  const inGitRepo = parentCwd ? await isInGitRepo(parentCwd) : false;
  const worktrees = inGitRepo ? (await listWorktrees(parentCwd)) ?? [] : [];

  const store = getStore();
  const parentModelId = session?.model
    ? `${session.model.provider}/${session.model.id}`
    : "";
  const effectiveModelStr = store.modelFor(selectedType, parentModelId, agentConfig);

  let currentModelStr = effectiveModelStr || "";
  let currentThinking: ThinkingLevel | undefined = agentConfig.thinkingLevel ?? store.agent.defaultThinking;
  let currentMaxTurns: number | undefined = agentConfig.maxTurns ?? store.agent.defaultMaxTurns;
  let currentMaxTokens: number | undefined = agentConfig.maxTokens;
  let currentGraceTurns: number | undefined = store.agent.graceTurns;
  let currentBackground: boolean = store.agent.forceBackground;
  let currentWorktreePath: string | undefined;
  let currentWorktreeLabel = "Inherits parent cwd";
  let currentDescription = prompt.length > 50 ? prompt.slice(0, 50) : prompt;

  const buildItems = (): SettingItem[] => {
    const displayModel = currentModelStr || "(inherits parent)";
    const items: SettingItem[] = [
      {
        id: "spawn",
        label: "Spawn",
        currentValue: "",
        submenu: (_v, done) => {
          const thinkingItem = items.find(i => i.id === "thinkingLevel");
          const mtItem = items.find(i => i.id === "maxTurns");
          const mtkItem = items.find(i => i.id === "maxTokens");
          const gtItem = items.find(i => i.id === "graceTurns");
          const bgItem = items.find(i => i.id === "background");
          const descItem = items.find(i => i.id === "description");

          const thinking = (thinkingItem?.currentValue === "inherit"
            ? undefined : thinkingItem?.currentValue) as ThinkingLevel | undefined;
          const maxTurns = mtItem?.currentValue === "unlimited"
            ? undefined : Number(mtItem?.currentValue);
          const maxTokens = mtkItem?.currentValue === "unlimited"
            ? undefined : Number(mtkItem?.currentValue);
          const graceTurns = Number(gtItem?.currentValue ?? "6");
          const background = bgItem?.currentValue === "ON";
          const description = descItem?.currentValue ?? currentDescription;
          const promptItem = items.find(i => i.id === "prompt");
          const spawnPrompt = promptItem?.currentValue ?? prompt;

          // Resolve model
          let model: ReturnType<typeof findModelInRegistry> = undefined;
          let modelKey: string | undefined;
          if (currentModelStr) {
            const registry = session?.modelRegistry ?? ctx.modelRegistry;
            model = findModelInRegistry(currentModelStr, registry, undefined);
            if (!model) {
              ctx.ui.notify(`Model not found: ${currentModelStr}`, "error");
              done();
              return undefined as any;
            }
            modelKey = `${model.provider}/${model.id}`;
          }

          const doSpawn = async () => {
            if (currentWorktreePath) {
              await discoverNewAgents(`${currentWorktreePath}/.pi/agents`);
            }
            const resolvedType = resolveType(selectedType) ?? selectedType;

            const widget = getWidget();
            if (widget) {
              widget.setUICtx(ctx.ui as unknown as import("../ui/agent-widget.js").UICtx);
              widget.ensureTimer();
            }

            const coordinator = getCoordinator()!;
            try {
              const result = await coordinator.spawn(getPiInstance(), session!, {
                type: resolvedType,
                prompt: spawnPrompt,
                description,
                model,
                modelKey,
                maxTurns,
                maxTokens,
                thinkingLevel: thinking,
                graceTurns,
                worktreePath: currentWorktreePath,
                worktreeLabel: currentWorktreePath ? currentWorktreeLabel : undefined,
                invocation: {
                  modelName: model?.id,
                  thinkingLevel: thinking,
                  maxTurns,
                  runInBackground: background,
                },
                runInBackground: background,
              });

              if (!background) {
                getWidget()?.markFinished(result.agentId);
                getWidget()?.update();
              }
            } catch (err) {
              ctx.ui.notify(
                `Spawn failed: ${err instanceof Error ? err.message : String(err)}`,
                "error",
              );
            }
          };

          done();
          doneRef();
          doSpawn().catch(() => {});
          return undefined as any;
        },
      },
      {
        id: "separator",
        label: "",
        currentValue: "",
      },
      {
        id: "model",
        label: "Model",
        currentValue: displayModel,
        submenu: createModelSelectSubmenu({
          modelOptions,
          showClear: false,
          theme,
          onSelect: (_mode, model) => {
            currentModelStr = model === "(inherits parent)" || model === null ? "" : model;
          },
        }),
      },
      {
        id: "background",
        label: "Background",
        currentValue: currentBackground ? "ON" : "OFF",
        values: ["ON", "OFF"],
      },
      ...(inGitRepo
        ? [{
            id: "worktree",
            label: "Worktree",
            currentValue: currentWorktreeLabel,
            submenu: (_v: string, done: (v?: string) => void) => {
              const pickerItems = [
                { value: "Inherits parent cwd", label: "Inherits parent cwd" },
                ...worktrees.map(wt => {
                  const branchLabel = wt.isDetached ? "detached" : (wt.branch ?? "detached");
                  const truncPath = truncatePath(wt.path);
                  return { value: wt.path, label: `${branchLabel}  ·  ${truncPath}` };
                }),
              ];
              const list = new SelectList(pickerItems, 10, buildSelectListTheme(theme));
              list.onSelect = (item: any) => {
                if (item.value === "Inherits parent cwd") {
                  currentWorktreePath = undefined;
                  done("Inherits parent cwd");
                } else {
                  const wt = worktrees.find(w => w.path === item.value);
                  currentWorktreePath = wt?.path;
                  done(wt?.branch ?? "detached");
                }
              };
              list.onCancel = () => done();
              return list;
            },
          } as SettingItem]
        : []),
      {
        id: "thinkingLevel",
        label: "Thinking level",
        currentValue: currentThinking ?? "inherit",
        values: [...THINKING_LEVELS, "inherit"],
      },
      {
        id: "maxTokens",
        label: "Max tokens",
        currentValue: currentMaxTokens != null ? String(currentMaxTokens) : "unlimited",
        submenu: (currentValue, done) => {
          const input = new Input();
          input.setValue(currentValue === "unlimited" ? "" : currentValue);
          input.onSubmit = (value) => {
            const trimmed = value.trim().toLowerCase();
            if (trimmed === "unlimited" || trimmed === "") {
              done("unlimited");
              return;
            }
            const result = validateNumeric(value, 1);
            if (result === undefined) {
              ctx.ui.notify("Must be a number ≥ 1 or 'unlimited'", "error");
              return;
            }
            done(String(result));
          };
          input.onEscape = () => done();
          return input;
        },
      },
      {
        id: "maxTurns",
        label: "Max turns",
        currentValue: currentMaxTurns != null ? String(currentMaxTurns) : "unlimited",
        submenu: (currentValue, done) => {
          const input = new Input();
          input.setValue(currentValue === "unlimited" ? "" : currentValue);
          input.onSubmit = (value) => {
            const trimmed = value.trim().toLowerCase();
            if (trimmed === "unlimited" || trimmed === "") {
              done("unlimited");
              return;
            }
            const result = validateNumeric(value, 1);
            if (result === undefined) {
              ctx.ui.notify("Must be a number ≥ 1 or 'unlimited'", "error");
              return;
            }
            done(String(result));
          };
          input.onEscape = () => done();
          return input;
        },
      },
      {
        id: "graceTurns",
        label: "Grace turns",
        currentValue: String(currentGraceTurns ?? 6),
        submenu: (currentValue, done) => {
          const input = new Input();
          input.setValue(currentValue);
          input.onSubmit = (value) => {
            const result = validateNumeric(value, 0);
            if (result === undefined) {
              ctx.ui.notify("Must be a number ≥ 0", "error");
              return;
            }
            done(String(result));
          };
          input.onEscape = () => done();
          return input;
        },
      },
      {
        id: "description",
        label: "Description",
        currentValue: currentDescription,
        submenu: (_v, done) => {
          const input = new Input();
          input.setValue(currentDescription);
          input.onSubmit = (value) => {
            const trimmed = value.trim();
            if (trimmed) done(trimmed);
            else done();
          };
          input.onEscape = () => done();
          return input;
        },
      },
      {
        id: "prompt",
        label: "Prompt",
        currentValue: prompt,
        submenu: (_v, done) => {
          const input = new Input();
          input.setValue(prompt);
          input.onSubmit = (value) => {
            const trimmed = value.trim();
            if (!trimmed) {
              ctx.ui.notify("Prompt cannot be empty", "error");
              return;
            }
            done(trimmed);
          };
          input.onEscape = () => done();
          return input;
        },
      },
      {
        id: "separator",
        label: "",
        currentValue: "",
      },
    ];

    items.push(backSubmenuItem(() => doneRef()));
    return items;
  };

  let theme: any;
  let doneRef: () => void;

  await ctx.ui.custom((_tui, t, _kb, done) => {
    theme = t;
    doneRef = () => done(undefined);
    const items = buildItems();
    const onChange = (id: string, newValue: string) => {
      switch (id) {
        case "thinkingLevel":
          currentThinking = newValue === "inherit" ? undefined : newValue as ThinkingLevel;
          break;
        case "background":
          currentBackground = newValue === "ON";
          break;
        case "prompt":
          prompt = newValue;
          break;
      }
    };
    const settingsList = new SettingsList(items, 15, buildSettingsListTheme(theme), onChange, doneRef);
    return new SettingsListWrapper(settingsList, { title: "Spawn Options", theme });
  });
}
