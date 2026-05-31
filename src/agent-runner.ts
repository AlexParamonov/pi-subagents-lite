/**
 * Core execution engine: creates sessions, runs agents, collects results.
 *
 * EXCLUDED_TOOL_NAMES prevents sub-subagent spawning.
 */

import path from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  type AgentSession,
  type AgentSessionEvent,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  getAgentDir,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { getAgentConfig, getConfig, getToolNamesForType, BUILTIN_TOOL_NAMES } from "./agent-types.js";
import { extractText } from "./context.js";
import type { LifetimeUsage } from "./usage.js";
import { findModelInRegistry } from "./utils.js";
import { DEFAULT_AGENTS } from "./default-agents.js";
import { buildAgentPrompt, type PromptExtras } from "./prompts.js";
import { preloadSkills, loadSkillMeta, type SkillMeta } from "./skill-loader.js";
import { type CompactionInfo, type EnvInfo, SHORT_ID_LENGTH, type SubagentType, type ThinkingLevel } from "./types.js";

/** Names of tools registered by this extension that subagents must NOT inherit. */
const EXCLUDED_TOOL_NAMES = ["Agent"];

/** Additional turns allowed after the soft limit steer message. */
const GRACE_TURNS = 5;

/** Timeout for quick git commands (branch detection, repo check). */
const GIT_EXEC_TIMEOUT_MS = 5000;

/** Normalize max turns. undefined or 0 = unlimited, otherwise minimum 1. */
function normalizeMaxTurns(n: number | undefined): number | undefined {
  if (n == null || n === 0) return undefined;
  return Math.max(1, n);
}

/** Info about a tool event in the subagent. */
export interface ToolActivity {
  type: "start" | "end";
  toolName: string;
}

interface RunOptions {
  /** ExtensionAPI instance — used for pi.exec() for git detection. */
  pi: ExtensionAPI;
  /** Manager-assigned id; suffixes session name to disambiguate parallel spawns (e.g. `Explore#a1b2c3d4`). */
  agentId?: string;
  model?: Model<any>;
  maxTurns?: number;
  signal?: AbortSignal;
  thinkingLevel?: ThinkingLevel;
  /** Override working directory. */
  cwd?: string;
  /** Called on tool start/end with activity info. */
  onToolActivity?: (activity: ToolActivity) => void;
  /** Called on streaming text deltas from the assistant response. */
  onTextDelta?: (delta: string, fullText: string) => void;
  onSessionCreated?: (session: AgentSession) => void;
  /** Called at the end of each agentic turn with the cumulative count. */
  onTurnEnd?: (turnCount: number) => void;
  /**
   * Called once per assistant message_end with that message's usage delta.
   * Lets callers maintain a lifetime accumulator that survives compaction
   * (which replaces session.state.messages and resets stats-derived sums).
   */
  onAssistantUsage?: (usage: LifetimeUsage) => void;
  /**
   * Called when the session successfully compacts. `tokensBefore` is upstream's
   * pre-compaction context size estimate. Aborted compactions don't fire.
   */
  onCompaction?: (info: CompactionInfo) => void;
}

interface RunResult {
  responseText: string;
  session: AgentSession;
  /** True if the agent was hard-aborted (max_turns + grace exceeded). */
  aborted: boolean;
  /** True if the agent was steered to wrap up (hit soft turn limit) but finished in time. */
  steered: boolean;
}

/**
 * Subscribe to a session and collect the last assistant message text.
 * Returns an object with a `getText()` getter and an `unsubscribe` function.
 */
function collectResponseText(
  session: AgentSession,
  onTextDelta?: (delta: string, fullText: string) => void,
) {
  let text = "";
  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "message_start") {
      text = "";
    }
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      text += event.assistantMessageEvent.delta;
      onTextDelta?.(event.assistantMessageEvent.delta, text);
    }
  });
  return { getText: () => text, unsubscribe };
}

/** Get the last assistant text from the completed session history. */
function getLastAssistantText(session: AgentSession): string {
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const msg = session.messages[i];
    if (msg.role !== "assistant") continue;
    const text = extractText(msg.content).trim();
    if (text) return text;
  }
  return "";
}

/**
 * Wire an AbortSignal to abort a session.
 * Returns a cleanup function to remove the listener.
 */
