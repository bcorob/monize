import { Injectable, Logger } from "@nestjs/common";
import { AiService } from "../../ai/ai.service";
import { describeFailure } from "../pipeline/receipt-failure";
import {
  buildReceiptCategoriesUserContent,
  RECEIPT_CATEGORIES_SYSTEM_PROMPT,
} from "./email-receipt-ai.prompts";
import { readCategoryChoices } from "./email-receipt-ai.schema";

/** The `feature` label the provider usage log records for a category question. */
export const EMAIL_RECEIPT_CATEGORIES_FEATURE = "email_receipt_categories";

const CATEGORIES_MAX_TOKENS = 2048;

/** One item the AI is asked to categorize: its position in the receipt and what the email says. */
export interface CategoryQuestionItem {
  index: number;
  name: string;
  qty: number;
  /** The line total in 1/10000 units. */
  amount: number;
}

/**
 * Asks the user's AI which of their categories each uncategorized item of a
 * profile's reading belongs to (design 5.6). One bounded call per receipt,
 * through `AiService.complete` (the user's own providers, in their priority
 * order), never on its own: the pipeline calls it only for a profile with
 * `aiCategories` on, a mailbox whose AI mode is not `off`, and a provider that
 * can answer now. The answer is a choice among the user's category ids; an id it
 * does not own, an index it was not asked about and anything unreadable are "no
 * category", so the AI can never put an item under a category that is not the
 * user's, and nothing it says reaches the ledger except through the same card and
 * approval as every other proposal (INV-RECEIPT-003).
 */
@Injectable()
export class EmailReceiptCategoryAiService {
  private readonly logger = new Logger(EmailReceiptCategoryAiService.name);

  constructor(private readonly ai: AiService) {}

  /** Whether an in-app completion can be answered right now (provider configured, relay agent connected). */
  canAnswerNow(userId: string): Promise<boolean> {
    return this.ai.canAnswerNow(userId);
  }

  /**
   * The category the AI chose for each item, by item index (an item it chose
   * none for is absent), or null when the call failed or its answer was not
   * usable: the caller then keeps the items uncategorized.
   */
  async categorize(
    userId: string,
    items: readonly CategoryQuestionItem[],
    categories: ReadonlyMap<string, string>,
  ): Promise<Map<number, string> | null> {
    if (items.length === 0 || categories.size === 0) return new Map();
    try {
      const reply = await this.ai.complete(
        userId,
        {
          systemPrompt: RECEIPT_CATEGORIES_SYSTEM_PROMPT,
          messages: [
            {
              role: "user",
              content: buildReceiptCategoriesUserContent({ items, categories }),
            },
          ],
          maxTokens: CATEGORIES_MAX_TOKENS,
          temperature: 0,
          responseFormat: "json",
        },
        EMAIL_RECEIPT_CATEGORIES_FEATURE,
      );
      const chosen = readCategoryChoices(
        reply.content,
        new Set(items.map((item) => item.index)),
        categories,
      );
      if (chosen === undefined) {
        this.logger.warn("The AI's category answer was not usable");
        return null;
      }
      return chosen;
    } catch (error) {
      this.logger.warn(
        `The AI category question failed (${describeFailure(error)})`,
      );
      return null;
    }
  }
}
