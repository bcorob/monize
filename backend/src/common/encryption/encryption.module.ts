import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { EncryptionService } from "./encryption.service";

/**
 * The server-side encryption key, as a module.
 *
 * Its own module rather than a corner of `AiModule` because three unrelated
 * features store ciphertext under this key, and while it lived in `AiModule`
 * both `BackupModule` and `EmergencyAccessModule` imported the entire AI graph
 * -- providers, controllers, the query engine -- to reach one 90-line service.
 */
@Module({
  imports: [ConfigModule],
  providers: [EncryptionService],
  exports: [EncryptionService],
})
export class EncryptionModule {}
