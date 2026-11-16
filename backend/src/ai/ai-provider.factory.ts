import { Injectable, BadRequestException } from "@nestjs/common";
import { tr } from "../i18n/translate";
import { EncryptionService } from "../common/encryption/encryption.service";
import { AiProviderConfig } from "./entities/ai-provider-config.entity";
import { AiProvider } from "./providers/ai-provider.interface";
import { AnthropicProvider } from "./providers/anthropic.provider";
import { OpenAiProvider } from "./providers/openai.provider";
import { OllamaProvider } from "./providers/ollama.provider";
import { OllamaCloudProvider } from "./providers/ollama-cloud.provider";
import { OpenAiCompatibleProvider } from "./providers/openai-compatible.provider";
import { providerFetch } from "./providers/long-running-fetch";
import { AiEgressPolicy } from "./providers/provider-egress";

@Injectable()
export class AiProviderFactory {
  constructor(private readonly encryptionService: EncryptionService) {}

  /**
   * Build the provider for a config. `egress` decides which addresses its
   * requests may connect to (`provider-egress.ts`); it defaults to the
   * strictest, so a caller that has not decided cannot reach a private host.
   * `AiService.resolveEgressPolicy` is where the owner's entitlement is read.
   */
  createProvider(
    config: AiProviderConfig,
    egress: AiEgressPolicy = "public-only",
  ): AiProvider {
    const apiKey = config.apiKeyEnc
      ? this.encryptionService.decrypt(config.apiKeyEnc)
      : "";
    const fetchImpl = providerFetch(egress);

    switch (config.provider) {
      case "anthropic":
        return new AnthropicProvider(
          apiKey,
          config.model || undefined,
          fetchImpl,
        );

      case "openai":
        return new OpenAiProvider(
          apiKey,
          config.model || undefined,
          config.baseUrl || undefined,
          fetchImpl,
        );

      case "ollama":
        return new OllamaProvider(
          config.baseUrl || undefined,
          config.model || undefined,
          fetchImpl,
        );

      case "ollama-cloud":
        if (!apiKey) {
          throw new BadRequestException(
            tr(
              "errors.params.requiredForProvider",
              'A value for "apiKey" is required for the ollama-cloud provider',
              { param: "apiKey", provider: "ollama-cloud" },
            ),
          );
        }
        // Ollama Cloud uses a fixed SaaS endpoint; any user-supplied
        // baseUrl is intentionally dropped here to close an SSRF vector.
        return new OllamaCloudProvider(
          apiKey,
          undefined,
          config.model || undefined,
          fetchImpl,
        );

      case "openai-compatible":
        if (!config.baseUrl) {
          throw new BadRequestException(
            tr(
              "errors.params.requiredForProvider",
              'A value for "baseUrl" is required for the openai-compatible provider',
              { param: "baseUrl", provider: "openai-compatible" },
            ),
          );
        }
        return new OpenAiCompatibleProvider(
          apiKey,
          config.baseUrl,
          config.model || "gpt-4o",
          fetchImpl,
        );

      default:
        throw new BadRequestException(
          tr(
            "errors.ai.unknownProvider",
            `Unknown AI provider: ${config.provider}`,
            { provider: config.provider },
          ),
        );
    }
  }
}
