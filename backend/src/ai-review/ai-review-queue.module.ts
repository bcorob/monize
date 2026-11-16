import { Module, forwardRef } from "@nestjs/common";
import { AccountsModule } from "../accounts/accounts.module";
import { AiActionBuilderModule } from "../ai/actions/ai-action-builder.module";
import { ScheduledTransactionsModule } from "../scheduled-transactions/scheduled-transactions.module";
import { SecuritiesModule } from "../securities/securities.module";
import { TransactionsModule } from "../transactions/transactions.module";
import { AiReviewModule } from "./ai-review.module";
import { AiReviewRequestsController } from "./ai-review-requests.controller";
import { AiReviewWorkService } from "./ai-review-work.service";

/**
 * The AI review queue as a surface: the agents' tool logic (MCP and assistant)
 * and the review inbox's REST routes. Separate from `AiReviewModule`, which
 * stays a leaf the rules module imports to enqueue: this one reaches the
 * transactions module, and that one reaches the rules module back.
 */
@Module({
  imports: [
    AiReviewModule,
    AiActionBuilderModule,
    forwardRef(() => TransactionsModule),
    // The investment preview and the strict ticker lookup a trade card is built
    // with; a `forwardRef` like the transactions edge, the securities module
    // reaches the AI module back.
    forwardRef(() => SecuritiesModule),
    // The scheduled bill or deposit a trade pays, found when its card is built.
    forwardRef(() => ScheduledTransactionsModule),
    // The investment account an agent names for a trade.
    forwardRef(() => AccountsModule),
  ],
  providers: [AiReviewWorkService],
  controllers: [AiReviewRequestsController],
  exports: [AiReviewWorkService],
})
export class AiReviewQueueModule {}
