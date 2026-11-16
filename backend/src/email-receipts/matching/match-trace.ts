import { receiptCandidateWindow } from "./match-receipt";
import type {
  ReceiptMatchCandidate,
  ReceiptMatchResult,
} from "./match-receipt";
import type { ResolvedMatchConfig } from "../parsing/receipt-match-config";
import type {
  ReceiptMatchStrategy,
  ReceiptMatchTextField,
} from "../parsing/receipt-parser.types";

/**
 * What the matcher looked at, for the test panel and the `test` tool (design
 * 5.5): the window, the strategies in the order tried, and for each strategy the
 * transactions it kept (at most ten, closest date first), so a person or an
 * agent sees which candidates were considered and which strategy matched which
 * transaction. Pure: built from what `matchReceipt` returned.
 */
export interface ReceiptMatchTraceTransaction {
  id: string;
  /** `YYYY-MM-DD`. */
  date: string;
  /** Signed, as stored. */
  amount: number;
  payeeName: string | null;
}

export interface ReceiptMatchTraceAttempt {
  strategy: ReceiptMatchStrategy;
  /** How many candidates the strategy kept (the list below shows at most ten). */
  count: number;
  transactions: ReceiptMatchTraceTransaction[];
}

export interface ReceiptMatchTrace {
  /** The inclusive date range candidates were loaded for. */
  window: { from: string; to: string };
  daysBefore: number;
  daysAfter: number;
  /** The amount tolerance, in 1/10000 units. */
  toleranceUnits: number;
  referenceIn: ReceiptMatchTextField[];
  /** The strategies, in the order they are tried. */
  by: ReceiptMatchStrategy[];
  /** Candidates inside the window. */
  considered: number;
  /** The strategies tried, up to and including the one that decided. */
  attempts: ReceiptMatchTraceAttempt[];
  /** The strategy that matched or found several candidates; null when none did. */
  decidedBy: ReceiptMatchStrategy | null;
}

export function buildMatchTrace(
  purchaseDate: string,
  config: ResolvedMatchConfig,
  candidates: readonly ReceiptMatchCandidate[],
  result: ReceiptMatchResult,
): ReceiptMatchTrace {
  const byId = new Map(candidates.map((c) => [c.id, c]));
  return {
    window: receiptCandidateWindow(purchaseDate, config),
    daysBefore: config.daysBefore,
    daysAfter: config.daysAfter,
    toleranceUnits: config.toleranceUnits,
    referenceIn: [...config.referenceIn],
    by: [...config.by],
    considered: result.considered,
    attempts: result.attempts.map((attempt) => ({
      strategy: attempt.strategy,
      count: attempt.count,
      transactions: attempt.candidateIds.flatMap((id) => {
        const candidate = byId.get(id);
        return candidate
          ? [
              {
                id: candidate.id,
                date: candidate.transactionDate,
                amount: candidate.amount,
                payeeName: candidate.payeeName,
              },
            ]
          : [];
      }),
    })),
    decidedBy: result.kind === "unmatched" ? null : result.strategy,
  };
}
