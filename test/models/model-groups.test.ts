/**
 * model-groups.test.ts — Grouping + thinking-display logic for the Model
 * settings menu (pure: no store, no TUI).
 *
 * ACs covered: no groups when all types at default, frontmatter-only types
 * never listed, shadowed config per-type override under a session default,
 * session override shadowing frontmatter, clamped thinking, unknown model id,
 * alphabetical groups, anti-spam exclusion, provenance tags.
 */

import { describe, it, expect } from "vitest";
import { clampThinkingLevel } from "@earendil-works/pi-ai";
import type { Model } from "@earendil-works/pi-ai";
import { buildModelGroups, type ModelGroupsInput } from "../../src/models/model-groups.js";
import type { SubagentsConfig } from "../../src/models/model-precedence.js";

// --- Registry stub: real clampThinkingLevel runs against these minimal models.

const REASONING_MODEL = {
  provider: "anthropic",
  id: "claude-opus-4-1",
  reasoning: true,
  // Declares xhigh/max support (pi-ai excludes them without map entries).
  thinkingLevelMap: { xhigh: "xhigh", max: "max" },
} as Model<any>;
const NON_REASONING_MODEL = { provider: "openai", id: "gpt-4o", reasoning: false } as Model<any>;
const LIMITED_REASONING_MODEL = {
  provider: "anthropic",
  id: "claude-limited",
  reasoning: true,
  thinkingLevelMap: {},
} as Model<any>;

const registry = new Map([
  ["anthropic/claude-opus-4-1", REASONING_MODEL],
  ["openai/gpt-4o", NON_REASONING_MODEL],
  ["anthropic/claude-limited", LIMITED_REASONING_MODEL],
]);

/** Full agent-config base (SubagentsConfig["agent"] requires default + forceBackground). */
const baseAgent: SubagentsConfig["agent"] = { default: null, forceBackground: false };

/** Overrides for input(); config may be partial and is merged over baseAgent. */
type InputOverrides = Omit<Partial<ModelGroupsInput>, "config"> & { config?: Partial<SubagentsConfig["agent"]> };

function input(overrides: InputOverrides = {}): ModelGroupsInput {
  const { config, ...rest } = overrides;
  return {
    types: ["scout", "worker", "plain"],
    agentConfigs: {},
    config: { ...baseAgent, ...config },
    sessionOverrides: { default: null },
    hasProjectModelKey: () => false,
    parentModelId: "test/parent-model",
    findModel: (id: string) => registry.get(id),
    ...rest,
  };
}

const groupsFor = (i: ModelGroupsInput) => buildModelGroups(i);

