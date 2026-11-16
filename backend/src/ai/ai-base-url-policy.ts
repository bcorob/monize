import { BadRequestException } from "@nestjs/common";
import { tr } from "../i18n/translate";
import {
  AiProviderConfig,
  AiProviderType,
  SELF_HOSTED_PROVIDERS,
} from "./entities/ai-provider-config.entity";
import { OLLAMA_DEFAULT_BASE_URL } from "./providers/ollama.provider";
import { AiEgressPolicy } from "./providers/provider-egress";
import { isAllowlistedPrivateBaseUrl } from "./validators/private-base-url-allowlist";
import {
  validateUrlBasicSafety,
  validateUrlIsSafe,
} from "./validators/safe-url.validator";

/** Reads, when needed, whether the provider's owner is an admin. */
export type OwnerIsAdmin = () => Promise<boolean>;

/**
 * A provider's base URL refused because of the address it points at, for the
 * person whose provider it is. A class of its own so the provider loops can
 * tell it from an ordinary provider failure and surface it instead of the
 * generic "all providers failed".
 */
export class AiBaseUrlRefusedError extends BadRequestException {}

/** The refusal for a self-hosted provider pointed at a private address. */
export function privateBaseUrlRefusal(): AiBaseUrlRefusedError {
  return new AiBaseUrlRefusedError(
    tr(
      "errors.ai.privateBaseUrlRefused",
      "This base URL points to a private or local network address (such as localhost, 192.168.x.x or a container name). Only an administrator can use one, unless the server operator allows that address in AI_PRIVATE_BASE_URL_ALLOWLIST.",
    ),
  );
}

/** The refusal for a cloud provider whose base URL is not a public host. */
export function externalBaseUrlRefusal(): AiBaseUrlRefusedError {
  return new AiBaseUrlRefusedError(
    tr(
      "errors.params.mustBeExternalUrl",
      'The value of "baseUrl" must be a valid HTTP or HTTPS URL pointing to a host outside this server',
      { param: "baseUrl" },
    ),
  );
}

/**
 * The base URL to hold to the policy, or null when there is none. A
 * self-hosted Ollama with no base URL is not "no URL": it is loopback. A value
 * stored on a provider with a fixed endpoint is checked too, as it always was.
 */
export function effectiveBaseUrl(
  provider: AiProviderType,
  baseUrl: string | null | undefined,
): string | null {
  if (provider === "ollama") return baseUrl || OLLAMA_DEFAULT_BASE_URL;
  return baseUrl || null;
}

/**
 * Which addresses a provider owned by this person may reach.
 *
 * Every cloud provider is public-only, whoever owns it. A self-hosted provider
 * (Ollama, OpenAI-compatible) may reach a private address only for an admin,
 * or at an address the operator put on `AI_PRIVATE_BASE_URL_ALLOWLIST`: any
 * signed-up user can create one, and a private base URL is otherwise an
 * internal HTTP request made on their behalf, with the answer read back.
 */
export function egressPolicyFor(
  provider: AiProviderType,
  ownerIsAdmin: boolean,
): AiEgressPolicy {
  if (!SELF_HOSTED_PROVIDERS.has(provider)) return "public-only";
  return ownerIsAdmin ? "any" : "public-or-allowlisted";
}

/**
 * Whether a base URL satisfies a policy, decided on the URL as written and on
 * what its name resolves to now. The connection itself is checked again when
 * it is made (`publicOnlyLookup`), so a name that changes its answer after
 * this check is still refused.
 */
export async function baseUrlPermitted(
  url: string,
  policy: AiEgressPolicy,
): Promise<boolean> {
  if (policy === "any") return true;
  if (policy === "public-or-allowlisted" && isAllowlistedPrivateBaseUrl(url)) {
    return true;
  }
  return validateUrlIsSafe(url);
}

/** The refusal that fits the provider a policy check failed for. */
export function baseUrlRefusalFor(
  provider: AiProviderType,
): AiBaseUrlRefusedError {
  return SELF_HOSTED_PROVIDERS.has(provider)
    ? privateBaseUrlRefusal()
    : externalBaseUrlRefusal();
}

/**
 * The save-time (and draft-test) check of the URL a provider will call.
 * `baseUrl` is the request's value; the URL checked is the one the provider
 * would actually use, so an Ollama with none is checked as loopback. The
 * owner's role is read only when the URL is not already public or allowlisted.
 */
export async function assertBaseUrlAllowed(
  provider: AiProviderType,
  baseUrl: string | null | undefined,
  ownerIsAdmin: OwnerIsAdmin,
): Promise<void> {
  const target = effectiveBaseUrl(provider, baseUrl);
  if (!target) return;
  if (!validateUrlBasicSafety(target)) {
    throw new BadRequestException(
      tr(
        "errors.params.mustBeUrl",
        'The value of "baseUrl" must be a valid HTTP or HTTPS URL',
        { param: "baseUrl" },
      ),
    );
  }
  if (await baseUrlPermitted(target, egressPolicyFor(provider, false))) return;
  if (SELF_HOSTED_PROVIDERS.has(provider) && (await ownerIsAdmin())) return;
  throw baseUrlRefusalFor(provider);
}

/**
 * The policy a stored (or draft) config is used under, after refusing it if
 * its base URL does not satisfy that policy now. The operator's own
 * AI_DEFAULT_* provider is unrestricted, as it always was.
 */
export async function egressPolicyForConfig(
  config: AiProviderConfig,
  ownerIsAdmin: OwnerIsAdmin,
): Promise<AiEgressPolicy> {
  if (config.isSystemDefault) return "any";
  const policy = SELF_HOSTED_PROVIDERS.has(config.provider)
    ? egressPolicyFor(config.provider, await ownerIsAdmin())
    : "public-only";
  const target = effectiveBaseUrl(config.provider, config.baseUrl);
  if (target && !(await baseUrlPermitted(target, policy))) {
    throw baseUrlRefusalFor(config.provider);
  }
  return policy;
}
