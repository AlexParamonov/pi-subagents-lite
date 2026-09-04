import { describe, it, expect, vi } from "vitest";
import { validateRawLayer } from "../../src/config/config-validation.js";
import { parseModelKey, findModelInRegistry } from "../../src/utils.js";
import { buildModelOptions, extractConfiguredModels } from "../../src/ui/menu/helpers.js";

describe("validateRawLayer — concurrency", () => {
  it("drops non-number concurrency entries with warnings and keeps valid ones", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const cleaned = validateRawLayer(
        { concurrency: { default: "many", providers: { a: 1, b: "x" }, models: { "m/n": 2 } } },
        "/g.json",
      );
      expect(cleaned.concurrency).toEqual({ providers: { a: 1 }, models: { "m/n": 2 } });
      expect(warn).toHaveBeenCalledTimes(2);
      expect(warn.mock.calls[0][0]).toContain("concurrency.default");
      expect(warn.mock.calls[1][0]).toContain("concurrency.providers.b");
    } finally {
      warn.mockRestore();
    }
  });

  it("drops non-object sections with a warning instead of crashing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(validateRawLayer({ agent: "nope" }, "/g.json")).toEqual({});
      expect(validateRawLayer({ concurrency: "nope" }, "/g.json")).toEqual({});
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("validateRawLayer — enums, nulls, and message shape", () => {
  it("allows null defaults but drops null for scalar settings", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(validateRawLayer({ agent: { default: null } }, "/g.json").agent).toEqual({ default: null });
      expect(validateRawLayer({ agent: { Explore: null } }, "/g.json").agent).toEqual({ Explore: null });
      expect(warn).not.toHaveBeenCalled();
      const cleaned = validateRawLayer({ agent: { graceTurns: null } }, "/g.json");
      expect(cleaned.agent ?? {}).toEqual({});
      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0][0]).toContain("null");
    } finally {
      warn.mockRestore();
    }
  });

  it("drops invalid enum strings with the expected union in the warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const cleaned = validateRawLayer({ agent: { systemPromptMode: "sometimes" } }, "/g.json");
      expect(cleaned.agent ?? {}).toEqual({});
      expect(warn.mock.calls[0][0]).toContain('"replace" | "inherit" | "custom"');
    } finally {
      warn.mockRestore();
    }
  });

  it("emits the full warning shape: file, key, got, expected, menu hint, edit-or-delete", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      validateRawLayer({ agent: { default: ["x"] } }, "/path/subagents-lite.json");
      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0][0]).toBe(
        '[subagents] Incompatible value in /path/subagents-lite.json: "agent.default" is array, ' +
          "expected string or null. Set it again in the /agents menu, or edit or delete the file to fix it.",
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("drops the legacy finishedEvictTurns key silently", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(validateRawLayer({ agent: { finishedEvictTurns: 7, graceTurns: 5 } }, "/g.json").agent).toEqual({
        graceTurns: 5,
      });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("menu crash vector", () => {
  it("menu helpers tolerate object model values without throw", () => {
    const bad = { model: "x" };
    expect(() => buildModelOptions(["openai/gpt"], bad as unknown as string, [bad as unknown as string])).not.toThrow();
    expect(() =>
      extractConfiguredModels({ default: bad as unknown as string, Explore: bad as unknown as string }),
    ).not.toThrow();
    expect(extractConfiguredModels({ default: bad as unknown as string })).toEqual([]);
  });
});

describe("parse backstop", () => {
  it("returns null for non-string input instead of throwing", () => {
    expect(parseModelKey({ model: "x" } as unknown as string)).toBeNull();
    expect(parseModelKey(null as unknown as string)).toBeNull();
    expect(parseModelKey(42 as unknown as string)).toBeNull();
  });

  it("findModelInRegistry falls back for non-string input instead of throwing", () => {
    const registry = { find: () => undefined };
    const fallback = { id: "f" };
    expect(findModelInRegistry({ model: "x" } as unknown as string, registry, fallback as never)).toBe(fallback);
  });
});

describe("validateRawLayer — model keys", () => {
  it("drops an object-shaped model override with an incompatible warning and keeps valid keys", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const cleaned = validateRawLayer(
        { agent: { default: { model: "x" }, graceTurns: 5 } },
        "/global/subagents-lite.json",
      );
      expect(cleaned.agent).toEqual({ graceTurns: 5 });
      expect(warn).toHaveBeenCalledOnce();
      const msg = warn.mock.calls[0][0] as string;
      expect(msg).toContain("/global/subagents-lite.json");
      expect(msg).toContain("agent.default");
      expect(msg).toContain("object");
      expect(msg).toContain("string or null");
      expect(msg).toContain("/agents");
    } finally {
      warn.mockRestore();
    }
  });

  it("treats unknown agent keys as per-type model keys: strings pass, objects drop with a warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(validateRawLayer({ agent: { Explore: "openai/gpt" } }, "/g.json").agent).toEqual({
        Explore: "openai/gpt",
      });
      expect(warn).not.toHaveBeenCalled();
      const cleaned = validateRawLayer({ agent: { Explore: { model: "x" } } }, "/g.json");
      expect(cleaned.agent ?? {}).toEqual({});
      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0][0]).toContain("agent.Explore");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("validateRawLayer — non-model keys", () => {
  it("drops a mistyped non-model key with file, key, got, expected, and fix hint", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const cleaned = validateRawLayer({ agent: { graceTurns: "many", showCost: true } }, "/g.json");
      expect(cleaned.agent).toEqual({ showCost: true });
      expect(warn).toHaveBeenCalledOnce();
      const msg = warn.mock.calls[0][0] as string;
      expect(msg).toContain("/g.json");
      expect(msg).toContain("agent.graceTurns");
      expect(msg).toContain("string");
      expect(msg).toContain("number");
      expect(msg).toContain("/agents");
      expect(msg).toContain("edit or delete");
    } finally {
      warn.mockRestore();
    }
  });

  it("passes valid values of every kind without warnings", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const raw = {
        agent: {
          default: "openai/gpt",
          Explore: "anthropic/claude",
          forceBackground: true,
          graceTurns: 9,
          systemPromptMode: "custom",
          defaultThinking: "high",
          defaultMaxTurns: 30,
          modelDisplayStyle: "id",
          modelThinkingPlacement: "metadata",
          statusBarFormat: "compact",
          showCost: false,
        },
        concurrency: { default: 2, providers: { a: 1 }, models: { "a/b": 3 } },
      };
      expect(validateRawLayer(raw, "/g.json")).toEqual(raw);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
