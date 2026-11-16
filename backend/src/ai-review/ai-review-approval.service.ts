import {
  HttpException,
  Injectable,
  Logger,
  forwardRef,
  Inject,
} from "@nestjs/common";
import { AiActionsService } from "../ai/actions/ai-actions.service";
import { tr } from "../i18n/translate";
import { AiReviewWorkService } from "./ai-review-work.service";

/** Requests one bulk approval may name. */
export const AI_REVIEW_APPROVE_BATCH_MAX = 100;

/** What happened to one request of a bulk approval. */
export interface ApproveBatchItemResult {
  id: string;
  ok: boolean;
  /** Why it was not approved (translated, safe to show); absent when `ok`. */
  error?: string;
}

export interface ApproveBatchResult {
  results: ApproveBatchItemResult[];
  approved: number;
  failed: number;
}

/**
 * "Approve selected" in the review inbox (design 9): for each request the user
 * names, one after the other, rebuild its confirmation card against the
 * transaction as it is now (`AiReviewWorkService.buildApprovalCard`, the inbox's
 * own path) and commit that card through the SAME `AiActionsService.confirm` a
 * person's click on one card uses. Nothing is written here: the signature, the
 * expiry, the anti-replay claim, the daily write limit (and a profile's
 * exemption from it), the reconciled lock and the request's `markApplied` in the
 * write's own transaction all apply to each item exactly as for a single approval
 * (preview == commit, INV-RECEIPT-003), so an item is applied whole or not at
 * all and one item's refusal never stops or undoes another's. Sequential, in the
 * order given, each its own transaction.
 *
 * Lives beside the actions service (the AI module), not in the queue module: the
 * assistant module imports the queue module, so the queue module cannot import
 * the actions service back.
 */
@Injectable()
export class AiReviewApprovalService {
  private readonly logger = new Logger(AiReviewApprovalService.name);

  constructor(
    private readonly work: AiReviewWorkService,
    @Inject(forwardRef(() => AiActionsService))
    private readonly actions: AiActionsService,
  ) {}

  async approveBatch(
    userId: string,
    ids: readonly string[],
  ): Promise<ApproveBatchResult> {
    const results: ApproveBatchItemResult[] = [];
    for (const id of [...new Set(ids)].slice(0, AI_REVIEW_APPROVE_BATCH_MAX)) {
      results.push(await this.approveOne(userId, id));
    }
    const approved = results.filter((result) => result.ok).length;
    return { results, approved, failed: results.length - approved };
  }

  private async approveOne(
    userId: string,
    id: string,
  ): Promise<ApproveBatchItemResult> {
    try {
      const card = await this.work.buildApprovalCard(userId, id);
      if ("error" in card) return { id, ok: false, error: card.error };
      await this.actions.confirm(userId, {
        actionId: card.action.actionId,
        signature: card.action.signature,
        descriptor: card.action.descriptor as unknown as Record<
          string,
          unknown
        >,
      });
      return { id, ok: true };
    } catch (error) {
      if (error instanceof HttpException) {
        return { id, ok: false, error: error.message };
      }
      // Ours, not the user's to read: log the class, tell them it failed.
      this.logger.warn(
        `Bulk approval of request ${id} failed (${error instanceof Error ? error.constructor.name : "unknown error"})`,
      );
      return {
        id,
        ok: false,
        error: tr(
          "errors.aiReview.approveFailed",
          "This proposal could not be approved. Try it on its own.",
        ),
      };
    }
  }
}
