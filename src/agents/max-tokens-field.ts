/**
 * Output-limit field resolution per pi-ai API family.
 *
 * Mirrors pi-ai's per-API output-limit handling: for openai-completions the
 * field goes through the compat chain (explicit `model.compat.maxTokensField`
 * wins, otherwise auto-detected from provider name and baseUrl); for the
 * OpenAI Responses family pi sends `max_output_tokens` clamped to a minimum
 * of 16 (the Responses API rejects values below it), and on openai-responses
 * only when `compat.supportsMaxOutputTokens` (default true — some gateways
 * reject the field; newer pi-ai releases, inert on older ones). Anthropic
 * uses top-level `max_tokens`; bedrock nests the cap at
 * `commandInput.inferenceConfig.maxTokens`; both google APIs nest it at
 * `params.config.maxOutputTokens`; mistral uses top-level `maxTokens`;
 * pi-messages nests it at `payload.options.maxTokens`; codex sends no
 * output-limit field at all. pi-ai does not export its resolution
 * functions, so the detection below is a verbatim copy — keep it in sync
 * when upgrading pi.
 */

export type MaxTokensField = "max_tokens" | "max_completion_tokens";

/**
 * The model surface the field resolution reads; pi's Model is assignable.
 * `compat` is typed unknown because pi's Model carries a union of
 * per-API compat types and only the OpenAI-completions member has
 * maxTokensField — anything else falls through to detection, exactly
 * like pi's `model.compat.maxTokensField ?? detected`.
 */
export interface MaxTokensFieldSource {
  api: string;
  provider: string;
  baseUrl: string;
  compat?: unknown;
}

/** The output-limit location and value to inject for a model, per pi's per-API algorithm. */
export interface OutputLimit {
  /** Leaf key pi writes the cap to; documents the wire contract per API. */
  field: string;
  /**
   * Path from the onPayload payload root to the leaf. One segment addresses
   * a top-level field; longer paths address pi's nested payload shapes
   * (bedrock commandInput.inferenceConfig, google params.config,
   * pi-messages payload.options). Applied with immutable spreads so sibling
   * keys (temperature, tools, abortSignal) survive.
   */
  path: string[];
  value: number;
}

// pi-ai openai-responses/azure-openai-responses: the Responses API rejects
// max_output_tokens below 16 (pi issue #6265).
const OPENAI_RESPONSES_MIN_OUTPUT_TOKENS = 16;

/**
 * Resolve the output-limit field and value pi sends for this model.
 * Returns undefined when pi sends no output-limit field at all (the model
 * disabled `supportsMaxOutputTokens`), so the caller must not inject.
 */
export function resolveOutputLimit(model: MaxTokensFieldSource, maxTokens: number): OutputLimit | undefined {
  switch (model.api) {
    case "openai-completions":
      return topLevel(resolveMaxTokensField(model), maxTokens);
    case "openai-responses":
      if (supportsMaxOutputTokens(model.compat)) {
        return topLevel("max_output_tokens", Math.max(maxTokens, OPENAI_RESPONSES_MIN_OUTPUT_TOKENS));
      }
      return undefined;
    case "azure-openai-responses":
      return topLevel("max_output_tokens", Math.max(maxTokens, OPENAI_RESPONSES_MIN_OUTPUT_TOKENS));
    case "anthropic-messages":
      return topLevel("max_tokens", maxTokens);
    case "bedrock-converse-stream":
      // pi builds commandInput.inferenceConfig = { maxTokens, temperature }.
      return { field: "maxTokens", path: ["inferenceConfig", "maxTokens"], value: maxTokens };
    case "google-generative-ai":
    case "google-vertex":
      // Both google APIs build params = { model, contents, config } with
      // generationConfig.maxOutputTokens spread into config.
      return { field: "maxOutputTokens", path: ["config", "maxOutputTokens"], value: maxTokens };
    case "mistral-conversations":
      return topLevel("maxTokens", maxTokens);
    case "pi-messages":
      // pi posts { model, context, options: { maxTokens, ... } }.
      return { field: "maxTokens", path: ["options", "maxTokens"], value: maxTokens };
    case "openai-codex-responses":
      // pi's codex body carries no output-limit field; injecting one would
      // hand an unknown field to the endpoint.
      return undefined;
    default:
      // Unknown future APIs keep the pre-fix injection: it matches
      // anthropic's native field.
      return topLevel("max_tokens", maxTokens);
  }
}

/** A top-level output-limit field: path and leaf coincide. */
function topLevel(field: string, value: number): OutputLimit {
  return { field, path: [field], value };
}

/** True for plain payload objects; arrays and primitives coerce to empty. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Inject the resolved cap into an onPayload payload at the limit's path.
 * Every level on the path is spread, so sibling keys (temperature, tools,
 * abortSignal) survive; missing intermediates are created. A non-object
 * payload or intermediate is treated as an empty object, matching the
 * hook's pre-existing coercion of opaque payloads.
 */
export function applyOutputLimit(payload: unknown, limit: OutputLimit): Record<string, unknown> {
  const obj = isRecord(payload) ? payload : {};
  const [head, ...rest] = limit.path;
  if (head === undefined) return obj;
  if (rest.length === 0) return { ...obj, [head]: limit.value };
  return { ...obj, [head]: applyOutputLimit(obj[head], { ...limit, path: rest }) };
}

function supportsMaxOutputTokens(compat: unknown): boolean {
  // pi: `model.compat?.supportsMaxOutputTokens ?? true`
  if (!compat || typeof compat !== "object") return true;
  return (compat as Record<string, unknown>).supportsMaxOutputTokens !== false;
}

export function resolveMaxTokensField(model: MaxTokensFieldSource): MaxTokensField {
  const explicit = explicitMaxTokensField(model.compat);
  if (explicit) return explicit;
  return detectMaxTokensField(model.provider, model.baseUrl);
}

function explicitMaxTokensField(compat: unknown): MaxTokensField | undefined {
  if (!compat || typeof compat !== "object") return undefined;
  const field = (compat as Record<string, unknown>).maxTokensField;
  return field === "max_tokens" || field === "max_completion_tokens" ? field : undefined;
}

/** pi-ai detectCompat: eight provider families use max_tokens, everything else max_completion_tokens. */
function detectMaxTokensField(provider: string, baseUrl: string): MaxTokensField {
  const isZai =
    provider === "zai" ||
    provider === "zai-coding-cn" ||
    baseUrl.includes("api.z.ai") ||
    baseUrl.includes("open.bigmodel.cn");
  const isTogether =
    provider === "together" || baseUrl.includes("api.together.ai") || baseUrl.includes("api.together.xyz");
  const isMoonshot = provider === "moonshotai" || provider === "moonshotai-cn" || baseUrl.includes("api.moonshot.");
  const isCloudflareAiGateway = provider === "cloudflare-ai-gateway" || baseUrl.includes("gateway.ai.cloudflare.com");
  const isNvidia = provider === "nvidia" || baseUrl.includes("integrate.api.nvidia.com");
  const isAntLing = provider === "ant-ling" || baseUrl.includes("api.ant-ling.com");
  const isDeepSeek = provider === "deepseek" || baseUrl.toLowerCase().includes("deepseek.com");

  const useMaxTokens =
    baseUrl.includes("chutes.ai") ||
    isDeepSeek ||
    isMoonshot ||
    isCloudflareAiGateway ||
    isTogether ||
    isNvidia ||
    isAntLing ||
    isZai;

  return useMaxTokens ? "max_tokens" : "max_completion_tokens";
}
