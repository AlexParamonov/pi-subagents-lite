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
import type { AgentConfig } from "../../agents/types.js";
import type { Theme } from "../types.js";
import { getAgentConfig, getAvailableTypes, resolveType, resolveAgentCatalog, resolveTypeInCatalog, snapshotAgentConfig } from "../../agents/agent-types.js";
import { findModelInRegistry } from "../../utils.js";
import { normalizeThinkingLevel, supportedThinkingLevels } from "../../models/thinking.js";
import { buildModelOptions, buildSettingsListTheme, buildSelectListTheme, createSearchableSelect } from "./helpers.js";
import { DEFAULT_GRACE_TURNS } from "../../config/config-io.js";
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
  // Worktree catalogs belong to this invocation and never mutate the parent registry.
  let catalog: Map<string, AgentConfig> | undefined;
  const availableTypes = () => catalog
    ? [...catalog.entries()].filter(([, config]) => config.hidden !== true).map(([name]) => name)
    : getAvailableTypes();
  const configFor = (type: string): AgentConfig | undefined => {
    if (!catalog) return getAgentConfig(type);
    const key = resolveTypeInCatalog(catalog, type);
    return key ? catalog.get(key) : undefined;
  };
  const resolveSelectedType = (type: string) => catalog
    ? resolveTypeInCatalog(catalog, type)
    : resolveType(type);

  const session = getSessionCtx();
  const parentCwd = session?.cwd ?? "";
  const inGitRepo = parentCwd ? await isInGitRepo(parentCwd) : false;
  const worktrees = inGitRepo ? (await listWorktrees(parentCwd)) ?? [] : [];
  let initialWorktreePath: string | undefined;
  let initialWorktreeLabel = "Inherits parent cwd";

  // If the parent has no visible types, a trusted worktree can still provide
  // the complete initial catalog (including worktree-only definitions).
  if (availableTypes().length === 0) {
    if (!inGitRepo || worktrees.length === 0 || !ctx.isProjectTrusted()) {
      ctx.ui.notify("No agent types available", "error");
      return;
    }
    const chosen = await ctx.ui.custom<string | undefined>((_tui, theme, _kb, done) => createSearchableSelect(
      worktrees.map(wt => ({
        value: wt.path,
        label: truncatePath(wt.path),
        provider: wt.isDetached ? "detached" : (wt.branch ?? "detached"),
      })),
      { onSelect: value => done(value), onCancel: () => done(undefined) },
      theme,
    ));
    if (!chosen) return;
    initialWorktreePath = chosen;
    initialWorktreeLabel = worktrees.find(wt => wt.path === chosen)?.branch ?? "detached";
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

    const resolved = resolveSelectedType(result);
    const config = resolved ? configFor(resolved) : undefined;
    if (!resolved || !config) {
      ctx.ui.notify(`Unknown agent type: ${result}`, "error");
      return;
    }
    selectedType = resolved;
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
  let currentResolvedType = selectedType;
  let currentAgentConfig = configFor(selectedType);
  let currentModelStr = store.modelFor(currentResolvedType, parentModelId, currentAgentConfig) || "";
  let modelChanged = false;
  let thinkingChanged = false;
  let maxTurnsChanged = false;
  let maxTokensChanged = false;
  let currentThinking: ThinkingLevel | undefined = store.thinkingSettingFor(
    currentResolvedType,
    session?.thinkingLevel,
    currentAgentConfig,
  ).value;
  let currentMaxTurns: number | undefined = currentAgentConfig?.maxTurns ?? store.agent.defaultMaxTurns;
  let currentMaxTokens: number | undefined = currentAgentConfig?.maxTokens;
  let currentGraceTurns: number = store.agent.graceTurns ?? DEFAULT_GRACE_TURNS;
  let currentBackground: boolean = store.agent.forceBackground;
  let currentWorktreePath: string | undefined = initialWorktreePath;
  let currentWorktreeLabel = initialWorktreeLabel;
  let currentDescription = prompt.length > 50 ? prompt.slice(0, 50) : prompt;
  let rebuild: ((items: SettingItem[]) => void) | undefined;
  let worktreeResolutionRequest = 0;

  const applyAgentConfig = (type: string, config: AgentConfig) => {
    selectedType = type;
    currentResolvedType = type;
    currentAgentConfig = config;
    if (!modelChanged) currentModelStr = store.modelFor(type, parentModelId, config) || "";
    if (!thinkingChanged) currentThinking = store.thinkingSettingFor(type, session?.thinkingLevel, config).value;
    if (!maxTurnsChanged) currentMaxTurns = config.maxTurns ?? store.agent.defaultMaxTurns;
    if (!maxTokensChanged) currentMaxTokens = config.maxTokens;
  };

  /** Resolve the complete selected catalog locally, ignoring stale picker results. */
  const applyWorktreeSelection = async (worktreePath?: string): Promise<void> => {
    const request = ++worktreeResolutionRequest;
    let nextCatalog: Map<string, AgentConfig> | undefined;
    if (worktreePath && ctx.isProjectTrusted()) {
      nextCatalog = await resolveAgentCatalog(`${worktreePath}/.pi/agents`, {
        disableDefaultAgents: store.agent.disableDefaultAgents,
      });
    } else if (worktreePath) {
      // Do not read project-controlled Markdown before trust is granted.
      ctx.ui.notify("Worktree agent definitions are unavailable because the project is not trusted; using the parent agent definition.", "warning");
    }
    if (request !== worktreeResolutionRequest) return;

    catalog = nextCatalog;
    const types = availableTypes();
    const resolved = resolveSelectedType(selectedType);
    const type = resolved && types.includes(resolved) ? resolved : types[0];
    const config = type ? configFor(type) : undefined;
    if (type && config) applyAgentConfig(type, config);
    else {
      currentResolvedType = "";
      currentAgentConfig = undefined;
    }
    rebuild?.(buildItems());
  };

  const currentModel = () => findModelInRegistry(
    currentModelStr || parentModelId,
    session?.modelRegistry ?? ctx.modelRegistry,
    session?.model ?? ctx.model,
  );

  const createAdvancedOptionsMenu = (theme: Theme, done: (value?: string) => void) => {
    const fmtNum = (value: number | undefined) => value != null ? String(value) : "(not set)";
    const thinkingModel = currentModel();
    const requestedThinking = currentThinking ?? session?.thinkingLevel;
    const displayedThinking = thinkingModel?.reasoning === false
      ? "off"
      : normalizeThinkingLevel(thinkingModel, requestedThinking);
    const thinkingLevels = supportedThinkingLevels(thinkingModel);
    const items: SettingItem[] = [
      ...(inGitRepo ? [{
        id: "worktree",
        label: "Worktree",
        currentValue: currentWorktreeLabel,
        description: "Run in a linked git worktree instead of the parent cwd.",
        submenu: (_value: string, subDone: (value?: string) => void) => createSearchableSelect(
          [
            { value: "Inherits parent cwd", label: "Inherits parent cwd" },
            ...worktrees.map((worktree) => ({
              value: worktree.path,
              label: truncatePath(worktree.path),
              provider: worktree.isDetached ? "detached" : (worktree.branch ?? "detached"),
            })),
          ],
          {
            onSelect: (value) => {
              if (value === "Inherits parent cwd") {
                currentWorktreePath = undefined;
                currentWorktreeLabel = value;
                subDone(value);
                void applyWorktreeSelection(undefined);
              } else {
                const worktree = worktrees.find((entry) => entry.path === value);
                currentWorktreePath = worktree?.path;
                currentWorktreeLabel = worktree?.branch ?? "detached";
                subDone(currentWorktreeLabel);
                void applyWorktreeSelection(currentWorktreePath);
              }
            },
            onCancel: () => subDone(),
          },
          theme,
          currentWorktreePath ?? "Inherits parent cwd",
        ),
      } as SettingItem] : []),
      {
        id: "type",
        label: "Agent type",
        currentValue: selectedType,
        description: configFor(selectedType)?.description ?? "Agent type",
        submenu: (_value: string, subDone: (value?: string) => void) => createSearchableSelect(
          availableTypes().map(type => ({
            value: type,
            label: type,
            description: configFor(type)?.description ?? "Agent type",
          })),
          {
            onSelect: (type) => {
              const resolved = resolveSelectedType(type);
              const config = resolved ? configFor(resolved) : undefined;
              if (resolved && config) applyAgentConfig(resolved, config);
              rebuild?.(buildItems());
              subDone(selectedType);
            },
            onCancel: () => subDone(),
          },
          theme,
          selectedType,
        ),
      },
      {
        id: "thinkingLevel",
        label: "Thinking level",
        currentValue: displayedThinking ?? "inherit",
        values: ["inherit", ...thinkingLevels],
        description: "Set the reasoning effort level.",
      },
      {
        id: "maxTokens",
        label: "Max tokens",
        currentValue: fmtNum(currentMaxTokens),
        submenu: createNumericSubmenu(ctx, (parsed) => {
          maxTokensChanged = true;
          currentMaxTokens = parsed;
        }, () => {
          maxTokensChanged = true;
          currentMaxTokens = undefined;
        }),
        description: "Maximum tokens the agent can consume.",
      },
      {
        id: "maxTurns",
        label: "Max turns",
        currentValue: fmtNum(currentMaxTurns),
        submenu: createNumericSubmenu(ctx, (parsed) => {
          maxTurnsChanged = true;
          currentMaxTurns = parsed;
        }, () => {
          maxTurnsChanged = true;
          currentMaxTurns = undefined;
        }),
        description: "Maximum conversation turns before the hard stop.",
      },
      {
        id: "graceTurns",
        label: "Grace turns",
        currentValue: String(currentGraceTurns),
        submenu: createNumericSubmenu(ctx, { min: 0, default: DEFAULT_GRACE_TURNS }, (parsed) => { currentGraceTurns = parsed; }),
        description: "Extra turns after the soft limit before aborting.",
      },
      {
        id: "description",
        label: "Description",
        currentValue: currentDescription,
        submenu: createInputSubmenu(ctx),
        description: "Short label shown in the agents list.",
      },
    ];
    return new SettingsList(items, 10, buildSettingsListTheme(theme), (id, value) => {
      if (id === "thinkingLevel") {
        thinkingChanged = true;
        currentThinking = value === "inherit" ? undefined : value as ThinkingLevel;
      } else if (id === "description") {
        currentDescription = value;
      }
    }, () => done());
  };

  const buildItems = (): SettingItem[] => {
    const displayModel = currentModelStr || "(inherits parent)";
    const items: SettingItem[] = [
      {
        id: "spawn",
        label: "Spawn",
        currentValue: "",
        description: "Spawn the agent with current settings",
        submenu: (_v, done) => {
          const graceTurns = currentGraceTurns;
          const background = currentBackground;
          const description = currentDescription;
          const spawnPrompt = prompt;

          const doSpawn = async () => {
            // Re-read the selected worktree only into an invocation-local
            // catalog and snapshot that exact config for queued work.
            let finalCatalog = catalog;
            if (currentWorktreePath) {
              if (ctx.isProjectTrusted()) {
                finalCatalog = await resolveAgentCatalog(`${currentWorktreePath}/.pi/agents`, {
                  disableDefaultAgents: store.agent.disableDefaultAgents,
                });
              } else {
                ctx.ui.notify("Worktree agent definitions are unavailable because the project is not trusted; using the parent agent definition.", "warning");
                finalCatalog = undefined;
              }
            }
            const resolvedType = finalCatalog
              ? resolveTypeInCatalog(finalCatalog, selectedType)
              : resolveType(selectedType);
            const refreshedConfig = resolvedType
              ? (finalCatalog ? finalCatalog.get(resolvedType) : getAgentConfig(resolvedType))
              : undefined;
            if (!resolvedType || !refreshedConfig || (finalCatalog && refreshedConfig.hidden === true)) {
              ctx.ui.notify("No valid agent type selected", "error");
              return;
            }
            const modelStr = modelChanged
              ? currentModelStr
              : store.modelFor(resolvedType, parentModelId, refreshedConfig);
            const thinking = thinkingChanged
              ? currentThinking
              : store.thinkingSettingFor(resolvedType, session?.thinkingLevel, refreshedConfig).value;
            const maxTurns = maxTurnsChanged
              ? currentMaxTurns
              : refreshedConfig.maxTurns ?? store.agent.defaultMaxTurns;
            const maxTokens = maxTokensChanged ? currentMaxTokens : refreshedConfig.maxTokens;

            let model: ReturnType<typeof findModelInRegistry> = undefined;
            let modelKey: string | undefined;
            if (modelStr) {
              const registry = session?.modelRegistry ?? ctx.modelRegistry;
              model = findModelInRegistry(modelStr, registry, undefined);
              if (!model) {
                ctx.ui.notify(`Model not found: ${modelStr}`, "error");
                return;
              }
              modelKey = `${model.provider}/${model.id}`;
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
                prompt: spawnPrompt,
                description,
                agentConfig: snapshotAgentConfig(refreshedConfig),
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
        submenu: (_currentValue, done) => createSearchableSelect(
          buildModelOptions(modelOptions),
          {
            onSelect: (model) => {
              modelChanged = true;
              currentModelStr = model === "(inherits parent)" ? "" : model;
              rebuild?.(buildItems());
              done(model);
            },
            onCancel: () => done(),
          },
          theme,
          displayModel,
        ),
      },
      {
        id: "background",
        label: "Background",
        currentValue: currentBackground ? "ON" : "OFF",
        description: "Run the agent in the background",
        values: ["ON", "OFF"],
      },
      {
        id: "advanced",
        label: "Advanced options",
        currentValue: "→",
        description: "Worktree, type, thinking, token and turn limits, grace turns, and description.",
        submenu: (_currentValue, done) => createAdvancedOptionsMenu(theme, done),
      },
      {
        id: "prompt",
        label: "Prompt",
        currentValue: prompt,
        description: "The user message sent to the agent",
        submenu: createInputSubmenu(ctx, { required: true }),
      }
    ];

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
          thinkingChanged = true;
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
    return new SettingsListWrapper(settingsList, {
      title: "Spawn Options",
      theme,
      onCancel: () => doneRef(),
      onRebuild: (callback) => { rebuild = callback; },
    });
  });
}
