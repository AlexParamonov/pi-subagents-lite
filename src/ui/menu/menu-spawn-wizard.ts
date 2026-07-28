/**
 * menu-spawn-wizard.ts — Spawn agent wizard and worktree picker.
 *
 * Extracted from menus.ts to own the multi-step spawn composition flow:
 * type selection → prompt → options sub-menu → spawn.
 *
 * The worktree picker (listWorktrees, isInGitRepo, parseWorktreeList, truncatePath)
 * is co-located here because it exists solely to feed the spawn wizard's worktree_path.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { SettingsList, SelectList, type SettingItem } from "@earendil-works/pi-tui";
import type { ThinkingLevel } from "../../types.js";
import type { Theme } from "../types.js";
import { getAgentConfig, getAvailableTypes, resolveType, resolveAgentCatalog, resolveTypeInCatalog, snapshotAgentConfig } from "../../agents/agent-types.js";
import type { AgentConfig } from "../../agents/types.js";
import { findModelInRegistry, VALID_THINKING_LEVELS } from "../../utils.js";
import { buildSettingsListTheme, buildSelectListTheme, createSearchableSelect } from "./helpers.js";
import { DEFAULT_GRACE_TURNS } from "../../config/config-io.js";
import { createModelSelectSubmenu } from "./submenus/model-select.js";
import { createNumericSubmenu, createInputSubmenu } from "./submenus/numeric-input.js";
import { SettingsListWrapper } from "./wrappers/settings-list.js";
import {
  getPiInstance,
  getSessionCtx,
  getWidget,
  getStore,
  getCoordinator,
} from "../../shell.js";

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
  // Worktree definitions belong to this wizard invocation only.
  let catalog: Map<string, AgentConfig> | undefined;
  const availableTypes = () => catalog
    ? [...catalog.entries()].filter(([, config]) => config.hidden !== true).map(([name]) => name)
    : getAvailableTypes();
  const configFor = (type: string) => catalog
    ? (() => { const key = resolveTypeInCatalog(catalog!, type); return key ? catalog!.get(key) : undefined; })()
    : getAgentConfig(type);
  const resolveSelectedType = (type: string) => catalog
    ? resolveTypeInCatalog(catalog, type)
    : resolveType(type);

  const session = getSessionCtx();
  const parentCwd = session?.cwd ?? "";
  const inGitRepo = parentCwd ? await isInGitRepo(parentCwd) : false;
  const worktrees = inGitRepo ? (await listWorktrees(parentCwd)) ?? [] : [];
  let initialWorktreePath: string | undefined;
  let initialWorktreeLabel = "Inherits parent cwd";

  // With an empty parent catalog, pick a trusted worktree before selecting a
  // type. Normal flows retain the single picker in Spawn Options.
  if (availableTypes().length === 0) {
    if (!inGitRepo || worktrees.length === 0 || !ctx.isProjectTrusted()) {
      ctx.ui.notify("No agent types available", "error");
      return;
    }
    const chosen = await ctx.ui.custom<string | undefined>((_tui, theme, _kb, done) => createSearchableSelect(
      worktrees.map(wt => ({ value: wt.path, label: truncatePath(wt.path), provider: wt.isDetached ? "detached" : (wt.branch ?? "detached") })),
      { onSelect: (value) => done(value), onCancel: () => done(undefined) },
      theme,
    ));
    if (!chosen) return;
    initialWorktreePath = chosen;
    initialWorktreeLabel = worktrees.find(w => w.path === chosen)?.branch ?? "detached";
    catalog = await resolveAgentCatalog(`${chosen}/.pi/agents`, {
      disableDefaultAgents: getStore().agent.disableDefaultAgents,
    });
    if (availableTypes().length === 0) {
      ctx.ui.notify("No agent types available in selected worktree", "error");
      return;
    }
  }

  // ---- Step 1: Type selection ----
  let selectedType: string;
  {
    const types = availableTypes();
    if (types.length === 0) {
      ctx.ui.notify("No agent types available", "error");
      return;
    }

    const result = await ctx.ui.custom<string | undefined>((_tui, theme, _kb, done) => {
      const items: SettingItem[] = types.map(t => ({
        id: t,
        label: t,
        currentValue: t,
        description: configFor(t)?.description ?? "Agent type",
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

    const config = configFor(result);
    if (!config) {
      ctx.ui.notify(`Unknown agent type: ${result}`, "error");
      return;
    }
    selectedType = result;
  }

  // ---- Step 2: Prompt entry ----
  let prompt: string;
  {
    const result = await ctx.ui.custom<string | undefined>((_tui, theme, _kb, done) => {
      const input = createInputSubmenu(ctx, { required: true })("", done);
      return new SettingsListWrapper(input, { title: "Agent Prompt", theme, passthroughKeys: true });
    });
    if (result === undefined) return;
    prompt = result;
  }

  // ---- Step 3: Options sub-menu with spawn ----
  const store = getStore();
  const parentModelId = session?.model
    ? `${session.model.provider}/${session.model.id}`
    : "";
  let currentModelStr = "";
  let currentThinking: ThinkingLevel | undefined;
  let currentMaxTurns: number | undefined;
  let currentMaxTokens: number | undefined;
  let modelOverridden = false;
  let thinkingOverridden = false;
  let maxTurnsOverridden = false;
  let maxTokensOverridden = false;
  let currentGraceTurns: number = store.agent.graceTurns ?? DEFAULT_GRACE_TURNS;
  let currentBackground: boolean = store.agent.forceBackground;
  let currentWorktreePath: string | undefined = initialWorktreePath;
  let currentWorktreeLabel = initialWorktreeLabel;
  let currentDescription = prompt.length > 50 ? prompt.slice(0, 50) : prompt;

  /** Refresh defaults supplied by the selected type without discarding user edits. */
  const refreshTypeDefaults = () => {
    const config = configFor(selectedType);
    if (!modelOverridden) {
      currentModelStr = store.modelFor(selectedType, parentModelId, config) || "";
    }
    if (!thinkingOverridden) {
      currentThinking = config?.thinkingLevel ?? store.agent.defaultThinking;
    }
    if (!maxTurnsOverridden) {
      currentMaxTurns = config?.maxTurns ?? store.agent.defaultMaxTurns;
    }
    if (!maxTokensOverridden) {
      currentMaxTokens = config?.maxTokens;
    }
  };
  refreshTypeDefaults();

  // Set by buildItems so a worktree switch can update the open settings list.
  let refreshTypeDerivedItemValues = () => {};

  /** Resolve a local worktree catalog without touching the parent registry. */
  const applyWorktreeSelection = async (worktreePath?: string): Promise<void> => {
    const trustedWorktreeDir = worktreePath && ctx.isProjectTrusted()
      ? `${worktreePath}/.pi/agents`
      : undefined;
    catalog = trustedWorktreeDir
      ? await resolveAgentCatalog(trustedWorktreeDir, { disableDefaultAgents: getStore().agent.disableDefaultAgents })
      : undefined;

    const types = availableTypes();
    const resolvedSelectedType = resolveSelectedType(selectedType);
    selectedType = resolvedSelectedType && types.includes(resolvedSelectedType)
      ? resolvedSelectedType
      : (types[0] ?? "");
    refreshTypeDefaults();
    refreshTypeDerivedItemValues();
  };

  const buildItems = (): SettingItem[] => {
    const fmtNum = (v: number | undefined) => v != null ? String(v) : "(not set)";
    const displayModel = currentModelStr || "(inherits parent)";
    const items: SettingItem[] = [];
    refreshTypeDerivedItemValues = () => {
      const config = configFor(selectedType);
      const byId = new Map(items.map(item => [item.id, item]));
      const typeItem = byId.get("type");
      if (typeItem) {
        typeItem.currentValue = selectedType;
        typeItem.description = config?.description ?? "Agent type";
      }
      const modelItem = byId.get("model");
      if (modelItem) modelItem.currentValue = currentModelStr || "(inherits parent)";
      const thinkingItem = byId.get("thinkingLevel");
      if (thinkingItem) thinkingItem.currentValue = currentThinking ?? "inherit";
      const maxTokensItem = byId.get("maxTokens");
      if (maxTokensItem) maxTokensItem.currentValue = fmtNum(currentMaxTokens);
      const maxTurnsItem = byId.get("maxTurns");
      if (maxTurnsItem) maxTurnsItem.currentValue = fmtNum(currentMaxTurns);
    };

    items.push(
      {
        id: "spawn",
        label: "Spawn",
        currentValue: "",
        description: "Spawn the agent with current settings",
        submenu: (_v, done) => {
          const gtItem = items.find(i => i.id === "graceTurns");
          const bgItem = items.find(i => i.id === "background");
          const descItem = items.find(i => i.id === "description");
          const promptItem = items.find(i => i.id === "prompt");

          const thinking = currentThinking;
          const maxTurns = currentMaxTurns;
          const maxTokens = currentMaxTokens;
          const graceTurns = Number(gtItem?.currentValue ?? DEFAULT_GRACE_TURNS);
          const background = bgItem?.currentValue === "ON";
          const description = descItem?.currentValue ?? currentDescription;
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
            const resolvedType = resolveSelectedType(selectedType);
            const selectedConfig = resolvedType ? configFor(resolvedType) : undefined;
            if (!resolvedType || !selectedConfig || !availableTypes().includes(resolvedType)) {
              ctx.ui.notify("No valid agent type selected", "error");
              return;
            }

            const widget = getWidget();
            if (widget) {
              widget.setUICtx(ctx.ui as unknown as import("../agent-widget.js").UICtx);
              widget.ensureTimer();
            }

            const coordinator = getCoordinator()!;
            try {
              const result = await coordinator.spawn(getPiInstance(), session!, {
                type: resolvedType,
                agentConfig: snapshotAgentConfig(selectedConfig),
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
        id: "__sep__",
        label: " ",
        currentValue: "",
      },
      {
        id: "model",
        label: "Model",
        currentValue: displayModel,
        description: "Override the default model for this agent",
        submenu: createModelSelectSubmenu({
          modelOptions,
          showClear: false,
          theme,
          onSelect: (_mode, model) => {
            modelOverridden = true;
            currentModelStr = model === "(inherits parent)" || model === null ? "" : model;
          },
        }),
      },
      {
        id: "background",
        label: "Background",
        currentValue: currentBackground ? "ON" : "OFF",
        description: "Run the agent in the background",
        values: ["ON", "OFF"],
      },
      ...(inGitRepo
        ? [{
            id: "worktree",
            label: "Worktree",
            currentValue: currentWorktreeLabel,
            description: "Run in a linked git worktree instead of parent cwd",
            submenu: (_v: string, done: (v?: string) => void) => {
              const pickerItems = [
                { value: "Inherits parent cwd", label: "Inherits parent cwd" },
                ...worktrees.map(wt => {
                  const branchLabel = wt.isDetached ? "detached" : (wt.branch ?? "detached");
                  const truncPath = truncatePath(wt.path);
                  return { value: wt.path, label: truncPath, provider: branchLabel };
                }),
              ];
              return createSearchableSelect(
                pickerItems,
                {
                  onSelect: (value) => {
                    void (async () => {
                      if (value === "Inherits parent cwd") {
                        currentWorktreePath = undefined;
                        currentWorktreeLabel = "Inherits parent cwd";
                        await applyWorktreeSelection();
                        done(currentWorktreeLabel);
                        return;
                      }

                      const wt = worktrees.find(w => w.path === value);
                      currentWorktreePath = wt?.path;
                      currentWorktreeLabel = wt?.branch ?? "detached";
                      await applyWorktreeSelection(currentWorktreePath);
                      done(currentWorktreeLabel);
                    })();
                  },
                  onCancel: () => done(),
                },
                theme,
              );
            },
          } as SettingItem]
        : []),
      {
        id: "type",
        label: "Agent type",
        currentValue: selectedType,
        description: configFor(selectedType)?.description ?? "Agent type",
        submenu: (_v: string, done: (v?: string) => void) => createSearchableSelect(
          availableTypes().map(type => ({
            value: type,
            label: type,
            description: configFor(type)?.description ?? "Agent type",
          })),
          {
            onSelect: (type) => {
              selectedType = resolveSelectedType(type) ?? type;
              refreshTypeDefaults();
              refreshTypeDerivedItemValues();
              done(selectedType);
            },
            onCancel: () => done(),
          },
          theme,
        ),
      },
      {
        id: "thinkingLevel",
        label: "Thinking level",
        currentValue: currentThinking ?? "inherit",
        description: "Set the reasoning effort level",
        values: [...VALID_THINKING_LEVELS, "inherit"],
      },
      {
        id: "maxTokens",
        label: "Max tokens",
        currentValue: fmtNum(currentMaxTokens),
        description: "Maximum tokens the agent can consume",
        submenu: createNumericSubmenu(ctx, (parsed) => { maxTokensOverridden = true; currentMaxTokens = parsed; }, () => { maxTokensOverridden = true; currentMaxTokens = undefined; }),
      },
      {
        id: "maxTurns",
        label: "Max turns",
        currentValue: fmtNum(currentMaxTurns),
        description: "Maximum conversation turns before hard stop",
        submenu: createNumericSubmenu(ctx, (parsed) => { maxTurnsOverridden = true; currentMaxTurns = parsed; }, () => { maxTurnsOverridden = true; currentMaxTurns = undefined; }),
      },
      {
        id: "graceTurns",
        label: "Grace turns",
        currentValue: String(currentGraceTurns),
        description: "Extra turns after soft limit before abort",
        submenu: createNumericSubmenu(ctx, { min: 0, default: DEFAULT_GRACE_TURNS }, (parsed) => { currentGraceTurns = parsed; }),
      },
      { id: "__sep__", label: " ", currentValue: "" },
      {
        id: "description",
        label: "Description",
        currentValue: currentDescription,
        description: "Short label shown in the agents list",
        submenu: createInputSubmenu(ctx),
      },
      {
        id: "prompt",
        label: "Prompt",
        currentValue: prompt,
        description: "The user message sent to the agent",
        submenu: createInputSubmenu(ctx, { required: true }),
      }
    );

    return items;
  };

  let theme: Theme;
  let doneRef: () => void;

  await ctx.ui.custom((_tui, t, _kb, done) => {
    theme = t;
    doneRef = () => done(undefined);

    const items = buildItems();
    const onChange = (id: string, newValue: string) => {
      switch (id) {
        case "thinkingLevel":
          thinkingOverridden = true;
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
    return new SettingsListWrapper(settingsList, { title: "Spawn Options", theme, onCancel: () => doneRef() });
  });
}
