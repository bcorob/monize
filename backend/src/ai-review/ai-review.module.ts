import { Module, forwardRef } from "@nestjs/common";
import { NotificationsModule } from "../notifications/notifications.module";
import { AiReviewNotificationService } from "./ai-review-notification.service";
import { AiReviewRequestsService } from "./ai-review-requests.service";
import { AiReviewRequestsExpiryService } from "./ai-review-requests-expiry.service";

/**
 * The AI review queue (design 6.5). It imports nothing from the rules module:
 * `TransactionRulesModule` imports this one to enqueue `request_ai_review`
 * actions, so the edge only runs one way.
 */
@Module({
  imports: [
    // For NotificationDispatchService: the sweep and a daily cron raise the
    // "proposals ready" and "proposals expiring" notices. A `forwardRef`: the
    // notifications module reaches this one back through the scheduled
    // transactions and rules modules (module-graph.spec).
    forwardRef(() => NotificationsModule),
  ],
  providers: [
    AiReviewRequestsService,
    AiReviewRequestsExpiryService,
    AiReviewNotificationService,
  ],
  exports: [AiReviewRequestsService],
})
export class AiReviewModule {}
