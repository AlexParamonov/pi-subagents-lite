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
  applyOutputLimit,
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
    expect(resolveOutputLimit(m, 4096)).toEqual({
      field: "max_output_tokens",
      path: ["max_output_tokens"],
      value: 4096,
    });
  });

  it("clamps openai-responses values below pi's minimum to 16", () => {
    // OpenAI Responses rejects max_output_tokens below 16 (pi-ai issue #6265).
    expect(resolveOutputLimit(model({ api: "openai-responses" }), 8)).toEqual({
      field: "max_output_tokens",
      path: ["max_output_tokens"],
      value: 16,
    });
  });

  it("resolves azure-openai-responses to max_output_tokens with the same minimum", () => {
    expect(resolveOutputLimit(model({ api: "azure-openai-responses" }), 4096)).toEqual({
      field: "max_output_tokens",
      path: ["max_output_tokens"],
      value: 4096,
    });
    expect(resolveOutputLimit(model({ api: "azure-openai-responses" }), 8)).toEqual({
      field: "max_output_tokens",
      path: ["max_output_tokens"],
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
    expect(resolveOutputLimit(m, 4096)).toEqual({ field: "max_tokens", path: ["max_tokens"], value: 4096 });
  });

  it("keeps the pre-fix max_tokens injection for unknown future APIs", () => {
    // Unknown API families keep the anthropic-compatible default so a new pi
    // API fails toward a widely accepted field, not toward no cap at all.
    const m = model({
      provider: "future",
      baseUrl: "https://future.example.com",
      api: "future-chat",
    });
    expect(resolveOutputLimit(m, 4096)).toEqual({ field: "max_tokens", path: ["max_tokens"], value: 4096 });
  });

  it("resolves openai-completions through the compat chain", () => {
    const silent = model({ provider: "opencode-go", baseUrl: "https://opencode.ai/zen/go/v1" });
    expect(resolveOutputLimit(silent, 4096)).toEqual({
      field: "max_completion_tokens",
      path: ["max_completion_tokens"],
      value: 4096,
    });
    const explicit = model({
      provider: "opencode-go",
      baseUrl: "https://opencode.ai/zen/go/v1",
      compat: { maxTokensField: "max_tokens" },
    });
    expect(resolveOutputLimit(explicit, 4096)).toEqual({
      field: "max_tokens",
      path: ["max_tokens"],
      value: 4096,
    });
  });
});

describe("resolveOutputLimit — non-completions native fields (pi-ai 0.84.4)", () => {
  it("resolves a bedrock model to nested inferenceConfig.maxTokens", () => {
    // pi's bedrock-converse-stream builds commandInput.inferenceConfig =
    // { maxTokens: options.maxTokens ?? claudeDefault, temperature }; the
    // hook receives commandInput, so a flat top-level injection misses.
    const m = model({
      provider: "bedrock",
      baseUrl: "https://bedrock.us-east-1.amazonaws.com",
      api: "bedrock-converse-stream",
    });
    expect(resolveOutputLimit(m, 4096)).toEqual({
      field: "maxTokens",
      path: ["inferenceConfig", "maxTokens"],
      value: 4096,
    });
  });

  it("resolves google-generative-ai to nested config.maxOutputTokens", () => {
    // pi's google-generative-ai builds params = { model, contents, config }
    // with generationConfig.maxOutputTokens spread into config.
    const m = model({
      provider: "google",
      baseUrl: "https://generativelanguage.googleapis.com",
      api: "google-generative-ai",
    });
    expect(resolveOutputLimit(m, 2048)).toEqual({
      field: "maxOutputTokens",
      path: ["config", "maxOutputTokens"],
      value: 2048,
    });
  });

  it("resolves google-vertex to the same nested config.maxOutputTokens", () => {
    // google-vertex shares the { model, contents, config } params shape.
    const m = model({
      provider: "google-vertex",
      baseUrl: "https://us-central1-aiplatform.googleapis.com",
      api: "google-vertex",
    });
    expect(resolveOutputLimit(m, 2048)).toEqual({
      field: "maxOutputTokens",
      path: ["config", "maxOutputTokens"],
      value: 2048,
    });
  });

  it("resolves mistral-conversations to top-level maxTokens", () => {
    // pi's mistral-conversations sets payload.maxTokens (camelCase).
    const m = model({ provider: "mistral", baseUrl: "https://api.mistral.ai", api: "mistral-conversations" });
    expect(resolveOutputLimit(m, 4096)).toEqual({ field: "maxTokens", path: ["maxTokens"], value: 4096 });
  });

  it("resolves pi-messages to nested options.maxTokens", () => {
    // pi's pi-messages posts { model, context, options: { maxTokens, ... } }.
    const m = model({ provider: "pi", baseUrl: "https://pi.local", api: "pi-messages" });
    expect(resolveOutputLimit(m, 4096)).toEqual({
      field: "maxTokens",
      path: ["options", "maxTokens"],
      value: 4096,
    });
  });

  it("injects the responses clamp through the same top-level path", () => {
    // Triangulation: a second value forces the real clamp, not a constant.
    const m = model({ api: "openai-responses" });
    expect(resolveOutputLimit(m, 4)).toEqual({
      field: "max_output_tokens",
      path: ["max_output_tokens"],
      value: 16,
    });
  });

  it("injects nothing for openai-codex-responses (pi sends no output-limit field)", () => {
    // pi's codex buildRequestBody never reads options.maxTokens, so the hook
    // must not inject a field pi would not send.
    const m = model({
      provider: "openai-codex",
      baseUrl: "https://chatgpt.com/backend-api",
      api: "openai-codex-responses",
    });
    expect(resolveOutputLimit(m, 4096)).toBeUndefined();
  });
});

