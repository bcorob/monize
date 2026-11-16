import { Injectable, NotFoundException } from "@nestjs/common";
import { DataSource, EntityManager } from "typeorm";
import { returnedRows } from "../../common/db/query-result";
import { withScopedDb } from "../../common/db/scoped-db";
import { tr } from "../../i18n/translate";
import { EmailReceiptParser } from "../entities/email-receipt-parser.entity";
import { DOMAIN_MATCH_SQL } from "../parsers/email-receipt-parser-preview.service";
import { loadApprovedParsers } from "../pipeline/approved-parsers";
import { chooseReceiptParser } from "../pipeline/choose-receipt-parser";
import { ReceiptSourceLines } from "../pipeline/receipt-source-lines";
import type { EmailReceiptProfileBatchAction } from "./dto/email-receipts.dto";
import {
  deleteLockedReceipt,
  ignoreLockedReceipt,
  lockReceipt,
  receiptApplied,
} from "./receipt-disposal";

/** Emails of the profile's sender domains one call looks at. */
export const EMAIL_RECEIPT_PROFILE_BATCH_PAGE = 100;

/** What one call of a profile's bulk action found and did. */
export interface ProfileBatchResult {
  /** Emails of this page the profile matches. */
  matched: number;
  /** Of those, the ones whose proposal was already applied: kept by both actions. */
  applied: number;
  /** Of those, the ones that could not be read: kept by `ignore`, removed by `delete`. */
  unreadable: number;
  /** Of those, the ones already ignored: nothing for `ignore` to do. */
  ignored: number;
  /** Emails this call ignored or deleted (0 for `count`). */
  done: number;
  /** Send this back as `after` for the next page; null when the scan is over. */
  next: string | null;
}

interface ScanRow {
  id: string;
  from_domain: string;
  subject: string;
  body_text: string;
  body_html: string | null;
  status: string;
  request_status: string | null;
}

/**
 * A profile's bulk actions (email-receipts design 8.1): count, ignore or delete
 * every stored email the profile matches. "Matches" is the pipeline's own
 * question, `chooseReceiptParser` over the user's approved profiles: the
 * sender domain, the subject words, the ranking against the other profiles
 * and `requireLine`, so an email another profile of the same domain reads is
 * never touched. A draft profile is asked about as if it were approved.
 *
 * The scan walks the profile's sender-domain emails in id order, a page per
 * call, and answers the cursor of the next page; the client loops until it is
 * null, so every email is looked at once whatever the action does to it. Each
 * email is ignored or deleted in its own transaction under its row lock, with
 * the steps of the single action (`receipt-disposal.ts`), and its state read
 * again there: an email whose proposal was applied is kept by both actions,
 * one that could not be read is kept by `ignore` (as the single action refuses
 * it).
 */
@Injectable()
export class EmailReceiptProfileBatchService {
  constructor(private readonly dataSource: DataSource) {}

  async run(
    userId: string,
    parserId: string,
    action: EmailReceiptProfileBatchAction,
    after?: string,
  ): Promise<ProfileBatchResult> {
    const page = await withScopedDb(this.dataSource, (m) =>
      this.readPage(m, userId, parserId, after ?? null),
    );
    const result: ProfileBatchResult = {
      matched: page.matched.length,
      applied: 0,
      unreadable: 0,
      ignored: 0,
      done: 0,
      next: page.next,
    };
    for (const row of page.matched) {
      if (row.request_status === "applied") result.applied++;
      else if (row.status === "skipped") result.unreadable++;
      else if (row.status === "ignored") result.ignored++;
    }
    if (action === "count") return result;

    for (const row of page.matched) {
      const acted = await withScopedDb(this.dataSource, (m) =>
        action === "ignore"
          ? this.ignoreOne(m, userId, row.id)
          : this.deleteOne(m, userId, row.id),
      );
      if (acted) result.done++;
    }
    return result;
  }

  /** The page after `after` of the profile's sender-domain emails, and the ones the profile reads. */
  private async readPage(
    m: EntityManager,
    userId: string,
    parserId: string,
    after: string | null,
  ): Promise<{ matched: ScanRow[]; next: string | null }> {
    const parser = await m
      .getRepository(EmailReceiptParser)
      .findOne({ where: { id: parserId, userId } });
    if (!parser) {
      throw new NotFoundException(
        tr(
          "errors.emailReceipts.parserNotFound",
          `Receipt parser ${parserId} not found`,
          { id: parserId },
        ),
      );
    }
    // The profiles that read mail, with this one among them as approved (a
    // draft is asked about as the pipeline would once it is approved).
    const approved = await loadApprovedParsers(m, userId);
    // The ranking breaks ties by `createdAt`, so the order of this list does not matter.
    const parsers: EmailReceiptParser[] = [
      ...approved.filter((other) => other.id !== parser.id),
      { ...parser, status: "approved" },
    ];

    const rows = returnedRows<ScanRow>(
      await m.query(
        `SELECT r.id, r.from_domain, r.subject, r.body_text, r.body_html,
                r.status, rq.status AS request_status
           FROM email_receipts r
           LEFT JOIN ai_review_requests rq
             ON rq.id = r.ai_review_request_id AND rq.user_id = r.user_id
          WHERE r.user_id = $1
            AND ${DOMAIN_MATCH_SQL}
            AND ($3::uuid IS NULL OR r.id > $3::uuid)
          ORDER BY r.id ASC
          LIMIT $4`,
        [userId, parser.fromDomains, after, EMAIL_RECEIPT_PROFILE_BATCH_PAGE],
      ),
    );
    const matched = rows.filter((row) => {
      const choice = chooseReceiptParser(
        parsers,
        { fromDomain: row.from_domain, subject: row.subject },
        new ReceiptSourceLines({
          bodyText: row.body_text,
          bodyHtml: row.body_html,
        }),
      );
      return choice.kind === "chosen" && choice.parser.id === parser.id;
    });
    const next =
      rows.length === EMAIL_RECEIPT_PROFILE_BATCH_PAGE
        ? rows[rows.length - 1].id
        : null;
    return { matched, next };
  }

  /** Ignore one email unless it is gone, already ignored, unreadable or applied. */
  private async ignoreOne(
    m: EntityManager,
    userId: string,
    id: string,
  ): Promise<boolean> {
    const receipt = await lockReceipt(m, userId, id);
    if (
      !receipt ||
      receipt.status === "ignored" ||
      receipt.status === "skipped" ||
      (await receiptApplied(m, userId, receipt))
    ) {
      return false;
    }
    await ignoreLockedReceipt(m, userId, receipt);
    return true;
  }

  /** Delete one email unless it is gone or applied. */
  private async deleteOne(
    m: EntityManager,
    userId: string,
    id: string,
  ): Promise<boolean> {
    const receipt = await lockReceipt(m, userId, id);
    if (!receipt || (await receiptApplied(m, userId, receipt))) return false;
    await deleteLockedReceipt(m, userId, receipt);
    return true;
  }
}
