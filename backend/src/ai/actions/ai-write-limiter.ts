import { Injectable, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AuthAttemptCounterService } from "../../auth/auth-attempt-counter.service";
import {
  AI_WRITE_SCOPE,
  DailyWriteLimiter,
  resolveDailyWriteLimit,
} from "../../common/daily-write-limiter";

/**
 * Default maximum number of AI-Assistant-confirmed write operations per user
 * per day. Mirrors the MCP daily cap so the two LLM write surfaces are bounded
 * the same way. Override at deploy time with the `AI_DAILY_WRITE_LIMIT`
 * environment variable (a positive integer).
 */
export const AI_DAILY_WRITE_LIMIT = 50;

/**
 * Injectable per-user daily write limiter for the AI Assistant action
 * confirmation endpoint, counted under `AI_WRITE_SCOPE` on the shared counter
 * rows. The effective limit comes from the `AI_DAILY_WRITE_LIMIT` env var when
 * set, otherwise the default above.
 */
@Injectable()
export class AiWriteLimiter extends DailyWriteLimiter {
  constructor(
    counters: AuthAttemptCounterService,
    @Optional() configService?: ConfigService,
  ) {
    super(
      counters,
      AI_WRITE_SCOPE,
      resolveDailyWriteLimit(
        configService?.get("AI_DAILY_WRITE_LIMIT"),
        AI_DAILY_WRITE_LIMIT,
      ),
    );
  }
}
