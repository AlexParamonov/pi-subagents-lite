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
import type { ThinkingLevel } from "../types.js";
import { getAgentConfig, getAvailableTypes, resolveType, discoverNewAgents } from "../agents/agent-types.js";
import { findModelInRegistry } from "../utils.js";
import { promptModelSelection, parseNumericInput } from "../ui/menu/menu-helpers.js";
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
 * Show the spawn agent flow: type selection → prompt → options sub-menu → spawn.
 * Escape at any step aborts the flow and returns to the main menu.
 */
export async function showSpawnAgentMenu(
  ctx: ExtensionCommandContext,
  modelOptions: string[],
): Promise<void> {
  // Step 1: Type selection loop (unknown type → error → retry)
  let selectedType: string;
  while (true) {
    const types = getAvailableTypes();
    if (types.length === 0) {
      ctx.ui.notify("No agent types available", "error");
      return;
    }
    const type = await ctx.ui.select("Select agent type", types);
    if (type === undefined) return; // Escape → main menu

    const config = getAgentConfig(type);
    if (!config) {
      ctx.ui.notify(`Unknown agent type: ${type}`, "error");
      continue; // Loop back to type selection
    }
    selectedType = type;
    break;
  }

  const agentConfig = getAgentConfig(selectedType)!;

  // Step 2: Prompt entry loop (empty prompt → error → retry)
  let prompt: string;
  while (true) {
    const input = await ctx.ui.input("Agent prompt");
    if (input === undefined) return; // Escape → main menu

    if (!input.trim()) {
      ctx.ui.notify("Prompt cannot be empty", "error");
      continue; // Loop back to prompt input
    }
    prompt = input.trim();
    break;
  }

  // Step 3: Options sub-menu with spawn action
  const autoDescription = prompt.length > 50 ? prompt.slice(0, 50) : prompt;
  let description = autoDescription;

  // Check if parent's cwd is inside a git repo (for worktree picker visibility)
  const session = getSessionCtx();
  const parentCwd = session?.cwd ?? "";
  const inGitRepo = parentCwd ? await isInGitRepo(parentCwd) : false;

  // Worktree picker state
  let currentWorktreePath: string | undefined;
  let currentWorktreeLabel = "Inherits parent cwd";

  // Pre-fill model from precedence chain
  const store = getStore();
  const parentModelId = session?.model
    ? `${session.model.provider}/${session.model.id}`
    : "";
  const effectiveModelStr = store.modelFor(selectedType, parentModelId, agentConfig);
  let currentModelStr = effectiveModelStr || ""; // "" means inherit parent
  // Thinking: agent config → config default → inherit
  let currentThinking: ThinkingLevel | undefined = agentConfig.thinkingLevel ?? store.agent.defaultThinking;
  // Max turns: agent config → config default → unlimited
  let currentMaxTurns: number | undefined = agentConfig.maxTurns ?? store.agent.defaultMaxTurns;
  // Max tokens: agent config only (no config default)
  let currentMaxTokens: number | undefined = agentConfig.maxTokens;
  let currentGraceTurns: number | undefined = store.agent.graceTurns;
  let currentBackground: boolean = store.agent.forceBackground;

  while (true) {
    const displayModel = currentModelStr || "(inherits parent)";
    const displayThinking = currentThinking ?? "inherit";
    const displayMaxTurns = currentMaxTurns != null ? String(currentMaxTurns) : "unlimited";
    const displayMaxTokens = currentMaxTokens != null ? String(currentMaxTokens) : "unlimited";
    const displayGraceTurns = String(currentGraceTurns ?? 6);
    const displayBackground = currentBackground ? "ON" : "OFF";

    const items = [
      "Spawn",
      "",
      `Model · ${displayModel}`,
      `Background · ${displayBackground}`,
      `Thinking · ${displayThinking}`,
      `Max turns · ${displayMaxTurns}`,
      `Max tokens · ${displayMaxTokens}`,
      `Grace turns · ${displayGraceTurns}`,
      `Description · ${description}`,
    ];

    if (inGitRepo) {
      items.push(`Worktree · ${currentWorktreeLabel}`);
    };

    const choice = await ctx.ui.select("Spawn Options", items);
    if (choice === undefined) return; // Escape → main menu

    if (choice === "Spawn") {
      // Resolve model string to Model object
      let model: ReturnType<typeof findModelInRegistry> = undefined;
      let modelKey: string | undefined;

      if (currentModelStr) {
        const registry = session?.modelRegistry ?? ctx.modelRegistry;
        model = findModelInRegistry(currentModelStr, registry, undefined);
        if (!model) {
          ctx.ui.notify(`Model not found: ${currentModelStr}`, "error");
          continue; // Return to options sub-menu
        }
        modelKey = `${model.provider}/${model.id}`;
      }

      // Discover worktree-local agent types before spawn
      if (currentWorktreePath) {
        await discoverNewAgents(`${currentWorktreePath}/.pi/agents`);
      }
      // Resolve type (may have been discovered from worktree)
      const resolvedType = resolveType(selectedType) ?? selectedType;

      // Set UI context so widget can render (same as tool_execution_start handler)
      const widget = getWidget();
      if (widget) {
        widget.setUICtx(ctx.ui as unknown as import("../ui/agent-widget.js").UICtx);
        widget.ensureTimer();
      }

      // Use SpawnCoordinator for unified spawn path
      const coordinator = getCoordinator()!;
      try {
        const result = await coordinator.spawn(getPiInstance(), session!, {
          type: resolvedType,
          prompt,
          description,
          model,
          modelKey,
          maxTurns: currentMaxTurns,
          maxTokens: currentMaxTokens,
          thinkingLevel: currentThinking,
          graceTurns: currentGraceTurns,
          worktreePath: currentWorktreePath,
          worktreeLabel: currentWorktreePath ? currentWorktreeLabel : undefined,
          invocation: {
            modelName: model?.id,
            thinkingLevel: currentThinking,
            maxTurns: currentMaxTurns,
            runInBackground: currentBackground,
          },
          runInBackground: currentBackground,
        });

        if (currentBackground) {
          return; // Background: return to main menu immediately
        }

        // Foreground: coordinator.spawn() already awaited completion
        getWidget()?.markFinished(result.agentId);
        getWidget()?.update();
        return; // Return to main menu
      } catch (err) {
        ctx.ui.notify(
          `Spawn failed: ${err instanceof Error ? err.message : String(err)}`,
          "error",
        );
        return; // Return to main menu
      }
    }

    // Handle option changes
    if (choice.startsWith("Description")) {
      const input = await ctx.ui.input("Description", description);
      if (input !== undefined && input.trim()) {
        description = input.trim();
      }
    } else if (choice.startsWith("Model")) {
      const chosen = await promptModelSelection(
        ctx, modelOptions, currentModelStr || "(inherits parent)",
      );
      if (chosen !== null) {
        currentModelStr = chosen === "(inherits parent)" ? "" : chosen;
      }
    } else if (choice.startsWith("Thinking")) {
      const allLevels = [...THINKING_LEVELS, "inherit"];
      const chosen = await ctx.ui.select("Thinking level", allLevels);
      if (chosen !== undefined) {
        currentThinking = chosen === "inherit" ? undefined : (chosen as ThinkingLevel);
      }
    } else if (choice.startsWith("Max turns")) {
      const initial = currentMaxTurns != null ? String(currentMaxTurns) : "unlimited";
      const input = await ctx.ui.input("Max turns (number or 'unlimited')", initial);
      if (input !== undefined) {
        const trimmed = input.trim().toLowerCase();
        if (trimmed === "unlimited" || trimmed === "") {
          currentMaxTurns = undefined;
        } else {
          const parsed = parseInt(trimmed, 10);
          if (isNaN(parsed) || parsed < 1) {
            ctx.ui.notify("Invalid value — must be a number ≥ 1 or 'unlimited'", "error");
          } else {
            currentMaxTurns = parsed;
          }
        }
      }
    } else if (choice.startsWith("Max tokens")) {
      const initial = currentMaxTokens != null ? String(currentMaxTokens) : "unlimited";
      const input = await ctx.ui.input("Max tokens (number or 'unlimited')", initial);
      if (input !== undefined) {
        const trimmed = input.trim().toLowerCase();
        if (trimmed === "unlimited" || trimmed === "") {
          currentMaxTokens = undefined;
        } else {
          const parsed = parseInt(trimmed, 10);
          if (isNaN(parsed) || parsed < 1) {
            ctx.ui.notify("Invalid value — must be a number ≥ 1 or 'unlimited'", "error");
          } else {
            currentMaxTokens = parsed;
          }
        }
      }
    } else if (choice.startsWith("Grace turns")) {
      const parsed = await parseNumericInput(ctx, "Grace turns (≥ 0)", String(currentGraceTurns ?? 6), 0, "≥ 0");
      if (parsed !== undefined) currentGraceTurns = parsed;
    } else if (choice.startsWith("Background")) {
      currentBackground = !currentBackground;
    } else if (choice.startsWith("Worktree") && inGitRepo) {
      // Open worktree picker
      const worktrees = await listWorktrees(parentCwd);
      if (!worktrees || worktrees.length === 0) {
        ctx.ui.notify(
          "No worktrees found or git worktree list unavailable",
          "error",
        );
        continue; // Return to options sub-menu
      }

      const pickerItems = [
        "Inherits parent cwd",
        ...worktrees.map(wt => {
          const branchLabel = wt.isDetached ? "detached" : (wt.branch ?? "detached");
          const truncPath = truncatePath(wt.path);
          return `${branchLabel}  ·  ${truncPath}`;
        }),
      ];

      const picked = await ctx.ui.select("Select worktree", pickerItems);
      if (picked === undefined) continue; // Escape → return to options sub-menu

      if (picked === "Inherits parent cwd") {
        currentWorktreePath = undefined;
        currentWorktreeLabel = "Inherits parent cwd";
      } else {
        // Find the matching worktree by index (offset by "Inherits parent cwd")
        const idx = pickerItems.indexOf(picked) - 1;
        if (idx >= 0 && idx < worktrees.length) {
          const wt = worktrees[idx];
          currentWorktreePath = wt.path;
          currentWorktreeLabel = wt.branch ?? "detached";
        }
      }
    }
  }
}
