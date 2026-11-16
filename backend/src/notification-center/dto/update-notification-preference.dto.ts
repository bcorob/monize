import { IsBoolean, IsInt, IsOptional, Max, Min } from "class-validator";

import { THROTTLE_MAX_MINUTES } from "../notification-preference.constants";

/**
 * A partial update to one category's preferences. Every field is optional so a
 * surface can change any channel independently; the service writes only what is
 * present and keeps the rest. `email` is the report-mode email (live);
 * `emailNotification` and `throttleMinutes` are stored now and consumed with the
 * Phase 5 push dispatch.
 */
export class UpdateNotificationPreferenceDto {
  @IsOptional()
  @IsBoolean()
  email?: boolean;

  @IsOptional()
  @IsBoolean()
  emailNotification?: boolean;

  /** Per-category web push (the other notification-mode fan-out). */
  @IsOptional()
  @IsBoolean()
  push?: boolean;

  /** Per-category UnifiedPush/ntfy (the same wire as push, to a distributor). */
  @IsOptional()
  @IsBoolean()
  unifiedpush?: boolean;

  /** Cooldown window in minutes; 0 disables. Bounded so it cannot suppress for longer than a day. */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(THROTTLE_MAX_MINUTES)
  throttleMinutes?: number;
}
