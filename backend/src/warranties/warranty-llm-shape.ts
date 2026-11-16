import {
  ListWarrantiesDto,
  WarrantyStatusFilter,
} from "./dto/list-warranties.dto";
import { WarrantyView } from "./dto/warranty-response.dto";
import { WarrantyKind } from "./entities/warranty.entity";
import {
  WARRANTY_EXPIRING_WINDOW_DAYS,
  WarrantyStatus,
} from "./warranty-status.util";

/**
 * The `list_warranties` tool's shape (design decision 11), kept apart from
 * the service that reads it: `WarrantiesService.getLlmWarranties` reads the
 * rows through the list route's `findAll` and hands them here, so the model
 * sees the server's `status` and `daysLeft`, never a date sum (WTY-002).
 */

/** `list_warranties`: at most this many rows per call, 20 when unasked. */
export const LLM_WARRANTY_MAX_LIMIT = 50;
export const LLM_WARRANTY_DEFAULT_LIMIT = 20;

/** The `list_warranties` tool's input, after its schema has validated it. */
export interface LlmWarrantyQuery {
  status?: WarrantyStatusFilter;
  q?: string;
  limit?: number;
}

/** One warranty as a model reads it: the server's status, never a date sum. */
export interface LlmWarranty {
  id: string;
  name: string;
  vendorName: string | null;
  warrantyKind: WarrantyKind;
  purchaseDate: string;
  expiresOn: string | null;
  isLifetime: boolean;
  status: WarrantyStatus;
  daysLeft: number | null;
  purchasePrice: number | null;
  currencyCode: string | null;
  serialNumbers: string[];
  linkedTransactionId: string | null;
  openClaimCount: number;
  documentCount: number;
  archived: false;
}

/** `total` counts every match; `warranties` is the first `limit` of them. */
export interface LlmWarrantyList {
  today: string;
  windowDays: number;
  warranties: LlmWarranty[];
  total: number;
}

/**
 * The list query a tool call reads through: unarchived rows only, soonest
 * expiry first, the first page of at most `LLM_WARRANTY_MAX_LIMIT`.
 */
export function llmWarrantyListQuery(
  query: LlmWarrantyQuery,
): ListWarrantiesDto {
  const limit = Math.min(
    LLM_WARRANTY_MAX_LIMIT,
    Math.max(1, Math.floor(query.limit ?? LLM_WARRANTY_DEFAULT_LIMIT)),
  );
  return {
    status: query.status ?? "all",
    q: query.q,
    archived: false,
    sort: "expiresOn",
    page: 1,
    limit,
  };
}

/**
 * The list route's views as the model reads them. `linkedTransactionId` is
 * the view's own `transactionId`, so it is null both when there is no link
 * and when the reader may not see it (WTY-007).
 */
export function toLlmWarrantyList(
  today: string,
  views: readonly WarrantyView[],
  total: number,
): LlmWarrantyList {
  return {
    today,
    windowDays: WARRANTY_EXPIRING_WINDOW_DAYS,
    warranties: views.map((view) => ({
      id: view.id,
      name: view.name,
      vendorName: view.vendorName,
      warrantyKind: view.warrantyKind,
      purchaseDate: view.purchaseDate,
      expiresOn: view.expiresOn,
      isLifetime: view.isLifetime,
      status: view.status,
      daysLeft: view.daysLeft,
      purchasePrice: view.purchasePrice,
      currencyCode: view.currencyCode,
      serialNumbers: view.serialNumbers,
      linkedTransactionId: view.transactionId ?? null,
      openClaimCount: view.openClaimCount,
      documentCount: view.documentCount,
      archived: false as const,
    })),
    total,
  };
}
