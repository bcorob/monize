import type { PaginatedResult } from "../../common/dto/pagination-query.dto";
import type { WarrantyKind } from "../entities/warranty.entity";
import type { WarrantyStatus } from "../warranty-status.util";

/**
 * The purchase a warranty links to, as the warranty pages show it
 * (design section 4). `payeeName` is the row's own `payee_name`, else its
 * payee's name.
 */
export interface LinkedTransaction {
  id: string;
  transactionDate: string;
  payeeName: string | null;
  amount: number;
  currencyCode: string;
  accountId: string;
}

/**
 * The vendor's payee as a logo needs it: `hasLogo` is the payee's own
 * `has_logo`, so a list draws the cached favicon without a read per row.
 */
export interface WarrantyPayee {
  id: string;
  name: string;
  hasLogo: boolean;
}

/**
 * One warranty as every read route answers it (design 6.5). `status` and
 * `daysLeft` are the server's (WTY-002), computed against `today`, the
 * reader's date in their own timezone, which is echoed so a surface can say
 * which day the answer is about.
 */
export interface WarrantyView {
  id: string;
  name: string;
  vendorName: string | null;
  payeeId: string | null;
  /** The payee `payeeId` names; `null` when there is none. */
  payee: WarrantyPayee | null;
  modelNumber: string | null;
  serialNumbers: string[];
  warrantyKind: WarrantyKind;
  purchaseDate: string;
  expiresOn: string | null;
  isLifetime: boolean;
  purchasePrice: number | null;
  currencyCode: string | null;
  productUrl: string | null;
  notes: string | null;
  today: string;
  status: WarrantyStatus;
  daysLeft: number | null;
  documentCount: number;
  openClaimCount: number;
  /** Present when the warranty links to a purchase the reader may see. */
  transactionId?: string;
  linkedTransaction: LinkedTransaction | null;
  /**
   * True only for an acting delegate when the warranty links to a purchase in
   * an account outside their readable scope (design section 9), so the detail
   * can say so rather than "no linked transaction". Always false for the
   * owner. Carries no id: WTY-007 still holds.
   */
  linkedTransactionHidden: boolean;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type WarrantyListResult = PaginatedResult<WarrantyView>;

/** `GET /warranties/summary`: unarchived warranties counted per status. */
export interface WarrantySummary {
  today: string;
  windowDays: number;
  counts: Record<WarrantyStatus, number>;
  total: number;
}
