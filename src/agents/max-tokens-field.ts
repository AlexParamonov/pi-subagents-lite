/**
 * Output-limit field resolution for OpenAI-compatible models.
 *
 * Mirrors pi-ai's per-API output-limit handling: for openai-completions the
 * field goes through the compat chain (explicit `model.compat.maxTokensField`
 * wins, otherwise auto-detected from provider name and baseUrl); for the
 * OpenAI Responses family pi sends `max_output_tokens` clamped to a minimum
 * of 16 (the Responses API rejects values below it). pi-ai does not export
 * its resolution functions, so the detection below is a verbatim copy — keep
 * it in sync when upgrading pi.
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

/** The output-limit field and value to inject for a model, per pi's per-API algorithm. */
export interface OutputLimit {
  field: MaxTokensField | "max_output_tokens";
  value: number;
}

// pi-ai openai-responses/azure-openai-responses: the Responses API rejects
// max_output_tokens below 16 (pi issue #6265).
const OPENAI_RESPONSES_MIN_OUTPUT_TOKENS = 16;

/** Resolve the output-limit field and value pi sends for this model. */
export function resolveOutputLimit(model: MaxTokensFieldSource, maxTokens: number): OutputLimit {
  switch (model.api) {
    case "openai-completions":
      return { field: resolveMaxTokensField(model), value: maxTokens };
    case "openai-responses":
    case "azure-openai-responses":
      return { field: "max_output_tokens", value: Math.max(maxTokens, OPENAI_RESPONSES_MIN_OUTPUT_TOKENS) };
    default:
      // Pre-fix injection for the remaining APIs: matches anthropic's native
      // field. The other non-completions fields are a pre-existing gap
      // (issue #22), unchanged by this fix.
      return { field: "max_tokens", value: maxTokens };
  }
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
