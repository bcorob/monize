import { Module, forwardRef } from "@nestjs/common";
import { AiReviewModule } from "../../ai-review/ai-review.module";
import { PayeesModule } from "../../payees/payees.module";
import { EmailReceiptParserToolsService } from "./email-receipt-parser-tools.service";
import { EmailReceiptParserPreviewService } from "./email-receipt-parser-preview.service";
import { EmailReceiptParsersService } from "./email-receipt-parsers.service";

/**
 * The receipt parsers' domain services, as a leaf of their own: the parsers
 * service (CRUD, approve, delete, "draft with AI" requests) and the tool service
 * the assistant's `email_receipt_parsers` tool and the MCP tool of the same name
 * share. They live apart from `EmailReceiptsModule` because that module imports
 * `AiModule` (for the drafts and the opt-in auto-apply), and `AiModule` and
 * `McpModule` need these two services for the tool: importing
 * `EmailReceiptsModule` from them would close a cycle. This module needs only the
 * payee lookup and the queue's leaf (`AiReviewModule`); `PayeesModule` is a
 * `forwardRef` because it reaches back to the AI module through the payee
 * lookup (`src/module-graph.spec.ts`).
 */
@Module({
  imports: [forwardRef(() => PayeesModule), AiReviewModule],
  providers: [
    EmailReceiptParsersService,
    EmailReceiptParserToolsService,
    EmailReceiptParserPreviewService,
  ],
  exports: [
    EmailReceiptParsersService,
    EmailReceiptParserToolsService,
    EmailReceiptParserPreviewService,
  ],
})
export class EmailReceiptParsersModule {}