function forwardAbortSignal(session: AgentSession, signal?: AbortSignal): () => void {
  if (!signal) return () => {};
  const onAbort = () => session.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}

/**
 * Extract a LifetimeUsage from a runtime assistant message_end event.
 * pi-ai attaches `usage: { input, output, cacheWrite, cost: { total } }` to
 * assistant messages at runtime, but this shape isn't reflected in the
 * AgentSessionEvent public types.
 */
function usageFromAssistantMessage(msg: Record<string, unknown>): LifetimeUsage | undefined {
  const usage = msg.usage as Record<string, unknown> | undefined;
  if (!usage) return undefined;
  return {
    input: (usage.input as number) ?? 0,
    output: (usage.output as number) ?? 0,
    cacheWrite: (usage.cacheWrite as number) ?? 0,
    cost: ((usage.cost as Record<string, unknown>)?.total as number) ?? 0,
  };
}

/**
 * Subscribe to shared session events (tool activity, usage, compaction)
 * used by runAgent. Returns an unsubscribe function.
 */
export function subscribeToSessionEvents(
  session: AgentSession,
  options: Pick<RunOptions, "onToolActivity" | "onAssistantUsage" | "onCompaction">,
): () => void {
  if (!options.onToolActivity && !options.onAssistantUsage && !options.onCompaction) {
    return () => {};
  }
  return session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "tool_execution_start") {
      options.onToolActivity?.({ type: "start", toolName: event.toolName });
    }
    if (event.type === "tool_execution_end") {
      options.onToolActivity?.({ type: "end", toolName: event.toolName });
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
      const msg = event.message as unknown as Record<string, unknown>;
      const usage = usageFromAssistantMessage(msg);
      if (usage) {
        options.onAssistantUsage?.(usage);
      }
    }
    if (event.type === "compaction_end" && !event.aborted && event.result) {
      options.onCompaction?.({ reason: event.reason, tokensBefore: event.result.tokensBefore });
    }
  });
}

/**
 * Extract the extension name from an extension's file path.
 *
 * Handles all distribution methods:
 *  - git packages: `.../git/github.com/<user>/<pkg>/...` → "<pkg>"
 *  - npm packages: `.../node_modules/[...]pkg/...` → "pkg"
 *  - local extensions: `~/.pi/agent/extensions/<name>/...` → "<name>"
 *  - direct files: `extensions/<name>.ts` → "<name>"
 *
 * Does NOT depend on internal directory structure (dist/, lib/, src/, etc).
 * Only cares about the package root, which is determined by distribution method.
 */
function extractExtensionName(extPath: string): string {
  const parts = extPath.split(path.sep);

  // 1. Git package: .../git/github.com/<user>/<pkg>/...
  //    Package name is 3 dirs after 'git' (github.com/user/pkg)
  const gitIdx = parts.indexOf("git");
  if (gitIdx !== -1 && gitIdx + 3 < parts.length) {
    return parts[gitIdx + 3];
  }

  // 2. npm package: .../node_modules/[...]pkg/...
  const nmIdx = parts.lastIndexOf("node_modules");
  if (nmIdx !== -1 && nmIdx + 1 < parts.length) {
    const next = parts[nmIdx + 1];
    if (next.startsWith("@") && nmIdx + 2 < parts.length) {
      return parts[nmIdx + 2]; // @scope/pkg → pkg
    }
    return next;
  }

  // 3. Local extension: .../extensions/<name>/... or .../extensions/<name>.ts
  const extIdx = parts.lastIndexOf("extensions");
  if (extIdx !== -1 && extIdx + 1 < parts.length) {
    const afterExt = parts[extIdx + 1];
    // Subdirectory: extensions/tavily/index.ts → tavily
    if (afterExt && !afterExt.includes(".")) {
      return afterExt;
    }
    // Direct file: extensions/review.ts → review
    const file = parts[parts.length - 1];
    return path.basename(file, path.extname(file));
  }

  // Fallback: parent dir name
  return path.basename(path.dirname(extPath));
}

/**
 * Resolve tool entries (with ext/* syntax) into concrete tool names.
 * Returns a set of resolved tool names.
 */
