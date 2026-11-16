import { Module, forwardRef } from "@nestjs/common";
import { AiModule } from "../ai/ai.module";
import { AiReviewModule } from "../ai-review/ai-review.module";
import { AiReviewQueueModule } from "../ai-review/ai-review-queue.module";
import { SingleUseTokenModule } from "../auth/single-use-token.module";
import { EncryptionModule } from "../common/encryption/encryption.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { PayeesModule } from "../payees/payees.module";
import { TransactionsModule } from "../transactions/transactions.module";
import { EmailReceiptAiService } from "./ai/email-receipt-ai.service";
import { EmailReceiptCategoryAiService } from "./ai/email-receipt-category-ai.service";
import {
  ImapFlowMailboxClient,
  ImapMailboxClient,
} from "./imap/imap-mailbox-client";
import { EmailReceiptImportService } from "./import/email-receipt-import.service";
import { EmailReceiptMailboxController } from "./mailbox/email-receipt-mailbox.controller";
import { EmailReceiptMailboxService } from "./mailbox/email-receipt-mailbox.service";
import { OAuthAccessTokenService } from "./oauth/oauth-access-token.service";
import { EmailReceiptOAuthController } from "./oauth/email-receipt-oauth.controller";
import { EmailReceiptOAuthService } from "./oauth/email-receipt-oauth.service";
import { EmailReceiptOAuthConfig } from "./oauth/oauth-config.service";
import { OAuthTokenClient } from "./oauth/oauth-token.client";
import { EmailReceiptParserGenerateService } from "./parsers/email-receipt-parser-generate.service";
import { EmailReceiptParsersController } from "./parsers/email-receipt-parsers.controller";
import { EmailReceiptParsersModule } from "./parsers/email-receipt-parsers.module";
import { EmailReceiptTradeLinkService } from "./receipts/email-receipt-trade-link.service";
import { EmailReceiptTradeService } from "./pipeline/email-receipt-trade.service";
import { EmailReceiptPipelineService } from "./pipeline/email-receipt-pipeline.service";
import { EmailReceiptPollService } from "./poll/email-receipt-poll.service";
import { EmailReceiptsAttentionAlertService } from "./poll/email-receipts-attention-alert.service";
import { ScheduledTransactionsModule } from "../scheduled-transactions/scheduled-transactions.module";
import { EmailReceiptsController } from "./receipts/email-receipts.controller";
import { EmailReceiptsService } from "./receipts/email-receipts.service";
import { EmailReceiptProfileBatchService } from "./receipts/email-receipt-profile-batch.service";

/**
 * Email receipts (docs/future-plans/email-receipts.md): a user's dedicated IMAP
 * mailbox is read, never written, and each order-confirmation email proposes an
 * enrichment of the bank transaction it pays for, through the AI review queue.
 *
 * `ImapMailboxClient` is bound to the real client here and is the one seam a
 * spec replaces to test a service without a network.
 *
 * The edge to the queue runs one way: this module imports `AiReviewModule`
 * (the requests), `AiReviewQueueModule` (`AiReviewWorkService`, the agents'
 * door a receipt's proposal goes through) and `AiModule` (`AiService` for the
 * drafts and `AiActionsService.confirm` for the opt-in auto-apply); none of them
 * imports this module, so no `forwardRef` is needed (`module-graph.spec.ts`).
 *
 * `SingleUseTokenModule` is the one door to `single_use_tokens`: the OAuth
 * `state` nonce is claimed there (INV-RECEIPT-007). The OAuth clients are the
 * operator's, read from the environment by `EmailReceiptOAuthConfig`.
 *
 * Controller order matters: `email-receipts/mailbox` (and its `oauth` routes)
 * is registered before `email-receipts/:id`, so the literal segment is matched
 * first.
 */
@Module({
  imports: [
    EncryptionModule,
    SingleUseTokenModule,
    AiModule,
    AiReviewModule,
    AiReviewQueueModule,
    TransactionsModule,
    // The scheduled bill or deposit a linked trade pays: marked paid on link.
    forwardRef(() => ScheduledTransactionsModule),
    // For NotificationDispatchService: the poll raises one "emails need
    // attention" notification per user through the dispatch seam.
    NotificationsModule,
    // The payee lookup of a schema.org order's seller (never created); a
    // `forwardRef` for the same reason the parsers module's edge is one.
    forwardRef(() => PayeesModule),
    // The parsers service and the shared `email_receipt_parsers` tool logic.
    EmailReceiptParsersModule,
  ],
  controllers: [
    EmailReceiptMailboxController,
    EmailReceiptOAuthController,
    EmailReceiptsController,
    EmailReceiptParsersController,
  ],
  providers: [
    EmailReceiptMailboxService,
    EmailReceiptOAuthConfig,
    OAuthTokenClient,
    OAuthAccessTokenService,
    EmailReceiptOAuthService,
    { provide: ImapMailboxClient, useClass: ImapFlowMailboxClient },
    EmailReceiptPipelineService,
    EmailReceiptTradeService,
    EmailReceiptTradeLinkService,
    EmailReceiptPollService,
    EmailReceiptImportService,
    EmailReceiptsAttentionAlertService,
    EmailReceiptsService,
    EmailReceiptProfileBatchService,
    EmailReceiptAiService,
    EmailReceiptCategoryAiService,
    // Runs the assistant over the wizard's samples; needs AiQueryService, so it
    // lives here and not in the leaf parsers module (see the service).
    EmailReceiptParserGenerateService,
  ],
  exports: [EmailReceiptMailboxService, ImapMailboxClient],
})
export class EmailReceiptsModule {}
