import { InvestmentAction } from "../../../securities/entities/investment-transaction.entity";
import { TransactionStatus } from "../../../transactions/entities/transaction.entity";
import {
  applyActionToQuantity,
  SHARE_MOVING_ACTIONS,
} from "../../../securities/investment-replay.util";
import { roundToDecimals } from "../../../common/round.util";
import {
  MappedAccounts,
  MappedInvestmentTransaction,
  MappedSecurities,
  MnyHoldingCheck,
} from "../model/mny-import-model";
import { MnyLot } from "../model/mny-rows";
import { MnyWarning } from "../model/mny-warnings";

/**
 * Two independent readings of the same positions, compared.
 *
 * Money keeps `LOT` rows -- one per tax lot, with `htrnSell` empty while the lot
 * is open -- which is a completely separate record of what an account holds from
 * the transaction stream. Replaying the mapped actions and summing the open lots
 * must agree; where they do not, something in the action mapping is wrong for
 * that security and the user needs to know which one before they trust the
 * numbers.
 *
 * A disagreement is **never** an import failure (design task M2.3). PR #192's
 * investment accounts were "a mess" precisely because wrong positions were
 * written silently; a warning that names the account and security is the whole
 * point.
 */

/** Shares are `decimal(20,8)`; anything smaller than this is rounding. */
const QUANTITY_TOLERANCE = 0.00000001;

const QUANTITY_DECIMALS = 8;

/** Actions that change a position at all. Shared with the holdings fold. */
const HOLDING_ACTIONS: ReadonlySet<InvestmentAction> = new Set(
  SHARE_MOVING_ACTIONS,
);

export interface CheckHoldingsInput {
  /** In replay order, as `mapInvestments` returns them. */
  readonly transactions: readonly MappedInvestmentTransaction[];
  readonly lots: readonly MnyLot[];
  readonly accounts: MappedAccounts;
  readonly securities: MappedSecurities;
}

export interface HoldingsCrossCheck {
  readonly checks: readonly MnyHoldingCheck[];
  readonly warnings: readonly MnyWarning[];
}

function positionKey(accountKey: string, securityHandle: number): string {
  return `${accountKey}|${securityHandle}`;
}

/**
 * Positions produced by folding the mapped actions the same way the holdings
 * rebuild does -- through the same `applyActionToQuantity` reducer, so this
 * cannot drift from what the database will hold *after* the import. It stays a
 * separate function only because it reads mapper rows the service's version
 * does not have yet, not because the arithmetic differs.
 */
export function replayPositions(
  transactions: readonly MappedInvestmentTransaction[],
): Map<string, number> {
  const positions = new Map<string, number>();

  for (const transaction of transactions) {
    if (
      !HOLDING_ACTIONS.has(transaction.action) ||
      transaction.quantity === null ||
      // A voided trade moved no shares: the holdings rebuild excludes VOID
      // rows, and Money's own open lots never contain a voided trade's shares,
      // so the projection must skip them or every account with a voided trade
      // reports a share discrepancy the import itself created.
      transaction.status === TransactionStatus.VOID
    ) {
      continue;
    }

    const key = positionKey(transaction.accountKey, transaction.securityHandle);
    positions.set(
      key,
      applyActionToQuantity(
        positions.get(key) ?? 0,
        transaction.action,
        transaction.quantity,
      ),
    );
  }

  return positions;
}

/** Open-lot positions: `LOT` rows Money has not closed with a sale. */
export function openLotPositions(
  lots: readonly MnyLot[],
  accountKeyByHandle: ReadonlyMap<number, string>,
): Map<string, number> {
  const positions = new Map<string, number>();

  for (const lot of lots) {
    if (
      lot.sellTransaction !== null ||
      lot.account === null ||
      lot.security === null
    ) {
      continue;
    }
    const accountKey = accountKeyByHandle.get(lot.account);
    if (accountKey === undefined) {
      continue;
    }
    const key = positionKey(accountKey, lot.security);
    positions.set(key, (positions.get(key) ?? 0) + lot.quantity);
  }

  return positions;
}

/**
 * Compares the two readings, one line per position either of them knows about.
 *
 * Returns no lines at all when the file has no `LOT` table (Money versions that
 * lack it, or a file with no investments): with nothing to compare against, an
 * empty report is honest and a report full of "0 expected" lines is not.
 */
export function crossCheckHoldings(
  input: CheckHoldingsInput,
): HoldingsCrossCheck {
  if (input.lots.length === 0) {
    return { checks: [], warnings: [] };
  }

  const replay = replayPositions(input.transactions);
  const lots = openLotPositions(input.lots, input.accounts.keyByHandle);
  const warnings: MnyWarning[] = [];

  const nameByKey = new Map(
    input.accounts.accounts.map((account) => [account.key, account.name]),
  );

  const checks = [...new Set([...replay.keys(), ...lots.keys()])]
    .map((key): MnyHoldingCheck => {
      const [accountKey, rawHandle] = key.split("|");
      const securityHandle = Number(rawHandle);
      const replayQuantity = roundToDecimals(
        replay.get(key) ?? 0,
        QUANTITY_DECIMALS,
      );
      const lotQuantity = roundToDecimals(
        lots.get(key) ?? 0,
        QUANTITY_DECIMALS,
      );
      const delta = roundToDecimals(
        replayQuantity - lotQuantity,
        QUANTITY_DECIMALS,
      );

      return {
        accountKey,
        securityHandle,
        symbol:
          input.securities.byHandle.get(securityHandle)?.symbol ??
          `hsec=${securityHandle}`,
        lotQuantity,
        replayQuantity,
        delta,
        matches: Math.abs(delta) <= QUANTITY_TOLERANCE,
      };
    })
    // Positions both readings agree are closed are not worth a line.
    .filter(
      (check) =>
        check.matches === false ||
        check.replayQuantity !== 0 ||
        check.lotQuantity !== 0,
    )
    .sort((a, b) =>
      a.accountKey === b.accountKey
        ? a.symbol.localeCompare(b.symbol)
        : a.accountKey.localeCompare(b.accountKey),
    );

  for (const check of checks) {
    if (check.matches) {
      continue;
    }
    warnings.push({
      code: "holdingsMismatch",
      subject: `${nameByKey.get(check.accountKey) ?? check.accountKey}: ${check.symbol}`,
      detail: `replay ${check.replayQuantity} vs lots ${check.lotQuantity}`,
    });
  }

  return { checks, warnings };
}