function resolveToolEntries(
  entries: string[],
  extToolMap: Map<string, string[]> | undefined,
  notify?: (msg: string) => void,
): Set<string> {
  const resolved = new Set<string>();

  for (const entry of entries) {
    const slashIdx = entry.indexOf("/");
    if (slashIdx !== -1) {
      // ext/* or ext/tool syntax
      const extName = entry.slice(0, slashIdx);
      const toolPart = entry.slice(slashIdx + 1);
      if (toolPart === "*") {
        const extTools = extToolMap?.get(extName);
        if (extTools && extTools.length > 0) {
          for (const t of extTools) resolved.add(t);
        } else {
          notify?.(`extension "${extName}" is not loaded, "${entry}" will have no effect`);
        }
      } else {
        // ext/tool syntax: e.g. "tavily/web_search"
        resolved.add(toolPart);
      }
    } else {
      // Bare tool name
      resolved.add(entry);
    }
  }

  return resolved;
}

/**
 * Filter active tools: apply tools allowlist/denylist and EXCLUDED_TOOL_NAMES.
 *
 * The `tools` config controls which tool schemas the LLM sees (built-in + extension).
 * The `extensions` config controls which extensions are loaded (hooks + commands).
 * `extensions` does NOT affect tool visibility — that's `tools`'s job.
 *
 * Supports ext/* syntax for both whitelist and blacklist modes.
 *
 * `tools` and `excludeTools` are mutually exclusive. If both set, `tools` wins.
 *
 * Returns null when no filtering is needed, otherwise the filtered tool list.
 */
function filterActiveTools(
  activeTools: string[],
  extToolMap: Map<string, string[]> | undefined,
  tools: true | string[] | false | undefined,
  excludeTools: string[] | undefined,
  notify?: (msg: string) => void,
): string[] | null {
  // Blacklist mode: excludeTools set and tools not set as whitelist
  if (excludeTools && !Array.isArray(tools)) {
    const excludeSet = resolveToolEntries(excludeTools, extToolMap, notify);
    const filtered = activeTools.filter(t =>
      !EXCLUDED_TOOL_NAMES.includes(t) && !excludeSet.has(t)
    );
    return filtered.length !== activeTools.length ? filtered : null;
  }

  if (Array.isArray(tools)) {
    // Whitelist mode: resolve entries with ext/* expansion
    const allBuiltinSet = new Set(BUILTIN_TOOL_NAMES);
    const allowedTools = resolveToolEntries(tools, extToolMap, notify);

    // Warn about unknown entries
    for (const entry of tools) {
      const slashIdx = entry.indexOf("/");
      if (slashIdx === -1 && !allBuiltinSet.has(entry)) {
        // Bare name, not a known built-in — check if it's an extension tool
        const toolExts = extToolMap ? [...extToolMap.entries()].filter(([, tools]) => tools.includes(entry)) : [];
        if (toolExts.length === 0) {
          notify?.(`tool "${entry}" not found in any loaded extension`);
        }
      }
    }

    const visibleSet = new Set<string>();
    for (const t of activeTools) {
      if (EXCLUDED_TOOL_NAMES.includes(t)) continue;
      if (allowedTools.has(t)) {
        visibleSet.add(t);
      }
    }

    // Warn if a loaded extension has none of its tools in `tools`
    if (extToolMap) {
      for (const [extName, extTools] of extToolMap) {
        const hasAny = extTools.some(t => allowedTools.has(t));
        if (!hasAny) {
          notify?.(`extension "${extName}" is loaded but none of its tools are in tools: [${tools.join(", ")}]`);
        }
      }
    }

    return [...visibleSet];
  }

  if (tools === false) {
    return [];
  }

  // tools: true or undefined — all tools visible (except excluded)
  const hasExcluded = activeTools.some(t => EXCLUDED_TOOL_NAMES.includes(t));
  if (!hasExcluded) return null;
  return activeTools.filter(t => !EXCLUDED_TOOL_NAMES.includes(t));
}

