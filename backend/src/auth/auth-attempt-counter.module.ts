import { Module } from "@nestjs/common";

import { AuthAttemptCounterService } from "./auth-attempt-counter.service";

/**
 * `AuthAttemptCounterService` on its own, so a consumer takes the counter and
 * not the auth layer.
 *
 * The AI Assistant and MCP daily write caps count on the same
 * `auth_attempt_counters` rows the login, 2FA and step-up limiters use, and
 * there must be exactly one door to that table (a second counter service would
 * be a second opinion about what a scope has spent). Importing `AuthModule` for
 * it would pull users, notifications and delegation into `AiModule` to reach a
 * class whose only dependency is `DataSource`; this module is the edge that says
 * what is actually needed.
 */
@Module({
  providers: [AuthAttemptCounterService],
  exports: [AuthAttemptCounterService],
})
export class AuthAttemptCounterModule {}
