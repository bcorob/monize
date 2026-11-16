import { Module } from "@nestjs/common";

import { SingleUseTokenService } from "./single-use-token.service";

/**
 * `SingleUseTokenService` on its own, so a consumer takes the service and not
 * the auth layer.
 *
 * The AI action confirmation needs the same one-shot claim the TOTP paths use,
 * and there must be exactly one `single_use_tokens` door (a second claim
 * service would be a second opinion about what has been spent). Importing
 * `AuthModule` for it would pull users, notifications and delegation into
 * `AiModule` to reach a class whose only dependency is `DataSource`; this
 * module is the edge that says what is actually needed.
 */
@Module({
  providers: [SingleUseTokenService],
  exports: [SingleUseTokenService],
})
export class SingleUseTokenModule {}
