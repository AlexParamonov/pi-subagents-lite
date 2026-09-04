/**
 * Output-limit field resolution for OpenAI-compatible models.
 *
 * Mirrors pi-ai's compat chain (openai-completions `getCompat`/
 * `detectCompat`, maxTokensField portion): an explicit
 * `model.compat.maxTokensField` wins, otherwise the field is
 * auto-detected from the provider name and baseUrl. pi-ai does not
 * export its detection function, so the detection below is a verbatim
 * copy — keep it in sync when upgrading pi.
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
  provider: string;
  baseUrl: string;
  compat?: unknown;
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
