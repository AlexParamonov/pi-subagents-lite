import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeCtx, fakePi as makeFakePi } from "../fixtures.js";
import { withCompatField } from "../pi-boundaries.js";
import { mockModules, defaultAgentConfig, resetMocks, createMockSession, makeMockModel } from "./agent-runner-mocks.js";
import { runAgent } from "../../src/agents/agent-runner.js";

const fakePi = makeFakePi();

describe("runAgent — maxTokens: front matter to provider payload", () => {
  let session: ReturnType<typeof createMockSession>;

  beforeEach(() => {
    resetMocks();
    fakePi.exec.mockResolvedValue({ code: 0, stdout: "true" });

    session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit"]);
    session.agent = { onPayload: undefined };
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
  });

  it("max_tokens in agent config ends up in the provider request payload", async () => {
    mockModules.mockGetAgentConfig.mockReturnValue({
      ...defaultAgentConfig,
      maxTokens: 4096,
    });

    const model = makeMockModel({
      id: "llama-3.1-8b",
      name: "Llama 3.1 8B",
      provider: "vllm",
      baseUrl: "http://localhost:8000/v1",
      compat: { maxTokensField: "max_tokens" },
    });

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi, model });

    const rawPayload = {
      model: "llama-3.1-8b",
      messages: [{ role: "user", content: "do something" }],
      stream: true,
    };
    const finalPayload = await session.agent.onPayload!(rawPayload, model);

    expect(finalPayload.max_tokens).toBe(4096);
    expect(finalPayload.model).toBe("llama-3.1-8b");
    expect(finalPayload.stream).toBe(true);
  });

  it("uses max_completion_tokens when the provider requires it", async () => {
    mockModules.mockGetAgentConfig.mockReturnValue({
      ...defaultAgentConfig,
      maxTokens: 8192,
    });

    const model = makeMockModel({ compat: { maxTokensField: "max_completion_tokens" } });

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi, model });

    const finalPayload = await session.agent.onPayload!(
      { model: "some-model", messages: [{ role: "user", content: "do something" }] },
      model,
    );

    expect(finalPayload.max_completion_tokens).toBe(8192);
    expect(finalPayload.max_tokens).toBeUndefined();
  });

  it("resolves the field via pi's compat chain when model compat is silent", async () => {
    // The failing case: a model absent from the generated catalog has no
    // compat. The extension must resolve the field exactly like pi does
    // (detection finds no max_tokens family → max_completion_tokens), not
    // default to max_tokens, or the provider rejects the request.
    mockModules.mockGetAgentConfig.mockReturnValue({
      ...defaultAgentConfig,
      maxTokens: 4096,
    });

    const model = makeMockModel({
      id: "custom-model",
      name: "Custom Model",
      provider: "opencode-go",
      baseUrl: "https://opencode.ai/zen/go/v1",
    });

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi, model });

    const finalPayload = await session.agent.onPayload!(
      { model: "custom-model", messages: [{ role: "user", content: "do something" }] },
      model,
    );

    expect(finalPayload.max_completion_tokens).toBe(4096);
    expect(finalPayload.max_tokens).toBeUndefined();
  });

  it("keeps sending max_tokens for catalog models with explicit compat", async () => {
    // Catalog opencode-go models carry compat.maxTokensField = max_tokens;
    // the explicit override wins over detection and behavior is unchanged.
    mockModules.mockGetAgentConfig.mockReturnValue({
      ...defaultAgentConfig,
      maxTokens: 4096,
    });

    const model = makeMockModel({
      id: "catalog-model",
      name: "Catalog Model",
      provider: "opencode-go",
      baseUrl: "https://opencode.ai/zen/go/v1",
      compat: { maxTokensField: "max_tokens" },
    });

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi, model });

    const finalPayload = await session.agent.onPayload!(
      { model: "catalog-model", messages: [{ role: "user", content: "do something" }] },
      model,
    );

    expect(finalPayload.max_tokens).toBe(4096);
    expect(finalPayload.max_completion_tokens).toBeUndefined();
  });

  it("keeps max_tokens injection for non-openai-completions APIs (anthropic-messages)", async () => {
    // The compat chain is openai-completions-only. For other APIs the hook
    // must keep the pre-fix max_tokens injection: it matches anthropic's
    // native field, and the wrong field here would silently drop the
    // user's limit (pi's base params set the model default instead).
    mockModules.mockGetAgentConfig.mockReturnValue({
      ...defaultAgentConfig,
      maxTokens: 4096,
    });

    const model = makeMockModel({
      id: "claude-sonnet",
      name: "Claude Sonnet",
      provider: "anthropic",
      api: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
    });

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi, model });

    const finalPayload = await session.agent.onPayload!(
      { model: "claude-sonnet", messages: [{ role: "user", content: "do something" }] },
      model,
    );

    expect(finalPayload.max_tokens).toBe(4096);
    expect(finalPayload.max_completion_tokens).toBeUndefined();
  });

  it("injects max_output_tokens for openai-responses models (pi's responses field)", async () => {
    // The manual-test failing case: opencode zen / console go models on the
    // Responses API. pi's openai-responses algorithm sends
    // max_output_tokens; the pre-fix hook injected max_tokens, which the
    // provider rejects with 400 ("unknown parameter max_tokens").
    mockModules.mockGetAgentConfig.mockReturnValue({
      ...defaultAgentConfig,
      maxTokens: 4096,
    });

    const model = makeMockModel({
      id: "muse-spark",
      name: "Muse Spark",
      provider: "opencode",
      api: "openai-responses",
      baseUrl: "https://opencode.ai/zen",
    });

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi, model });

    const finalPayload = await session.agent.onPayload!(
      { model: "muse-spark", messages: [{ role: "user", content: "do something" }] },
      model,
    );

    expect(finalPayload.max_output_tokens).toBe(4096);
    expect(finalPayload.max_tokens).toBeUndefined();
  });

  it("clamps small maxTokens to pi's responses minimum for openai-responses", async () => {
    // OpenAI Responses rejects max_output_tokens below 16 (pi issue #6265);
    // pi clamps with Math.max(maxTokens, 16).
    mockModules.mockGetAgentConfig.mockReturnValue({
      ...defaultAgentConfig,
      maxTokens: 8,
    });

    const model = makeMockModel({ api: "openai-responses" });

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi, model });

    const finalPayload = await session.agent.onPayload!({ model: "m", messages: [] }, model);

    expect(finalPayload.max_output_tokens).toBe(16);
  });

  it("injects no output limit when supportsMaxOutputTokens is false", async () => {
    // Newer pi-ai releases only send the responses field when
    // compat.supportsMaxOutputTokens (default true); some gateways reject
    // it. The hook must not inject a field pi would not send.
    mockModules.mockGetAgentConfig.mockReturnValue({
      ...defaultAgentConfig,
      maxTokens: 4096,
    });

    const model = withCompatField(makeMockModel({ api: "openai-responses" }), {
      supportsMaxOutputTokens: false,
    });

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi, model });

    const rawPayload = { model: "m", messages: [] };
    const finalPayload = await session.agent.onPayload!(rawPayload, model);

    expect(finalPayload).toEqual(rawPayload);
  });

  it("injects max_output_tokens for azure-openai-responses models", async () => {
    mockModules.mockGetAgentConfig.mockReturnValue({
      ...defaultAgentConfig,
      maxTokens: 4096,
    });

    const model = makeMockModel({ api: "azure-openai-responses" });

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi, model });

    const finalPayload = await session.agent.onPayload!({ model: "m", messages: [] }, model);

    expect(finalPayload.max_output_tokens).toBe(4096);
    expect(finalPayload.max_tokens).toBeUndefined();
  });

  it("resolves the field from the per-request model when the model changed mid-run", async () => {
    // setModel can swap the model mid-run; pi's base params follow the new
    // model, so the hook must resolve the field per request instead of
    // capturing it from the session's spawn-time model.
    mockModules.mockGetAgentConfig.mockReturnValue({
      ...defaultAgentConfig,
      maxTokens: 4096,
    });

    // Spawn-time model: deepseek family → max_tokens.
    const initialModel = makeMockModel({
      id: "deepseek-chat",
      name: "DeepSeek Chat",
      provider: "deepseek",
      baseUrl: "https://api.deepseek.com/v1",
    });

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi, model: initialModel });

    // Per-request model after a mid-run switch: no max_tokens family →
    // max_completion_tokens.
    const switchedModel = makeMockModel({
      id: "custom-model",
      name: "Custom Model",
      provider: "opencode-go",
      baseUrl: "https://opencode.ai/zen/go/v1",
    });

    const finalPayload = await session.agent.onPayload!(
      { model: "custom-model", messages: [{ role: "user", content: "do something" }] },
      switchedModel,
    );

    expect(finalPayload.max_completion_tokens).toBe(4096);
    expect(finalPayload.max_tokens).toBeUndefined();
  });

  it("no max_tokens injected when agent config omits it", async () => {
    mockModules.mockGetAgentConfig.mockReturnValue({ ...defaultAgentConfig });

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi, model: makeMockModel() });

    expect(session.agent.onPayload).toBeUndefined();
  });
  it("spawn-time maxTokens wins over agent config", async () => {
    mockModules.mockGetAgentConfig.mockReturnValue({
      ...defaultAgentConfig,
      maxTokens: 4096,
    });

    const model = makeMockModel({
      id: "llama-3.1-8b",
      name: "Llama 3.1 8B",
      provider: "vllm",
      baseUrl: "http://localhost:8000/v1",
      compat: { maxTokensField: "max_tokens" },
    });

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi, model, maxTokens: 2048 });

    const rawPayload = {
      model: "llama-3.1-8b",
      messages: [{ role: "user", content: "do something" }],
      stream: true,
    };
    const finalPayload = await session.agent.onPayload!(rawPayload, model);

    expect(finalPayload.max_tokens).toBe(2048);
  });
});

