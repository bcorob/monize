import { BadRequestException, Injectable } from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import { AiService } from "../../ai/ai.service";
import {
  parseContactJson,
  sanitizeContactSuggestions,
} from "./contact-suggestion.sanitize";
import {
  buildPayeeLookupUserMessage,
  PAYEE_LOOKUP_FEATURE,
  PAYEE_LOOKUP_MAX_SEARCHES,
  PAYEE_LOOKUP_MAX_TOKENS,
  PAYEE_LOOKUP_SYSTEM_PROMPT,
} from "./payee-lookup.prompt";
import {
  ContactLookupSource,
  ContactLookupUnavailableError,
  PayeeContactLookupInput,
  PayeeContactLookupProvider,
  PayeeContactSuggestion,
} from "./payee-contact-lookup.types";

/**
 * The lookup adapter backed by the user's own AI configuration. Every
 * provider the user has serves it, in their priority order:
 * `AiService.completeWithWebSearch` runs a real search where the provider has
 * one, hands the prompt to the relay agent, or falls back to model knowledge
 * -- and reports which, so the answer is stamped with the source that
 * decides how far it is trusted.
 */
@Injectable()
export class AiPayeeContactLookupProvider implements PayeeContactLookupProvider {
  constructor(private readonly moduleRef: ModuleRef) {}

  /**
   * Resolved lazily rather than injected: AiModule imports PayeesModule (the
   * assistant's actions create payees), so a PayeesModule -> AiModule edge
   * would put PayeesModule on a require cycle with every module that imports
   * it bare (`module-graph.spec.ts` names eight). Same pattern as
   * `UsersService` / `AuthService`.
   */
  private get aiService(): AiService {
    return this.moduleRef.get(AiService, { strict: false });
  }

  /**
   * @param onlyConfigId pin the lookup to one of the user's providers. A pin
   *   that resolves to nothing -- the provider was deactivated -- is
   *   `no_provider`, never a fall-through to a model the user did not choose.
   */
  async lookup(
    userId: string,
    input: PayeeContactLookupInput,
    onlyConfigId?: string,
  ): Promise<PayeeContactSuggestion[]> {
    const configs = await this.aiService.getActiveConfigs(userId, onlyConfigId);
    if (configs.length === 0) {
      throw new ContactLookupUnavailableError("no_provider");
    }

    let response;
    try {
      response = await this.aiService.completeWithWebSearch(
        userId,
        {
          systemPrompt: PAYEE_LOOKUP_SYSTEM_PROMPT,
          messages: [
            {
              role: "user",
              content: buildPayeeLookupUserMessage(
                input.name,
                input.hint,
                input.known,
              ),
            },
          ],
          temperature: 0,
          maxTokens: PAYEE_LOOKUP_MAX_TOKENS,
          responseFormat: "json",
        },
        { maxUses: PAYEE_LOOKUP_MAX_SEARCHES },
        PAYEE_LOOKUP_FEATURE,
        onlyConfigId,
      );
    } catch (error) {
      // AiService's BadRequestExceptions are the user-actionable ones: relay
      // agent offline, relay timed out, every provider failed. Carry the
      // message so the UI can show that instead of a generic failure.
      if (error instanceof BadRequestException) {
        throw new ContactLookupUnavailableError("failed", error.message);
      }
      throw error;
    }

    const parsed = parseContactJson(response.content);
    // An answer we cannot read is not an answer. "The source looked and found
    // nothing" is `{"matches": []}`, which parses; an empty or truncated turn
    // is a failure, and the two must not arrive at the caller as one reason:
    // `none` is what stamps contact_lookup_at, which retires the automatic
    // lookup for that payee for good, and it is what the surfaces render as
    // "nothing found". A web search that pauses past its continuation limit
    // returns content "" (anthropic.provider.spec.ts pins that), and an answer
    // cut off at PAYEE_LOOKUP_MAX_TOKENS ends mid-object.
    if (!parsed) {
      throw new ContactLookupUnavailableError("failed");
    }

    const source: ContactLookupSource = response.searched
      ? "ai-web-search"
      : response.viaRelay
        ? "ai-relay"
        : "ai-knowledge";
    return sanitizeContactSuggestions(parsed, source, input.known);
  }
}
