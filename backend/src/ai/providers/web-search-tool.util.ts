import type Anthropic from "@anthropic-ai/sdk";
import { AiWebSearchOptions } from "./ai-provider.interface";

/**
 * Anthropic ships its server-side web search under two tool types. The
 * `_20260209` variant (dynamic filtering) is accepted by Opus 4.6+, Sonnet
 * 4.6+ and the Claude 5 families; earlier models take only the basic
 * `_20250305` variant. The user configures the model id, so the variant is
 * picked from it here -- and because the id table below is a guess about a
 * catalogue Anthropic keeps extending, `AnthropicProvider` retries once with
 * the other variant when the API rejects the tool type.
 */
export const ANTHROPIC_WEB_SEARCH_VARIANTS = [
  "web_search_20260209",
  "web_search_20250305",
] as const;
export type AnthropicWebSearchVariant =
  (typeof ANTHROPIC_WEB_SEARCH_VARIANTS)[number];

/**
 * Model ids that accept the 2026 variant: `claude-opus-4-6`, `claude-sonnet-4-7`,
 * `claude-opus-4-10`, `claude-sonnet-5`, `claude-fable-5-1`, ... Dated snapshot
 * suffixes (`-20260301`) and `-latest` aliases are tolerated because the match
 * is on the family and version, not the tail.
 */
const MODERN_MODEL_PATTERNS: readonly RegExp[] = [
  /^claude-(?:opus|sonnet)-4-(?:[6-9]|[1-9]\d)(?:-|$)/,
  /^claude-[a-z]+-(?:[5-9]|\d\d)(?:-|$)/,
];

export function preferredAnthropicWebSearchVariant(
  modelId: string,
): AnthropicWebSearchVariant {
  return MODERN_MODEL_PATTERNS.some((pattern) => pattern.test(modelId))
    ? "web_search_20260209"
    : "web_search_20250305";
}

export function otherAnthropicWebSearchVariant(
  variant: AnthropicWebSearchVariant,
): AnthropicWebSearchVariant {
  return variant === "web_search_20260209"
    ? "web_search_20250305"
    : "web_search_20260209";
}

export function anthropicWebSearchTool(
  variant: AnthropicWebSearchVariant,
  options: AiWebSearchOptions,
): Anthropic.Messages.ToolUnion {
  return {
    type: variant,
    name: "web_search",
    max_uses: options.maxUses,
    ...(options.allowedDomains && options.allowedDomains.length > 0
      ? { allowed_domains: options.allowedDomains }
      : {}),
  };
}

/**
 * Whether an API rejection is about the web search tool type itself (the
 * model does not take this variant) rather than anything else in the request.
 * Only a 400 that names one of the variants qualifies; a 400 for a bad model
 * id, an auth failure or a rate limit must not trigger the variant retry.
 */
export function isUnsupportedWebSearchVariantError(error: unknown): boolean {
  const status = (error as { status?: unknown })?.status;
  if (status !== 400) return false;
  const message = error instanceof Error ? error.message : String(error);
  return ANTHROPIC_WEB_SEARCH_VARIANTS.some((variant) =>
    message.includes(variant),
  );
}

/**
 * The `tools` field for a request that carries a provider's own server tool.
 * A server tool list is never empty -- there is exactly one tool -- so the
 * empty-array concern `toolsField` exists for does not arise; this is a
 * spread helper so provider sources keep the field out of their own literals
 * (`tools-field.util.spec.ts` scans for a bare `tools:` key).
 */
export function serverToolsField<T>(tool: T): { tools: T[] } {
  return { tools: [tool] };
}