describe("buildModelGroups — grouping", () => {
  it("renders no groups when every type resolves to the parent model", () => {
    const result = groupsFor(input());
    expect(result).toEqual([]);
  });

  it("excludes a frontmatter-only type even when its model equals the config default", () => {
    const result = groupsFor(
      input({
        config: { default: "openai/gpt-4o" },
        agentConfigs: { plain: { model: "openai/gpt-4o" } },
      }),
    );
    expect(result).toEqual([]);
  });

  it("never lists frontmatter-only types even when their model differs from the config default", () => {
    const result = groupsFor(
      input({
        config: { default: "openai/gpt-4o" },
        agentConfigs: { scout: { model: "anthropic/claude-opus-4-1" } },
      }),
    );
    // scout resolves to the config default (the config default beats the
    // frontmatter model), but has no explicit per-type override → anti-spam
    // keeps it unlisted.
    expect(result).toEqual([]);
  });

  it("leaves a global-layer per-type override untagged", () => {
    const result = groupsFor(input({ config: { worker: "openai/gpt-4o" } }));
    expect(result).toEqual([
      {
        modelId: "openai/gpt-4o",
        rows: [{ type: "worker", thinking: "off", tag: "" }],
      },
    ]);
  });
  it("lists an empty-string per-type key as a row resolving to the parent fallback", () => {
    // "" is an explicit key needing a clear path; resolution skips it, so the
    // row lands under the parent fallback with medium thinking (no frontmatter).
    const result = groupsFor(input({ config: { scout: "" } }));
    expect(result).toEqual([
      {
        modelId: "test/parent-model",
        rows: [{ type: "scout", thinking: "medium", tag: "" }],
      },
    ]);
  });

  it("tags a project-layer per-type override with [project]", () => {
    const result = groupsFor(
      input({
        config: { worker: "openai/gpt-4o" },
        hasProjectModelKey: (key) => key === "worker",
      }),
    );
    expect(result[0]?.rows[0]).toEqual({ type: "worker", thinking: "off", tag: "[project]" });
  });

  it("groups a session per-type override over the frontmatter model with [session]", () => {
    const result = groupsFor(
      input({
        agentConfigs: { scout: { model: "anthropic/claude-opus-4-1" } },
        sessionOverrides: { default: null, scout: "openai/gpt-4o" },
      }),
    );
    expect(result).toEqual([
      {
        modelId: "openai/gpt-4o",
        rows: [{ type: "scout", thinking: "off", tag: "[session]" }],
      },
    ]);
  });

  it("groups a config per-type override over the frontmatter model untagged (global won)", () => {
    const result = groupsFor(
      input({
        agentConfigs: { scout: { model: "anthropic/claude-opus-4-1" } },
        config: { scout: "openai/gpt-4o" },
      }),
    );
    expect(result).toEqual([
      {
        modelId: "openai/gpt-4o",
        rows: [{ type: "scout", thinking: "off", tag: "" }],
      },
    ]);
  });

  it("lists a shadowed global per-type override under a set session default with [session] (equal values)", () => {
    const result = groupsFor(
      input({
        config: { worker: "openai/gpt-4o" },
        agentConfigs: { scout: { model: "anthropic/claude-opus-4-1" } },
        sessionOverrides: { default: "openai/gpt-4o", scout: "s/scout" },
      }),
    );
    // worker: the session default (gpt-4o) beats the global per-type key
    // (same value) → still listed, but under the session default with [session].
    // scout: session per-type → [session], ahead of the session default.
    expect(result).toEqual([
      {
        modelId: "openai/gpt-4o",
        rows: [{ type: "worker", thinking: "off", tag: "[session]" }],
      },
      {
        modelId: "s/scout",
        rows: [{ type: "scout", thinking: "medium", tag: "[session]" }],
      },
    ]);
  });

  it("lists a shadowed global per-type override under the session default with [session] (different value)", () => {
    const result = groupsFor(
      input({
        config: { worker: "openai/gpt-4o" },
        sessionOverrides: { default: "anthropic/claude-opus-4-1" },
      }),
    );
    // worker's global override (gpt-4o) loses to the session default (opus);
    // the explicit override still lists the row, under the model it actually
    // resolves to, tagged [session].
    expect(result).toEqual([
      {
        modelId: "anthropic/claude-opus-4-1",
        rows: [{ type: "worker", thinking: "medium", tag: "[session]" }],
      },
    ]);
  });

  it("lists a shadowed project per-type override under the session default with [session] (equal values)", () => {
    const result = groupsFor(
      input({
        config: { worker: "openai/gpt-4o" },
        hasProjectModelKey: (key) => key === "worker",
        sessionOverrides: { default: "openai/gpt-4o" },
      }),
    );
    expect(result).toEqual([
      {
        modelId: "openai/gpt-4o",
        rows: [{ type: "worker", thinking: "off", tag: "[session]" }],
      },
    ]);
  });

  it("lists a shadowed project per-type override under the session default with [session] (different value)", () => {
    const result = groupsFor(
      input({
        config: { worker: "openai/gpt-4o" },
        hasProjectModelKey: (key) => key === "worker",
        sessionOverrides: { default: "anthropic/claude-opus-4-1" },
      }),
    );
    expect(result).toEqual([
      {
        modelId: "anthropic/claude-opus-4-1",
        rows: [{ type: "worker", thinking: "medium", tag: "[session]" }],
      },
    ]);
  });

  it("shows the winning layer's model and tag when multiple layers set the per-type key", () => {
    const result = groupsFor(
      input({
        config: { worker: "openai/gpt-4o" },
        hasProjectModelKey: (key) => key === "worker",
        sessionOverrides: { default: null, worker: "anthropic/claude-opus-4-1" },
      }),
    );
    // Session per-type (opus) wins over the project and global per-type keys (gpt-4o).
    expect(result).toEqual([
      {
        modelId: "anthropic/claude-opus-4-1",
        rows: [{ type: "worker", thinking: "medium", tag: "[session]" }],
      },
    ]);
  });

  it("lists a global per-type override equal to the config default untagged", () => {
    const result = groupsFor(input({ config: { default: "openai/gpt-4o", worker: "openai/gpt-4o" } }));
    expect(result).toEqual([
      {
        modelId: "openai/gpt-4o",
        rows: [{ type: "worker", thinking: "off", tag: "" }],
      },
    ]);
  });

  it("lists a project per-type override equal to the config default with [project]", () => {
    const result = groupsFor(
      input({
        config: { default: "openai/gpt-4o", worker: "openai/gpt-4o" },
        hasProjectModelKey: (key) => key === "worker",
      }),
    );
    expect(result[0]?.rows[0]).toEqual({ type: "worker", thinking: "off", tag: "[project]" });
  });

  it("lists a session per-type override equal to the session default with [session]", () => {
    const result = groupsFor(
      input({
        config: { default: "openai/gpt-4o" },
        sessionOverrides: { default: "openai/gpt-4o", worker: "openai/gpt-4o" },
      }),
    );
    expect(result[0]?.rows[0]).toEqual({ type: "worker", thinking: "off", tag: "[session]" });
  });

  it("renders a group for the config default model only when a per-type override points at it", () => {
    // No per-type override: types inherit the default → no groups at all.
    const none = groupsFor(input({ config: { default: "openai/gpt-4o" } }));
    expect(none).toEqual([]);
    // A per-type override equal to the default: the default's group appears.
    const some = groupsFor(input({ config: { default: "openai/gpt-4o", worker: "openai/gpt-4o" } }));
    expect(some.map((g) => g.modelId)).toEqual(["openai/gpt-4o"]);
  });

  it("orders groups alphabetically by model id, rows in type order", () => {
    const result = groupsFor(
      input({
        config: {
          worker: "openai/gpt-4o",
          scout: "anthropic/claude-opus-4-1",
          plain: "anthropic/claude-opus-4-1",
        },
      }),
    );
    expect(result.map((g) => g.modelId)).toEqual(["anthropic/claude-opus-4-1", "openai/gpt-4o"]);
    expect(result[0]?.rows.map((r) => r.type)).toEqual(["scout", "plain"]);
  });

  it("groups an unknown model id by its raw string without clamping", () => {
    const result = groupsFor(
      input({
        agentConfigs: { scout: { thinkingLevel: "high" } },
        config: { scout: "custom/unknown-1" },
      }),
    );
    expect(result).toEqual([
      {
        modelId: "custom/unknown-1",
        rows: [{ type: "scout", thinking: "high", tag: "" }],
      },
    ]);
  });

  it("renders no groups for an empty type list", () => {
    const result = groupsFor(input({ types: [] }));
    expect(result).toEqual([]);
  });
});

