import { Module } from "@nestjs/common";
import { FaviconService } from "./favicon.service";

/**
 * Provides the shared favicon fetcher to every module that caches a brand
 * icon (institutions, payees). It holds no repository and no configuration,
 * so importing it costs nothing beyond the provider.
 */
@Module({
  providers: [FaviconService],
  exports: [FaviconService],
})
export class FaviconModule {}