describe("runAgent — maxTokens: native fields per non-completions API", () => {
  let session: ReturnType<typeof createMockSession>;

  beforeEach(() => {
    resetMocks();
    fakePi.exec.mockResolvedValue({ code: 0, stdout: "true" });

    session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit"]);
    session.agent = { onPayload: undefined };
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
    mockModules.mockGetAgentConfig.mockReturnValue({ ...defaultAgentConfig, maxTokens: 4096 });
  });

  it("injects a bedrock cap at nested inferenceConfig.maxTokens", async () => {
    // pi's bedrock-converse-stream receives commandInput; the cap lives at
    // inferenceConfig.maxTokens, so a flat top-level field drops the cap.
    const model = makeMockModel({
      id: "anthropic.claude-sonnet",
      provider: "bedrock",
      api: "bedrock-converse-stream",
      baseUrl: "https://bedrock.us-east-1.amazonaws.com",
    });

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi, model });

    const rawPayload = {
      modelId: "anthropic.claude-sonnet",
      messages: [{ role: "user", content: [{ text: "do something" }] }],
      inferenceConfig: { temperature: 0.5 },
      toolConfig: { tools: [] },
    };
    const finalPayload = await session.agent.onPayload!(rawPayload, model);

    expect(finalPayload).toEqual({
      ...rawPayload,
      inferenceConfig: { temperature: 0.5, maxTokens: 4096 },
    });
    expect(finalPayload.max_tokens).toBeUndefined();
    expect(finalPayload.maxTokens).toBeUndefined();
  });

  it("injects a google-generative-ai cap at nested config.maxOutputTokens", async () => {
    // pi's google APIs receive params = { model, contents, config }; the cap
    // lives at config.maxOutputTokens.
    const model = makeMockModel({
      id: "gemini-2.5-flash",
      provider: "google",
      api: "google-generative-ai",
      baseUrl: "https://generativelanguage.googleapis.com",
    });

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi, model });

    const rawPayload = {
      model: "gemini-2.5-flash",
      contents: [{ role: "user", parts: [{ text: "do something" }] }],
      config: { systemInstruction: "be brief" },
    };
    const finalPayload = await session.agent.onPayload!(rawPayload, model);

    expect(finalPayload).toEqual({
      ...rawPayload,
      config: { systemInstruction: "be brief", maxOutputTokens: 4096 },
    });
    expect(finalPayload.max_tokens).toBeUndefined();
    expect(finalPayload.maxOutputTokens).toBeUndefined();
  });

  it("injects a google-vertex cap at the same nested config.maxOutputTokens", async () => {
    const model = makeMockModel({
      id: "gemini-2.5-pro",
      provider: "google-vertex",
      api: "google-vertex",
      baseUrl: "https://us-central1-aiplatform.googleapis.com",
    });

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi, model });

    const rawPayload = { model: "gemini-2.5-pro", contents: [], config: {} };
    const finalPayload = await session.agent.onPayload!(rawPayload, model);

    expect(finalPayload).toEqual({
      model: "gemini-2.5-pro",
      contents: [],
      config: { maxOutputTokens: 4096 },
    });
    expect(finalPayload.max_tokens).toBeUndefined();
  });

  it("injects a mistral cap at top-level maxTokens", async () => {
    const model = makeMockModel({
      id: "mistral-large",
      provider: "mistral",
      api: "mistral-conversations",
      baseUrl: "https://api.mistral.ai",
    });

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi, model });

    const finalPayload = await session.agent.onPayload!({ agent: "m", messages: [] }, model);

    expect(finalPayload.maxTokens).toBe(4096);
    expect(finalPayload.max_tokens).toBeUndefined();
  });

  it("injects a pi-messages cap at nested options.maxTokens", async () => {
    const model = makeMockModel({
      id: "pi-model",
      provider: "pi",
      api: "pi-messages",
      baseUrl: "https://pi.local",
    });

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi, model });

    const rawPayload = { model: "pi-model", context: [], options: { temperature: 0.7 } };
    const finalPayload = await session.agent.onPayload!(rawPayload, model);

    expect(finalPayload).toEqual({
      model: "pi-model",
      context: [],
      options: { temperature: 0.7, maxTokens: 4096 },
    });
    expect(finalPayload.max_tokens).toBeUndefined();
  });

  it("injects no cap for openai-codex-responses (pi sends no output-limit field)", async () => {
    const model = makeMockModel({
      id: "gpt-5.5-codex",
      provider: "openai-codex",
      api: "openai-codex-responses",
      baseUrl: "https://chatgpt.com/backend-api",
    });

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi, model });

    const rawPayload = { model: "gpt-5.5-codex", input: [] };
    const finalPayload = await session.agent.onPayload!(rawPayload, model);

    expect(finalPayload).toEqual(rawPayload);
  });
});
