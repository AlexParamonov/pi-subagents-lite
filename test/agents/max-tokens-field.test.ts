/**
 * max-tokens-field.test.ts — Unit tests for resolveMaxTokensField.
 *
 * Pins the extension's output-limit field resolution against pi-ai's
 * compat chain: an explicit model.compat.maxTokensField wins, otherwise
 * the field is auto-detected from the provider name and baseUrl (the
 * provider families that use max_tokens), defaulting to
 * max_completion_tokens. No model IDs: resolution depends only on
 * provider, baseUrl, and compat.
 */
import { describe, it, expect } from "vitest";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  resolveMaxTokensField,
  resolveOutputLimit,
  type MaxTokensFieldSource,
} from "../../src/agents/max-tokens-field.js";

function model(overrides: Partial<Model<Api>> = {}): Model<Api> {
  return {
    id: "test-model",
    name: "Test Model",
    provider: "openai",
    api: "openai-completions",
    baseUrl: "https://api.openai.com/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 16384,
    ...overrides,
  };
}

describe("resolveMaxTokensField", () => {
  it("resolves a custom opencode-go model without compat to max_completion_tokens (pi's default)", () => {
    // The failing case: a model absent from the generated catalog has no
    // compat, so pi's chain falls through to detection, finds no
    // max_tokens family, and defaults to max_completion_tokens.
    expect(resolveMaxTokensField(model({ provider: "opencode-go", baseUrl: "https://opencode.ai/zen/go/v1" }))).toBe(
      "max_completion_tokens",
    );
  });

  it("resolves a plain openai model without compat to max_completion_tokens (pi's default)", () => {
    expect(resolveMaxTokensField(model())).toBe("max_completion_tokens");
  });

  it("resolves a deepseek provider model to max_tokens", () => {
    expect(resolveMaxTokensField(model({ provider: "deepseek", baseUrl: "https://api.deepseek.com/v1" }))).toBe(
      "max_tokens",
    );
  });

  it("detects deepseek via baseUrl case-insensitively for custom providers", () => {
    expect(resolveMaxTokensField(model({ provider: "custom-proxy", baseUrl: "https://API.DEEPSEEK.COM/v1" }))).toBe(
      "max_tokens",
    );
  });

  it("prefers an explicit compat max_tokens over detection", () => {
    // Catalog opencode-go models carry this explicit override: they keep
    // sending max_tokens even though detection would not pick the family.
    expect(
      resolveMaxTokensField(
        model({
          provider: "opencode-go",
          baseUrl: "https://opencode.ai/zen/go/v1",
          compat: { maxTokensField: "max_tokens" },
        }),
      ),
    ).toBe("max_tokens");
  });

  it("prefers an explicit compat max_completion_tokens over detection", () => {
    expect(
      resolveMaxTokensField(
        model({
          provider: "deepseek",
          baseUrl: "https://api.deepseek.com/v1",
          compat: { maxTokensField: "max_completion_tokens" },
        }),
      ),
    ).toBe("max_completion_tokens");
  });

  it("detects each max_tokens provider family by name and URL", () => {
    const cases: Array<[string, string]> = [
      ["chutes", "https://chutes.ai/v1"],
      ["deepseek", "https://api.deepseek.com/v1"],
      ["moonshotai", "https://api.moonshot.ai/v1"],
      ["moonshotai-cn", "https://api.moonshot.cn/v1"],
      ["cloudflare-ai-gateway", "https://gateway.ai.cloudflare.com/v1/x/y/anthropic"],
      ["together", "https://api.together.ai/v1"],
      ["nvidia", "https://integrate.api.nvidia.com/v1"],
      ["ant-ling", "https://api.ant-ling.com/v1"],
      ["zai", "https://api.z.ai/api/coding/paas/v4"],
      ["zai-coding-cn", "https://open.bigmodel.cn/api/coding/paas/v4"],
    ];
    for (const [provider, baseUrl] of cases) {
      expect(resolveMaxTokensField(model({ provider, baseUrl })), `${provider} ${baseUrl}`).toBe("max_tokens");
    }
  });

  it("does not treat non-max_tokens families as max_tokens (pi's negative cases)", () => {
    // Cloudflare Workers AI is a distinct family from the AI Gateway and
    // stays on max_completion_tokens in pi.
    expect(
      resolveMaxTokensField(model({ provider: "cloudflare-workers-ai", baseUrl: "https://api.cloudflare.com/v1" })),
    ).toBe("max_completion_tokens");
    // opencode (zen) and opencode-go are not in pi's max_tokens list;
    // only explicit catalog compat puts them on max_tokens.
    expect(resolveMaxTokensField(model({ provider: "opencode", baseUrl: "https://opencode.ai/zen" }))).toBe(
      "max_completion_tokens",
    );
    expect(resolveMaxTokensField(model({ provider: "openrouter", baseUrl: "https://openrouter.ai/v1" }))).toBe(
      "max_completion_tokens",
    );
  });
});