describe("applyOutputLimit", () => {
  it("sets a top-level field and preserves siblings", () => {
    const payload = { model: "m", messages: [], stream: true };
    const out = applyOutputLimit(payload, { field: "max_tokens", path: ["max_tokens"], value: 4096 });
    expect(out).toEqual({ model: "m", messages: [], stream: true, max_tokens: 4096 });
    expect(out).not.toBe(payload);
  });

  it("merges a nested bedrock cap without dropping inferenceConfig siblings", () => {
    // pi builds inferenceConfig = { maxTokens?, temperature? }; the hook
    // must not drop temperature or replace the whole object.
    const payload = {
      modelId: "anthropic.claude-sonnet",
      messages: [],
      inferenceConfig: { temperature: 0.5 },
      toolConfig: { tools: [] },
    };
    const out = applyOutputLimit(payload, {
      field: "maxTokens",
      path: ["inferenceConfig", "maxTokens"],
      value: 4096,
    });
    expect(out).toEqual({
      modelId: "anthropic.claude-sonnet",
      messages: [],
      inferenceConfig: { temperature: 0.5, maxTokens: 4096 },
      toolConfig: { tools: [] },
    });
  });

  it("merges a nested google cap without dropping config siblings", () => {
    // pi keeps systemInstruction, tools, thinkingConfig, and abortSignal in
    // params.config; replacing config would drop the abort signal.
    const abortSignal = new AbortController().signal;
    const payload = {
      model: "gemini-2.5-flash",
      contents: [],
      config: { systemInstruction: "be brief", abortSignal },
    };
    const out = applyOutputLimit(payload, {
      field: "maxOutputTokens",
      path: ["config", "maxOutputTokens"],
      value: 2048,
    });
    expect(out).toEqual({
      model: "gemini-2.5-flash",
      contents: [],
      config: { systemInstruction: "be brief", abortSignal, maxOutputTokens: 2048 },
    });
  });

  it("creates missing intermediate objects", () => {
    const out = applyOutputLimit(
      { model: "m", contents: [] },
      { field: "maxOutputTokens", path: ["config", "maxOutputTokens"], value: 2048 },
    );
    expect(out).toEqual({ model: "m", contents: [], config: { maxOutputTokens: 2048 } });
  });

  it("treats a non-object payload as an empty object", () => {
    // Matches the hook's pre-existing coercion (opaque payloads still get
    // the cap instead of crashing the run).
    expect(applyOutputLimit(null, { field: "max_tokens", path: ["max_tokens"], value: 1 })).toEqual({
      max_tokens: 1,
    });
    expect(applyOutputLimit([], { field: "max_tokens", path: ["max_tokens"], value: 1 })).toEqual({
      max_tokens: 1,
    });
  });
});