describe("buildModelGroups — thinking display", () => {
  it("shows the effective defaultThinking when frontmatter thinking is unset", () => {
    const result = groupsFor(
      input({
        config: { scout: "anthropic/claude-opus-4-1", defaultThinking: "low" },
      }),
    );
    expect(result[0]?.rows[0].thinking).toBe("low");
  });

  it("shows pi's defaultThinkingLevel when frontmatter and defaultThinking are unset", () => {
    const result = groupsFor(
      input({
        config: { scout: "anthropic/claude-opus-4-1" },
        piDefaultThinking: "xhigh",
      }),
    );
    expect(result[0]?.rows[0].thinking).toBe("xhigh");
  });

  it("falls back to medium when no thinking source is set", () => {
    const result = groupsFor(input({ config: { scout: "anthropic/claude-opus-4-1" } }));
    expect(result[0]?.rows[0].thinking).toBe("medium");
  });

  it("prefers frontmatter thinking over defaultThinking and pi's level", () => {
    const result = groupsFor(
      input({
        agentConfigs: { scout: { thinkingLevel: "high" } },
        config: { scout: "anthropic/claude-opus-4-1", defaultThinking: "low" },
        piDefaultThinking: "xhigh",
      }),
    );
    expect(result[0]?.rows[0].thinking).toBe("high");
  });

  it("clamps thinking to a non-reasoning model's supported levels (off)", () => {
    const result = groupsFor(
      input({
        agentConfigs: { scout: { thinkingLevel: "high" } },
        config: { scout: "openai/gpt-4o" },
      }),
    );
    expect(result[0]?.rows[0].thinking).toBe("off");
  });

  it("clamps thinking to the highest supported level of a limited reasoning model", () => {
    const result = groupsFor(
      input({
        agentConfigs: { scout: { thinkingLevel: "xhigh" } },
        config: { scout: "anthropic/claude-limited" },
      }),
    );
    // Sanity: the registry model really lacks xhigh (guards the test itself).
    expect(clampThinkingLevel(LIMITED_REASONING_MODEL, "xhigh")).toBe("high");
    expect(result[0]?.rows[0].thinking).toBe("high");
  });

  it("leaves an in-range thinking level unclamped", () => {
    const result = groupsFor(
      input({
        agentConfigs: { scout: { thinkingLevel: "high" } },
        config: { scout: "anthropic/claude-opus-4-1" },
      }),
    );
    expect(result[0]?.rows[0].thinking).toBe("high");
  });
});