describe("resolveOutputLimit", () => {
  it("resolves an openai-responses model to max_output_tokens (pi's responses field)", () => {
    // The failing case: opencode zen / console go models on the Responses API.
    // pi's openai-responses algorithm sends max_output_tokens, not max_tokens;
    // the provider rejects the injected max_tokens with 400.
    const m = model({ provider: "opencode", baseUrl: "https://opencode.ai/zen", api: "openai-responses" });
    expect(resolveOutputLimit(m, 4096)).toEqual({ field: "max_output_tokens", value: 4096 });
  });

  it("clamps openai-responses values below pi's minimum to 16", () => {
    // OpenAI Responses rejects max_output_tokens below 16 (pi-ai issue #6265).
    expect(resolveOutputLimit(model({ api: "openai-responses" }), 8)).toEqual({
      field: "max_output_tokens",
      value: 16,
    });
  });

  it("resolves azure-openai-responses to max_output_tokens with the same minimum", () => {
    expect(resolveOutputLimit(model({ api: "azure-openai-responses" }), 4096)).toEqual({
      field: "max_output_tokens",
      value: 4096,
    });
    expect(resolveOutputLimit(model({ api: "azure-openai-responses" }), 8)).toEqual({
      field: "max_output_tokens",
      value: 16,
    });
  });

  it("skips injection when the model disables supportsMaxOutputTokens", () => {
    // Newer pi-ai releases gate the responses field on
    // compat.supportsMaxOutputTokens (default true); some gateways reject
    // it. Built on the extension's own source interface: the installed
    // pi-ai types do not declare the field yet.
    const m: MaxTokensFieldSource = {
      api: "openai-responses",
      provider: "opencode",
      baseUrl: "https://opencode.ai/zen",
      compat: { supportsMaxOutputTokens: false },
    };
    expect(resolveOutputLimit(m, 4096)).toBeUndefined();
  });

  it("keeps max_tokens for anthropic-messages (pi's native field)", () => {
    const m = model({ provider: "anthropic", baseUrl: "https://api.anthropic.com", api: "anthropic-messages" });
    expect(resolveOutputLimit(m, 4096)).toEqual({ field: "max_tokens", value: 4096 });
  });

  it("keeps the pre-fix max_tokens injection for other non-completions APIs", () => {
    // Pre-existing gap for these APIs (issue #22): behavior unchanged by this fix.
    const m = model({
      provider: "google",
      baseUrl: "https://generativelanguage.googleapis.com",
      api: "google-generative-ai",
    });
    expect(resolveOutputLimit(m, 4096)).toEqual({ field: "max_tokens", value: 4096 });
  });

  it("resolves openai-completions through the compat chain", () => {
    const silent = model({ provider: "opencode-go", baseUrl: "https://opencode.ai/zen/go/v1" });
    expect(resolveOutputLimit(silent, 4096)).toEqual({ field: "max_completion_tokens", value: 4096 });
    const explicit = model({
      provider: "opencode-go",
      baseUrl: "https://opencode.ai/zen/go/v1",
      compat: { maxTokensField: "max_tokens" },
    });
    expect(resolveOutputLimit(explicit, 4096)).toEqual({ field: "max_tokens", value: 4096 });
  });
});
