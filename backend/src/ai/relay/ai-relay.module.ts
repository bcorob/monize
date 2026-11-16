import { Module } from "@nestjs/common";
import { AiRelayService } from "./ai-relay.service";
import { AiRelayController } from "./ai-relay.controller";
import { RelayAttachmentStore } from "./relay-attachment.store";
import { RelayStreamRegistry } from "./relay-stream.registry";
import { RelaySweeperService } from "./relay-sweeper.service";

/**
 * Reverse MCP relay: routes AI chat prompts from the browser to the user's own
 * MCP agent and the answers back. AiRelayService and RelayAttachmentStore are
 * exported so the MCP relay tools and the attachment resource (in McpModule)
 * can claim prompts, post responses and read uploaded attachments against the
 * same `ai_relay_prompts` rows the browser controller feeds.
 *
 * `RelaySweeperService` is declared but not exported: nothing calls it, the
 * `@Cron` decorator is its only entry point.
 *
 * `EVENT_BUS` is not imported here: `EventBusModule` is `@Global()`.
 */
@Module({
  providers: [
    AiRelayService,
    RelayAttachmentStore,
    RelayStreamRegistry,
    RelaySweeperService,
  ],
  controllers: [AiRelayController],
  exports: [AiRelayService, RelayAttachmentStore],
})
export class AiRelayModule {}