/** Run a git command via pi.exec, returning stdout on success or null on failure. */
async function execGit(pi: ExtensionAPI, args: string[], cwd: string): Promise<string | null> {
  try {
    const result = await pi.exec("git", args, { cwd, timeout: GIT_EXEC_TIMEOUT_MS });
    return result.code === 0 ? result.stdout.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Detect environment info using pi.exec() for git detection.
 * Inline replacement for upstream's detectEnv from env.ts.
 */
async function detectEnv(pi: ExtensionAPI, cwd: string): Promise<EnvInfo> {
  const gitRoot = await execGit(pi, ["rev-parse", "--is-inside-work-tree"], cwd);
  const isGitRepo = gitRoot === "true";
  const branch = isGitRepo ? (await execGit(pi, ["branch", "--show-current"], cwd)) : null;

  return {
    isGitRepo,
    branch,
    platform: process.platform,
  };
}

export async function runAgent(
  ctx: ExtensionContext,
  type: SubagentType,
  prompt: string,
  options: RunOptions,
): Promise<RunResult> {
  const config = getConfig(type);
  const agentConfig = getAgentConfig(type);

  // Warn on mutual exclusion violations
  const notify = (msg: string) => {
    if (ctx.ui?.notify) {
      ctx.ui.notify(`[pi-subagents] ${msg}`, "warning");
    } else {
      console.warn(`[pi-subagents] ${msg}`);
    }
  };
  if (agentConfig?.excludeTools && Array.isArray(agentConfig.tools)) {
    notify(`agent "${type}": both tools and exclude_tools set — tools (whitelist) wins`);
  }
  if (agentConfig?.excludeExtensions && Array.isArray(agentConfig.extensions)) {
    notify(`agent "${type}": both extensions and exclude_extensions set — extensions (whitelist) wins`);
  }

  // Resolve working directory
  const effectiveCwd = options.cwd ?? ctx.cwd;

  const env = await detectEnv(options.pi, effectiveCwd);

  // Resolve extensions/skills from agent config (frontmatter)
  const extensions = config.extensions;
  const skills = config.skills;
  const preloadSkillsList = agentConfig?.preloadSkills;

  // Build prompt extras (skills only).
  const extras: PromptExtras = {};
  if (Array.isArray(preloadSkillsList)) {
    extras.skillBlocks = preloadSkills(preloadSkillsList, effectiveCwd);
  }
  if (Array.isArray(skills)) {
    extras.skillMetas = loadSkillMeta(skills, effectiveCwd);
  }

  const toolNames = getToolNamesForType(type);

  // Build system prompt from agent config
  let systemPrompt: string;
  if (agentConfig) {
    systemPrompt = buildAgentPrompt(agentConfig, effectiveCwd, env, extras);
  } else {
    // Unknown type fallback: spread the canonical general-purpose config
    const fallback = DEFAULT_AGENTS.get("general-purpose");
    if (!fallback) throw new Error(`No fallback config available for unknown type "${type}"`);
    systemPrompt = buildAgentPrompt({ ...fallback, name: type }, effectiveCwd, env, extras);
  }

  // Skip the built-in skill loader when:
  // - skills is false (no skills)
  // - preloadSkills is string[] (we handle preloading ourselves)
  // - skills is string[] (we handle metadata ourselves)
  const skipSkillLoader = skills === false || Array.isArray(skills) || Array.isArray(preloadSkillsList);

  const agentDir = getAgentDir();

  // Load extensions/skills: true or string[] → load; false → don't.
  // When extensions is an array, use extensionsOverride to selectively load
  // only the listed extensions (hooks/commands of excluded ones never fire).
  // When excludeExtensions is set (and extensions is not string[]), filter out those extensions.
  const loaderOpts: ConstructorParameters<typeof DefaultResourceLoader>[0] = {
    cwd: effectiveCwd,
    agentDir,
    noExtensions: extensions === false,
    noSkills: skipSkillLoader,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => systemPrompt,
    appendSystemPromptOverride: () => [],
  };
  const excludeExtSet = agentConfig?.excludeExtensions
    ? new Set(agentConfig.excludeExtensions)
    : undefined;
  if (Array.isArray(extensions)) {
    // Whitelist mode: only load listed extensions
    const allowedNames = new Set(extensions.map(ext => {
      const slashIdx = ext.indexOf("/");
      return slashIdx !== -1 ? ext.slice(0, slashIdx) : ext;
    }));
    loaderOpts.extensionsOverride = (result) => ({
      ...result,
      extensions: result.extensions.filter(ext =>
        allowedNames.has(extractExtensionName(ext.path)),
      ),
    });
  } else if (excludeExtSet) {
    // Blacklist mode: load all except excluded extensions
    loaderOpts.extensionsOverride = (result) => ({
      ...result,
      extensions: result.extensions.filter(ext =>
        !excludeExtSet.has(extractExtensionName(ext.path)),
      ),
    });
  }
  const loader = new DefaultResourceLoader(loaderOpts);
  await loader.reload();

  // Build extension name → tool names map from loaded extensions.
  // Used by filterActiveTools to resolve extension names in the extensions frontmatter field.
  const extResult = loader.getExtensions();
  const extToolMap = new Map<string, string[]>();
  for (const ext of extResult.extensions) {
    const name = extractExtensionName(ext.path);
    const tools = [...ext.tools.keys()];
    if (tools.length > 0) extToolMap.set(name, tools);
  }

  // Resolve model: explicit option > config.model > parent model
  const model = options.model ?? findModelInRegistry(
    agentConfig?.model, ctx.modelRegistry, ctx.model,
  );

  // Resolve thinking level: explicit option > agent config > undefined (inherit)
  const thinkingLevel = options.thinkingLevel ?? agentConfig?.thinking;

  const sessionOpts: Parameters<typeof createAgentSession>[0] = {
    cwd: effectiveCwd,
    agentDir,
    sessionManager: SessionManager.inMemory(effectiveCwd),
    settingsManager: SettingsManager.create(effectiveCwd, agentDir),
    modelRegistry: ctx.modelRegistry,
    model,
    tools: toolNames,
    resourceLoader: loader,
  };
  if (thinkingLevel) {
    sessionOpts.thinkingLevel = thinkingLevel;
  }

  const { session } = await createAgentSession(sessionOpts);

  const baseSessionName = agentConfig?.name ?? type;
  session.setSessionName(
    options.agentId ? `${baseSessionName}#${options.agentId.slice(0, SHORT_ID_LENGTH)}` : baseSessionName,
  );

  // Bind extensions so that session_start fires and extensions can initialize
  // This must happen BEFORE tool filtering — extensions like pi-mcp-adapter
  // register tools lazily during session_start, not at extension load time.
  await session.bindExtensions({
    onError: (err) => {
      options.onToolActivity?.({
        type: "end",
        toolName: `extension-error:${err.extensionPath}`,
      });
    },
  });

  // Rebuild extToolMap after session_start — extensions may have registered
  // new tools (e.g., pi-mcp-adapter registers 'mcp' tool at session_start).
  const postBindExtToolMap = new Map<string, string[]>();
  for (const ext of extResult.extensions) {
    const name = extractExtensionName(ext.path);
    const tools = [...ext.tools.keys()];
    if (tools.length > 0) postBindExtToolMap.set(name, tools);
  }

  // Filter active tools: apply tools allowlist/denylist and EXCLUDED_TOOL_NAMES
  const filteredTools = filterActiveTools(
    session.getActiveToolNames(),
    postBindExtToolMap,
    agentConfig?.tools,
    agentConfig?.excludeTools,
    (msg) => {
      if (ctx.ui?.notify) {
        ctx.ui.notify(`[pi-subagents] ${msg}`, "warning");
      } else {
        console.warn(`[pi-subagents] ${msg}`);
      }
    },
  );
  if (filteredTools) {
    session.setActiveToolsByName(filteredTools);
  }

  options.onSessionCreated?.(session);

  // Track turns for graceful max_turns enforcement
  let turnCount = 0;
  const maxTurns = normalizeMaxTurns(options.maxTurns ?? agentConfig?.maxTurns);
  let softLimitReached = false;
  let aborted = false;

  const unsubEvents = subscribeToSessionEvents(session, options);

  const unsubTurns = session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "turn_end") {
      turnCount++;
      options.onTurnEnd?.(turnCount);
      if (maxTurns == null) return;
      if (!softLimitReached && turnCount >= maxTurns) {
        softLimitReached = true;
        session.steer("You have reached your turn limit. Wrap up immediately — provide your final answer now.");
      } else if (softLimitReached && turnCount >= maxTurns + GRACE_TURNS) {
        aborted = true;
        session.abort();
      }
    }
  });

  const collector = collectResponseText(session, options.onTextDelta);
  const cleanupAbort = forwardAbortSignal(session, options.signal);

  try {
    await session.prompt(prompt);
  } finally {
    unsubTurns();
    unsubEvents();
    collector.unsubscribe();
    cleanupAbort();
  }

  const responseText = collector.getText().trim() || getLastAssistantText(session);
  return { responseText, session, aborted, steered: softLimitReached };
}
