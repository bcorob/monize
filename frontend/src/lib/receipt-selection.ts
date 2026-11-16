import type {
  EmailReceiptBulkFilter,
  EmailReceiptListItem,
  EmailReceiptStatus,
} from '@/types/email-receipts';

/** What a person took out of an "every email matching the filter" selection. */
export interface SelectionExclusions {
  statuses: readonly EmailReceiptStatus[];
  domains: readonly string[];
  /** `YYYY-MM-DD`: emails received before this day are out. */
  from: string | null;
  /** `YYYY-MM-DD`: emails received after this day are out. */
  to: string | null;
}

export const NO_EXCLUSIONS: SelectionExclusions = { statuses: [], domains: [], from: null, to: null };

/** One way of taking emails out of a selection. */
export type Deselection =
  | { kind: 'status'; status: EmailReceiptStatus }
  | { kind: 'domain'; domain: string }
  | { kind: 'before'; day: string }
  | { kind: 'after'; day: string };

export function hasExclusions(exclusions: SelectionExclusions): boolean {
  return (
    exclusions.statuses.length > 0 || exclusions.domains.length > 0 || exclusions.from !== null || exclusions.to !== null
  );
}

/** The UTC day (`YYYY-MM-DD`) of an ISO timestamp, the day the server's range compares. */
export function receivedDay(receivedAt: string): string {
  return receivedAt.slice(0, 10);
}

/** The exclusions after one more deselection; a range only ever narrows. */
export function addExclusion(exclusions: SelectionExclusions, deselection: Deselection): SelectionExclusions {
  switch (deselection.kind) {
    case 'status':
      return exclusions.statuses.includes(deselection.status)
        ? exclusions
        : { ...exclusions, statuses: [...exclusions.statuses, deselection.status] };
    case 'domain':
      return exclusions.domains.includes(deselection.domain)
        ? exclusions
        : { ...exclusions, domains: [...exclusions.domains, deselection.domain] };
    case 'before':
      return { ...exclusions, from: exclusions.from !== null && exclusions.from > deselection.day ? exclusions.from : deselection.day };
    case 'after':
      return { ...exclusions, to: exclusions.to !== null && exclusions.to < deselection.day ? exclusions.to : deselection.day };
  }
}

/** The list's filter (state, sender domain and search) with the exclusions written into it; empty exclusions add no field. */
export function selectionFilter(
  base: Pick<EmailReceiptBulkFilter, 'status' | 'domain' | 'search' | 'searchIn' | 'dateFrom' | 'dateTo'>,
  exclusions: SelectionExclusions,
): EmailReceiptBulkFilter {
  return {
    ...base,
    ...(exclusions.statuses.length > 0 ? { excludeStatuses: [...exclusions.statuses] } : {}),
    ...(exclusions.domains.length > 0 ? { excludeDomains: [...exclusions.domains] } : {}),
    ...(exclusions.from !== null ? { receivedFrom: exclusions.from } : {}),
    ...(exclusions.to !== null ? { receivedTo: exclusions.to } : {}),
  };
}

/** Whether a deselection takes this row out (ticked rows are judged by their own state, sender and day). */
export function deselects(
  receipt: Pick<EmailReceiptListItem, 'status' | 'fromDomain' | 'receivedAt'>,
  deselection: Deselection,
): boolean {
  switch (deselection.kind) {
    case 'status':
      return receipt.status === deselection.status;
    case 'domain':
      return receipt.fromDomain === deselection.domain || receipt.fromDomain.endsWith(`.${deselection.domain}`);
    case 'before':
      return receivedDay(receipt.receivedAt) < deselection.day;
    case 'after':
      return receivedDay(receipt.receivedAt) > deselection.day;
  }
}

/** A proposal the list can approve in bulk: a non-trade email in review that proposes something. */
export function isBulkApprovable(
  receipt: Pick<EmailReceiptListItem, 'status' | 'displayState' | 'isTrade' | 'aiReviewRequestId'>,
): boolean {
  return (
    receipt.status === 'review' && receipt.displayState === 'proposed' && !receipt.isTrade && receipt.aiReviewRequestId !== null
  );
}

/** A trade email with a proposal: bulk approval leaves it out. */
export function isTradeProposal(receipt: Pick<EmailReceiptListItem, 'status' | 'displayState' | 'isTrade'>): boolean {
  return receipt.status === 'review' && receipt.displayState === 'proposed' && receipt.isTrade;
}
