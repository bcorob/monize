'use client';

import { useState, useEffect, useMemo, useCallback, useRef, type ReactNode } from 'react';
import { baseInvestmentAction } from '@/lib/investment-actions';
import { useTranslations } from 'next-intl';
import toast from 'react-hot-toast';
import { ClipboardDocumentIcon, CheckIcon } from '@heroicons/react/24/outline';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { DateInput } from '@/components/ui/DateInput';
import { CurrencyInput } from '@/components/ui/CurrencyInput';
import { NumericInput } from '@/components/ui/NumericInput';
import { Combobox } from '@/components/ui/Combobox';
import { Modal } from '@/components/ui/Modal';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { SplitEditor, SplitRow, createEmptySplits, toSplitRows } from '@/components/transactions/SplitEditor';
import { toOverrideSplits } from './splitSerialization';
import { ScheduledTransaction, PostScheduledTransactionData } from '@/types/scheduled-transaction';
import { Category } from '@/types/category';
import { Account } from '@/types/account';
import { scheduledTransactionsApi } from '@/lib/scheduled-transactions';
import { investmentsApi } from '@/lib/investments';
import { totalFromQuantity, quantityFromTotal, roundPrice, roundMoney, usableClose } from '@/lib/investmentFold';
import { getLocalDateString } from '@/lib/utils';
import { buildCategoryTree } from '@/lib/categoryUtils';
import {
  roundToCents,
  roundToDecimals,
  getCurrencySymbol,
  formatAmount,
  FX_RATE_DISPLAY_DECIMALS,
} from '@/lib/format';
import { exchangeRatesApi } from '@/lib/exchange-rates';
import { getErrorMessage } from '@/lib/errors';
import { createLogger } from '@/lib/logger';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { getProjectedBalanceAtDate, FutureTransaction } from '@/lib/forecast';
import { computeInvestmentCashImpact } from '@/lib/investmentCashImpact';
import { InvestmentAction } from '@/types/investment';

const logger = createLogger('PostTransactionDialog');

// Liability accounts normally carry negative balances — only warn if over credit limit
const LIABILITY_TYPES = new Set(['CREDIT_CARD', 'LOAN', 'MORTGAGE', 'LINE_OF_CREDIT']);

function isLiabilityAccount(account: Account): boolean {
  return LIABILITY_TYPES.has(account.accountType);
}

/** Returns true when a projected balance should trigger a warning for the given account. */
function shouldWarnBalance(account: Account, projectedBalance: number): boolean {
  if (isLiabilityAccount(account)) {
    // Liability accounts: only warn if the balance exceeds the credit limit (if set)
    if (account.creditLimit != null && account.creditLimit > 0) {
      // Balance is negative, credit limit is positive — warn when balance is more negative than -creditLimit
      return projectedBalance < -account.creditLimit;
    }
    // No credit limit set — no warning for liability accounts
    return false;
  }
  // Asset accounts: warn if balance goes negative
  return projectedBalance < 0;
}

interface PostTransactionDialogProps {
  isOpen: boolean;
  scheduledTransaction: ScheduledTransaction;
  categories: Category[];
  accounts: Account[];
  scheduledTransactions: ScheduledTransaction[];
  futureTransactions: FutureTransaction[];
  onClose: () => void;
  onPosted: () => void;
  /**
   * Create a category from text typed into any of this dialog's category
   * pickers -- the Category field and each split line's own -- resolving to the
   * created category. The page owns the category list, so it owns the creation.
   * When omitted the pickers only select from what already exists.
   */
  onCreateCategory?: (name: string) => Promise<Category | null | undefined>;
}

export function PostTransactionDialog({
  isOpen,
  scheduledTransaction,
  categories,
  accounts,
  scheduledTransactions,
  futureTransactions,
  onClose,
  onPosted,
  onCreateCategory,
}: PostTransactionDialogProps) {
  const t = useTranslations('scheduledTransactions');
  const tc = useTranslations('common');
  const { formatCurrency, formatNumber, formatPrice } = useNumberFormat();
  const [isLoading, setIsLoading] = useState(false);
  const [amount, setAmount] = useState<number>(0);
  const [amountCopied, setAmountCopied] = useState(false);
  const [categoryId, setCategoryId] = useState<string>('');
  const [description, setDescription] = useState<string>('');
  const [isSplit, setIsSplit] = useState(false);
  const [splits, setSplits] = useState<SplitRow[]>([]);
  const [transactionDate, setTransactionDate] = useState<string>('');
  const [referenceNumber, setReferenceNumber] = useState<string>('');

  // Investment-mode per-occurrence overrides
  const [investmentQuantity, setInvestmentQuantity] = useState<number | ''>('');
  const [investmentPrice, setInvestmentPrice] = useState<number | ''>('');
  const [investmentTotalAmount, setInvestmentTotalAmount] = useState<number | ''>('');
  // UI-only computed total for qty+price actions (qty * price + commission).
  // Not sent to the backend -- the API derives the total from qty/price/commission.
  const [investmentTotalValue, setInvestmentTotalValue] = useState<number | ''>('');
  const [marketPrice, setMarketPrice] = useState<number | null>(null);
  // True only once a price request completes and returns no usable close -- the
  // one state that means "this security genuinely has no price history", kept
  // apart from marketPrice == null (also the loading window and a failed lookup).
  // A failed lookup is not an empty dataset (frontend/CLAUDE.md).
  const [priceHistoryEmpty, setPriceHistoryEmpty] = useState(false);
  // True when the price OR quantity prefilled below came from a per-occurrence
  // override -- values the user deliberately saved for THIS occurrence. They are
  // instructions, not a stale template, so the market-price refresh below must
  // not silently overwrite them (see OverrideEditorDialog: a stored value wins).
  // Keyed off both fields: an override that set only a quantity would otherwise
  // have its shares rescaled by the refresh, which is the same defect one axis
  // over. A base schedule with no override keeps the DCA refresh: its price is a
  // creation-time snapshot the post is meant to bring up to date.
  const [investmentFromStoredOverride, setInvestmentFromStoredOverride] = useState(false);
  // True once the user edits any investment field. The market fetch can resolve
  // after the dialog opens, so without this a price/quantity typed in the
  // meantime would be overwritten when the close finally lands.
  const [userEditedInvestment, setUserEditedInvestment] = useState(false);

  const isInvestmentKind = scheduledTransaction.isInvestment;
  const investmentAction = scheduledTransaction.investmentAction;
  const isInvestmentQuantityPrice = isInvestmentKind &&
    investmentAction != null &&
    ['BUY', 'SELL', 'REINVEST'].includes(baseInvestmentAction(investmentAction));
  const isInvestmentQuantityOnly = isInvestmentKind &&
    (investmentAction === 'ADD_SHARES' || investmentAction === 'REMOVE_SHARES' || investmentAction === 'SPLIT');
  const isInvestmentAmountOnly = isInvestmentKind &&
    investmentAction != null &&
    ['DIVIDEND', 'INTEREST', 'CAPITAL_GAIN'].includes(baseInvestmentAction(investmentAction));

  const todayStr = useMemo(() => getLocalDateString(), []);

  const sourceAccount = useMemo(() => {
    // For investment-kind rows, the cash side -- not the brokerage -- is what
    // moves. Pick the funding account if the user explicitly set one
    // (contribution+buy from a checking account), otherwise the brokerage's
    // paired INVESTMENT_CASH account. Fall back to the brokerage only if no
    // pair exists, so we still show *something* useful.
    if (scheduledTransaction.isInvestment) {
      // Only a BUY/SELL settles through the funding account; for any other
      // action the backend routes cash to the brokerage's linked cash account
      // and ignores a stale stored funding account, so the preview must too or
      // a legacy DIVIDEND projects a balance for the wrong account (issue #1154).
      const usesExplicitFunding =
        scheduledTransaction.investmentAction === 'BUY' ||
        scheduledTransaction.investmentAction === 'SELL';
      if (
        usesExplicitFunding &&
        scheduledTransaction.investmentFundingAccountId
      ) {
        return (
          accounts.find(
            (a) => a.id === scheduledTransaction.investmentFundingAccountId,
          ) ??
          scheduledTransaction.investmentFundingAccount ??
          null
        );
      }
      const brokerage = accounts.find(
        (a) => a.id === scheduledTransaction.accountId,
      );
      if (brokerage?.linkedAccountId) {
        const cash = accounts.find(
          (a) => a.id === brokerage.linkedAccountId,
        );
        if (cash) return cash;
      }
      return brokerage ?? scheduledTransaction.account ?? null;
    }
    return scheduledTransaction.account
      ? accounts.find((a) => a.id === scheduledTransaction.accountId) ??
          scheduledTransaction.account
      : null;
  }, [
    accounts,
    scheduledTransaction.account,
    scheduledTransaction.accountId,
    scheduledTransaction.isInvestment,
    scheduledTransaction.investmentAction,
    scheduledTransaction.investmentFundingAccountId,
    scheduledTransaction.investmentFundingAccount,
  ]);
  const transferAccount = scheduledTransaction.isTransfer && scheduledTransaction.transferAccount
    ? accounts.find(a => a.id === scheduledTransaction.transferAccountId) ?? scheduledTransaction.transferAccount
    : null;

  // ── Foreign-currency posting ──────────────────────────────────────────────
  //
  // A foreign-currency schedule fixes the amount the biller charges, not what
  // the account is debited. The rate is therefore looked up for the date being
  // posted -- not the estimate the bills list shows -- so moving the date here
  // re-converts, and a back-dated posting uses that day's rate.
  const isForeignPosting =
    !isInvestmentKind &&
    !!scheduledTransaction.originalCurrencyCode &&
    scheduledTransaction.originalAmount != null;
  const entryCurrency = scheduledTransaction.originalCurrencyCode ?? '';
  const [foreignAmount, setForeignAmount] = useState<number>(0);
  const [postFxRate, setPostFxRate] = useState<number | null>(null);
  const [postFxRateLoading, setPostFxRateLoading] = useState(false);
  // True when the last lookup errored rather than returning an answer. Kept
  // apart from `postFxRate === null` so a throttled or offline request is not
  // reported to the user as "no exchange rate exists".
  const [rateLookupFailed, setRateLookupFailed] = useState(false);
  // Set once the user types a converted total of their own, so a later date
  // tweak does not discard the rate that figure implies. Same guard, and the
  // same reason, as `rateOverriddenRef` in TransactionForm.
  const rateOverriddenRef = useRef(false);

  const postingAccount = useMemo(
    () => accounts.find((a) => a.id === scheduledTransaction.accountId) ?? null,
    [accounts, scheduledTransaction.accountId],
  );
  const postFxFeePercent = postingAccount?.fxFeePercent ?? undefined;

  // Convert at the posting-date rate, folding in the account's foreign
  // transaction fee. Mirrors `applyFxConversion` on the backend, which is what
  // actually books the row.
  const convertForeign = useCallback(
    (foreign: number, rate: number) => {
      const base = roundToCents(foreign * rate);
      const fee =
        postFxFeePercent && postFxFeePercent > 0
          ? -roundToCents((Math.abs(base) * postFxFeePercent) / 100)
          : 0;
      return { base, fee, total: roundToCents(base + fee) };
    },
    [postFxFeePercent],
  );

  // Re-fetch the rate whenever the posting date changes, debounced.
  //
  // The debounce is not cosmetic. Stepping the date with the arrow keys fires a
  // change per keypress, and the rate endpoint is throttled per minute -- an
  // undebounced lookup burned the whole allowance in a few presses and every
  // later date came back 429, which the UI then reported as "no exchange rate
  // found" for dates that plainly had one. Same 300ms wait TransactionForm uses,
  // for the same reason.
  useEffect(() => {
    if (!isOpen || !isForeignPosting || !transactionDate) return;
    if (rateOverriddenRef.current) return;
    let cancelled = false;
    setPostFxRateLoading(true);
    const handle = setTimeout(() => {
      exchangeRatesApi
        .getRateForDate(entryCurrency, scheduledTransaction.currencyCode, transactionDate)
        .then((rate) => {
          // `cancelled` only trips when this effect's own deps change; typing
          // a converted total does not, so a lookup started before the user
          // overrode the rate is still in flight when it resolves. Without
          // this check its answer -- for a rate the request itself made
          // stale -- overwrote the one the user just derived.
          if (cancelled || rateOverriddenRef.current) return;
          setPostFxRate(rate);
          // The server answered: `null` here really does mean no rate exists
          // for this pair and date, so the warning is a fact.
          setRateLookupFailed(false);
          setPostFxRateLoading(false);
        })
        .catch(() => {
          if (cancelled || rateOverriddenRef.current) return;
          // The request itself failed (offline, throttled, timed out). That is
          // not evidence about the rate, so the preview goes blank rather than
          // claiming none exists -- and posting still works, because the
          // backend resolves the rate for the date itself.
          setPostFxRate(null);
          setRateLookupFailed(true);
          setPostFxRateLoading(false);
        });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [
    isOpen,
    isForeignPosting,
    entryCurrency,
    scheduledTransaction.currencyCode,
    transactionDate,
  ]);

  // Keep the account-currency amount (what the balance preview and the split
  // editor work in) in step with the foreign amount and the fetched rate.
  useEffect(() => {
    if (!isForeignPosting || postFxRate == null) return;
    setAmount(convertForeign(foreignAmount, postFxRate).total);
  }, [isForeignPosting, foreignAmount, postFxRate, convertForeign]);

  const foreignConversion =
    isForeignPosting && postFxRate != null
      ? convertForeign(foreignAmount, postFxRate)
      : null;

  // User typed the account-currency total directly: back the fee out to the
  // pre-fee base, derive the rate (10 dp) so it round-trips, and mark the rate
  // overridden. Mirrors `handleConvertedTotalOverride` in TransactionForm --
  // the posted row still satisfies originalAmount x exchangeRate ~ base, so the
  // backend re-deriving the fee lands on the same total the user typed.
  const handleConvertedTotalChange = (total: number | undefined) => {
    if (total === undefined || !foreignAmount) return;
    // A total that already equals the one the fetched rate produces is not an
    // override -- it is the field handing back what it was displaying. Deriving
    // from it would replace the fetched 10dp rate with one reverse-engineered
    // from a cents-rounded total and stop the date effect re-fetching, so the
    // posted row would carry a rate the user never chose.
    if (foreignConversion && total === foreignConversion.total) return;
    let base = total;
    if (postFxFeePercent && postFxFeePercent > 0) {
      // total = base - |base| * p; solve for base by its (matching) sign.
      const p = postFxFeePercent / 100;
      base = roundToCents(total >= 0 ? total / (1 - p) : total / (1 + p));
    }
    rateOverriddenRef.current = true;
    // A lookup can still be in flight -- its own .then/.catch now checks the
    // ref above, but the loading spinner and any earlier failure banner are
    // this render's problem, not that request's, and must clear the moment
    // the manual value becomes authoritative.
    setPostFxRateLoading(false);
    setRateLookupFailed(false);
    setPostFxRate(roundToDecimals(base / foreignAmount, 10));
    setAmount(roundToCents(total));
  };

  // The cash impact that will actually post -- reflects per-occurrence edits
  // the user makes here, not just the base scheduled transaction's amount.
  // For investments we re-derive from the current quantity / price / total so
  // the projected-balance header updates as the user types.
  const effectivePostAmount = useMemo(() => {
    if (!isInvestmentKind) return amount;
    if (!investmentAction) return 0;
    if (isInvestmentAmountOnly) {
      return investmentTotalAmount === '' ? 0 : Number(investmentTotalAmount);
    }
    if (isInvestmentQuantityPrice) {
      const qty = investmentQuantity === '' ? 0 : Number(investmentQuantity);
      const price = investmentPrice === '' ? 0 : Number(investmentPrice);
      const commission = Number(scheduledTransaction.investmentCommission ?? 0);
      return computeInvestmentCashImpact(
        investmentAction as InvestmentAction,
        qty,
        price,
        commission,
      );
    }
    // ADD_SHARES / REMOVE_SHARES / SPLIT -- shares move, no cash impact.
    return 0;
  }, [
    isInvestmentKind,
    isInvestmentAmountOnly,
    isInvestmentQuantityPrice,
    investmentAction,
    investmentQuantity,
    investmentPrice,
    investmentTotalAmount,
    scheduledTransaction.investmentCommission,
    amount,
  ]);

  const projectedBalances = useMemo(() => {
    if (!transactionDate) return null;
    const sourceBefore = sourceAccount
      ? getProjectedBalanceAtDate(sourceAccount, transactionDate, scheduledTransactions, futureTransactions, scheduledTransaction.id, accounts)
      : null;
    const transferBefore = transferAccount
      ? getProjectedBalanceAtDate(transferAccount, transactionDate, scheduledTransactions, futureTransactions, scheduledTransaction.id, accounts)
      : null;
    return {
      sourceBefore,
      sourceAfter: sourceBefore != null ? roundToCents(sourceBefore + effectivePostAmount) : null,
      transferBefore,
      transferAfter: transferBefore != null ? roundToCents(transferBefore - effectivePostAmount) : null,
    };
  }, [sourceAccount, transferAccount, transactionDate, effectivePostAmount, scheduledTransactions, futureTransactions, scheduledTransaction.id, accounts]);

  // Initialize form with transaction values (including override if exists)
  useEffect(() => {
    if (isOpen) {
      const nextOverride = scheduledTransaction.nextOverride;

      // Use override values if they exist, otherwise use base transaction values
      const amt = roundToCents(
        nextOverride?.amount ?? scheduledTransaction.amount
      );
      setAmount(amt);
      // Foreign-currency schedule: the field the user edits is the biller's
      // amount in its own currency. An occurrence override deliberately stays
      // an account-currency figure (see resolveFxForPosting on the backend), so
      // it does not seed this.
      setForeignAmount(
        scheduledTransaction.originalAmount != null
          ? roundToCents(Number(scheduledTransaction.originalAmount))
          : 0,
      );
      setPostFxRate(null);
      setRateLookupFailed(false);
      rateOverriddenRef.current = false;
      setCategoryId(nextOverride?.categoryId ?? scheduledTransaction.categoryId ?? '');
      setDescription(nextOverride?.description ?? scheduledTransaction.description ?? '');
      setIsSplit(nextOverride?.isSplit ?? scheduledTransaction.isSplit);

      setReferenceNumber('');

      // Set transaction date: use override date if modified, otherwise next due date
      const nextDueDate = (nextOverride?.overrideDate ?? scheduledTransaction.nextDueDate).split('T')[0];
      setTransactionDate(nextDueDate);

      // Initialize splits
      if ((nextOverride?.isSplit ?? scheduledTransaction.isSplit)) {
        if (nextOverride?.splits && nextOverride.splits.length > 0) {
          setSplits(toSplitRows(nextOverride.splits.map((s, i) => ({
            id: `override-${i}`,
            ...s,
          }))));
        } else if (scheduledTransaction.splits && scheduledTransaction.splits.length > 0) {
          setSplits(toSplitRows(scheduledTransaction.splits));
        } else {
          setSplits(createEmptySplits(amt));
        }
      } else {
        setSplits(createEmptySplits(amt));
      }

      // Investment-kind: prefill from the next-occurrence override if one
      // exists, falling back to the base scheduled transaction's saved values.
      // Without the override fallback, a user who has tweaked the upcoming
      // occurrence (e.g. a one-off DRIP buy at a different quantity) sees the
      // original numbers in the Post dialog.
      const overrideQty = nextOverride?.investmentQuantity;
      const overridePrice = nextOverride?.investmentPrice;
      const overrideTotal = nextOverride?.investmentTotalAmount;
      const initialQty =
        overrideQty != null
          ? Number(overrideQty)
          : scheduledTransaction.investmentQuantity != null
            ? Number(scheduledTransaction.investmentQuantity)
            : '';
      const initialPrice =
        overridePrice != null
          ? Number(overridePrice)
          : scheduledTransaction.investmentPrice != null
            ? Number(scheduledTransaction.investmentPrice)
            : '';
      setInvestmentQuantity(initialQty);
      setInvestmentPrice(initialPrice);
      setInvestmentFromStoredOverride(overridePrice != null || overrideQty != null);
      setUserEditedInvestment(false);
      setInvestmentTotalAmount(
        overrideTotal != null
          ? Number(overrideTotal)
          : scheduledTransaction.investmentTotalAmount != null
            ? Number(scheduledTransaction.investmentTotalAmount)
            : '',
      );
      // Seed the UI-only total. Prefer the originally-scheduled total (override
      // or base) so it stays fixed when the latest market price is applied --
      // the price change should move the share quantity, not the amount
      // invested. Fall back to qty * price (+ signed commission) only when no
      // total was scheduled.
      const storedTotal =
        overrideTotal != null
          ? Number(overrideTotal)
          : scheduledTransaction.investmentTotalAmount != null
            ? Number(scheduledTransaction.investmentTotalAmount)
            : null;
      if (storedTotal != null && storedTotal > 0) {
        setInvestmentTotalValue(roundMoney(storedTotal));
      } else if (
        typeof initialQty === 'number' &&
        initialQty > 0 &&
        typeof initialPrice === 'number' &&
        initialPrice > 0
      ) {
        const commission = Number(scheduledTransaction.investmentCommission ?? 0);
        const sign = baseInvestmentAction(scheduledTransaction.investmentAction as InvestmentAction) === 'SELL' ? -1 : 1;
        setInvestmentTotalValue(totalFromQuantity(initialQty, initialPrice, sign, commission));
      } else {
        setInvestmentTotalValue('');
      }
      setMarketPrice(null);
      // This dialog stays mounted across open/close, so reset the previous
      // occurrence's "no history" verdict here too -- otherwise reopening for a
      // different security paints the hint one frame before the fetch resets it.
      setPriceHistoryEmpty(false);
    }
  }, [isOpen, scheduledTransaction]);

  // Fetch the most recent close price for the security so we can auto-fill
  // the Price field (matching the new-scheduled-transaction form's behaviour).
  useEffect(() => {
    if (!isOpen || !isInvestmentKind || !isInvestmentQuantityPrice) return;
    const securityId = scheduledTransaction.investmentSecurityId;
    if (!securityId) return;
    let cancelled = false;
    // Reset while the request is in flight: "no price history" is a
    // completed-empty result, not the loading window and not a failed lookup.
    setPriceHistoryEmpty(false);
    investmentsApi
      .getSecurityPrices(securityId, { limit: 1 })
      .then((prices) => {
        if (cancelled) return;
        const close = usableClose(prices);
        setMarketPrice(close ? close.price : null);
        setPriceHistoryEmpty(close === null);
      })
      .catch((err) => {
        if (cancelled) return;
        setMarketPrice(null);
        // A failed lookup is not an empty dataset -- leave the hint off.
        setPriceHistoryEmpty(false);
        logger.warn?.('Failed to fetch latest price', err);
      });
    return () => {
      cancelled = true;
    };
  }, [
    isOpen,
    isInvestmentKind,
    isInvestmentQuantityPrice,
    scheduledTransaction.investmentSecurityId,
  ]);

  // When the market price arrives, overwrite the Price with the latest value.
  // The originally-scheduled total stays fixed, so the new price recomputes the
  // share quantity rather than the amount invested. Uses the "info from
  // previous render" pattern to avoid violating react-hooks/set-state-in-effect.
  //
  // Two exemptions keep this from silently overwriting a user instruction:
  // - `investmentFromStoredOverride`: a price or quantity the user saved for
  //   this occurrence stands, exactly as saved (the same rule the override
  //   editor enforces on its side).
  // - `userEditedInvestment`: a value the user typed after the dialog opened but
  //   before this fetch resolved is theirs, not something to clobber on arrival.
  const investmentSign = baseInvestmentAction(scheduledTransaction.investmentAction as InvestmentAction) === 'SELL' ? -1 : 1;
  const investmentCommission = Number(scheduledTransaction.investmentCommission ?? 0);

  const [lastSeenMarketPrice, setLastSeenMarketPrice] = useState<number | null>(null);
  if (isOpen && marketPrice !== lastSeenMarketPrice) {
    setLastSeenMarketPrice(marketPrice);
    if (
      isInvestmentQuantityPrice &&
      !investmentFromStoredOverride &&
      !userEditedInvestment &&
      marketPrice != null &&
      marketPrice > 0
    ) {
      const rounded = roundPrice(marketPrice);
      setInvestmentPrice(rounded);
      if (investmentTotalValue !== '' && Number(investmentTotalValue) > 0) {
        // Preserve the scheduled total -- adjust quantity to the new price.
        setInvestmentQuantity(quantityFromTotal(Number(investmentTotalValue), rounded, investmentSign, investmentCommission));
      } else if (investmentQuantity !== '' && Number(investmentQuantity) > 0) {
        // No scheduled total to preserve -- fall back to deriving it from qty.
        setInvestmentTotalValue(totalFromQuantity(Number(investmentQuantity), rounded, investmentSign, investmentCommission));
      }
    }
  }

  // A close rounded for display (6dp). marketPrice is already null unless it is a
  // usable positive number (usableClose rejects zero/negative/NaN before it is
  // set), so a plain null check is all that is needed here.
  const roundedMarketPrice = marketPrice != null ? roundPrice(marketPrice) : null;

  const handleInvestmentQuantityChange = (raw: number | undefined) => {
    const qty = raw ?? '';
    setUserEditedInvestment(true);
    setInvestmentQuantity(qty);
    if (qty !== '' && investmentPrice !== '' && Number(investmentPrice) > 0) {
      setInvestmentTotalValue(
        totalFromQuantity(Number(qty), Number(investmentPrice), investmentSign, investmentCommission),
      );
    }
  };

  const handleInvestmentPriceChange = (raw: number | undefined) => {
    const price = raw ?? '';
    setUserEditedInvestment(true);
    setInvestmentPrice(price);
    if (price !== '' && Number(price) > 0) {
      if (investmentTotalValue !== '') {
        // User has a target total -- keep it and derive quantity.
        setInvestmentQuantity(
          quantityFromTotal(Number(investmentTotalValue), Number(price), investmentSign, investmentCommission),
        );
      } else if (investmentQuantity !== '') {
        setInvestmentTotalValue(
          totalFromQuantity(Number(investmentQuantity), Number(price), investmentSign, investmentCommission),
        );
      }
    }
  };

  const handleInvestmentTotalValueChange = (raw: number | undefined) => {
    setUserEditedInvestment(true);
    if (raw === undefined) {
      setInvestmentTotalValue('');
      return;
    }
    setInvestmentTotalValue(raw);
    if (investmentPrice !== '' && Number(investmentPrice) > 0) {
      setInvestmentQuantity(
        quantityFromTotal(raw, Number(investmentPrice), investmentSign, investmentCommission),
      );
    }
  };

  const categoryOptions = useMemo(() => {
    return buildCategoryTree(categories).map(({ category }) => {
      const parentCategory = category.parentId
        ? categories.find(c => c.id === category.parentId)
        : null;
      return {
        value: category.id,
        label: parentCategory ? `${parentCategory.name}: ${category.name}` : category.name,
      };
    });
  }, [categories]);

  const handlePost = async () => {
    // A missing preview is not a reason to block: the backend resolves the rate
    // for the posting date itself (carry-forward over weekends, a fetched
    // window, then the latest stored rate) and raises a translated error only
    // if the pair has no rate anywhere. Blocking here on a preview the client
    // could not fetch -- because the lookup was throttled, say -- refused
    // postings that would have gone through fine.
    if (isInvestmentKind) {
      if (isInvestmentQuantityPrice || isInvestmentQuantityOnly) {
        if (investmentQuantity === '' || Number(investmentQuantity) <= 0) {
          toast.error(t('postDialog.toasts.quantityRequired'));
          return;
        }
      }
      if (isInvestmentQuantityPrice) {
        if (investmentPrice === '' || Number(investmentPrice) <= 0) {
          toast.error(t('postDialog.toasts.priceRequired'));
          return;
        }
      }
      if (isInvestmentAmountOnly) {
        if (
          investmentTotalAmount === '' ||
          Number(investmentTotalAmount) <= 0
        ) {
          toast.error(t('postDialog.toasts.totalAmountRequired'));
          return;
        }
      }
    } else if (isSplit) {
      if (splits.length < 2) {
        toast.error(t('postTransaction.minSplits'));
        return;
      }
      const splitsTotal = splits.reduce((sum, s) => sum + (Number(s.amount) || 0), 0);
      const remaining = Math.abs(amount - splitsTotal);
      if (remaining >= 0.01) {
        toast.error(t('postTransaction.splitMismatch'));
        return;
      }
    }

    setIsLoading(true);
    try {
      const postData: PostScheduledTransactionData = isInvestmentKind
        ? {
            transactionDate,
            description: description || null,
            investmentQuantity:
              investmentQuantity === '' ? undefined : Number(investmentQuantity),
            investmentPrice:
              investmentPrice === '' ? undefined : Number(investmentPrice),
            investmentTotalAmount:
              investmentTotalAmount === '' ? undefined : Number(investmentTotalAmount),
          }
        : {
            transactionDate,
            // For a foreign-currency schedule only the biller's amount is sent,
            // so the backend -- not this dialog -- decides what is booked;
            // sending `amount` would pin it and override the lookup. The rate
            // goes along only when the user set it themselves by typing a
            // converted total. Otherwise the backend resolves it for the
            // posting date, which means a preview that was throttled or offline
            // costs nothing: the posting is still correct.
            ...(isForeignPosting
              ? {
                  originalAmount: foreignAmount,
                  ...(rateOverriddenRef.current ? { exchangeRate: postFxRate } : {}),
                }
              : { amount }),
            categoryId: isSplit ? null : (categoryId || null),
            description: description || null,
            referenceNumber: referenceNumber || undefined,
            isSplit,
            splits: isSplit ? toOverrideSplits(splits) : undefined,
          };

      await scheduledTransactionsApi.post(scheduledTransaction.id, postData);
      toast.success(t('postDialog.toasts.posted'));
      onPosted();
      onClose();
    } catch (error) {
      toast.error(getErrorMessage(error, t('postDialog.toasts.postFailed')));
    } finally {
      setIsLoading(false);
    }
  };

  const handleAmountChange = (newAmount: number) => {
    setAmount(roundToCents(newAmount));
  };

  // Copy the unsigned amount (no minus sign, no currency symbol or commas) so it
  // pastes cleanly into other fields, e.g. when reconciling against a statement.
  const handleCopyAmount = async () => {
    try {
      // The button is attached to the Amount field, so it copies whatever that
      // field is showing: the biller's own-currency figure while posting a
      // foreign-currency schedule, the account-currency amount otherwise.
      const copied = isForeignPosting ? foreignAmount : amount;
      await navigator.clipboard.writeText(formatAmount(Math.abs(copied)));
      setAmountCopied(true);
      toast.success(t('postDialog.toasts.amountCopied'));
      window.setTimeout(() => setAmountCopied(false), 2000);
    } catch (error) {
      toast.error(t('postDialog.toasts.copyFailed'));
      logger.error?.('Failed to copy amount', error);
    }
  };

  const currentCategory = categoryId ? categories.find(c => c.id === categoryId) : null;
  // Parent-qualified label (e.g. "Investments: IKE") for the category, reusing
  // the dropdown's option labels so a categorized transfer can show it.
  const currentCategoryLabel = categoryId
    ? (categoryOptions.find(o => o.value === categoryId)?.label ?? currentCategory?.name ?? null)
    : null;

  // Rendered next to the Category for regular rows, or standalone for
  // split/transfer rows where no Category field is shown.
  const referenceNumberField = (
    <div>
      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
        {t('postDialog.referenceNumberLabel')}
      </label>
      <Input
        type="text"
        value={referenceNumber}
        onChange={(e) => setReferenceNumber(e.target.value)}
        placeholder={t('postDialog.referencePlaceholder')}
      />
    </div>
  );

  return (
    <Modal isOpen={isOpen} onClose={onClose} maxWidth="5xl" className="p-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">
          {t('postDialog.title')}
        </h3>
        <button
          onClick={onClose}
          className="text-gray-400 hover:text-gray-500 dark:hover:text-gray-300"
        >
          <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div className="text-sm text-gray-500 dark:text-gray-400 mb-4">
        {isInvestmentKind ? (
          <>
{t('postDialog.descriptionInvestment', { action: investmentAction || 'investment', security: scheduledTransaction.investmentSecurity?.symbol || scheduledTransaction.investmentSecurity?.name || '', account: scheduledTransaction.account?.name || '' })}
          </>
        ) : scheduledTransaction.isTransfer ? (
          <>
{t('postDialog.descriptionTransfer', { name: scheduledTransaction.name, sourceAccount: scheduledTransaction.account?.name || '', targetAccount: scheduledTransaction.transferAccount?.name || '' })}
          </>
        ) : (
          <>
{t('postDialog.descriptionRegular', { name: scheduledTransaction.name, account: scheduledTransaction.account?.name || '' })}
          </>
        )}
      </div>

      {/* Account balance info */}
      {projectedBalances && sourceAccount && projectedBalances.sourceBefore != null && (
        <div className="bg-gray-50 dark:bg-gray-700/50 border border-gray-200 dark:border-gray-600 rounded-lg p-3 mb-4 space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span className="text-gray-600 dark:text-gray-400">{sourceAccount.name}</span>
            <span className="text-gray-500 dark:text-gray-400">
              {formatCurrency(projectedBalances.sourceBefore!, scheduledTransaction.currencyCode)}
              {' → '}
              <span className={projectedBalances.sourceAfter! < projectedBalances.sourceBefore! ? 'text-red-600 dark:text-red-400 font-medium' : 'text-green-600 dark:text-green-400 font-medium'}>
                {formatCurrency(projectedBalances.sourceAfter!, scheduledTransaction.currencyCode)}
              </span>
            </span>
          </div>
          {transferAccount && projectedBalances.transferBefore != null && (
            <div className="flex items-center justify-between text-sm">
              <span className="text-gray-600 dark:text-gray-400">{transferAccount.name}</span>
              <span className="text-gray-500 dark:text-gray-400">
                {formatCurrency(projectedBalances.transferBefore, scheduledTransaction.currencyCode)}
                {' → '}
                <span className={projectedBalances.transferAfter! > projectedBalances.transferBefore ? 'text-green-600 dark:text-green-400 font-medium' : 'text-red-600 dark:text-red-400 font-medium'}>
                  {formatCurrency(projectedBalances.transferAfter!, scheduledTransaction.currencyCode)}
                </span>
              </span>
            </div>
          )}
        </div>
      )}

      {/* Balance warning — for asset accounts: below zero; for liability accounts: over credit limit */}
      {(() => {
        if (!projectedBalances) return null;
        const sourceWarn = sourceAccount && projectedBalances.sourceAfter != null && shouldWarnBalance(sourceAccount, projectedBalances.sourceAfter);
        const transferWarn = transferAccount && projectedBalances.transferAfter != null && shouldWarnBalance(transferAccount, projectedBalances.transferAfter);
        if (!sourceWarn && !transferWarn) return null;

        const conditionLabel = (account: Account) =>
          isLiabilityAccount(account)
            ? t('postDialog.balanceWarning.overCreditLimit')
            : t('postDialog.balanceWarning.belowZero');
        const bold = (chunks: ReactNode) => (
          <span className="font-medium">{chunks}</span>
        );
        const fmt = (value: number) =>
          formatCurrency(value, scheduledTransaction.currencyCode);

        return (
          <div className="bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-700 rounded-lg p-3 mb-4 flex items-start gap-2">
            <svg className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <div className="text-sm text-amber-700 dark:text-amber-300">
              {sourceWarn && transferWarn
                ? t.rich('postDialog.balanceWarning.both', {
                    b: bold,
                    fromAccount: sourceAccount!.name,
                    fromAmount: fmt(projectedBalances.sourceAfter!),
                    fromCondition: conditionLabel(sourceAccount!),
                    toAccount: transferAccount!.name,
                    toAmount: fmt(projectedBalances.transferAfter!),
                    toCondition: conditionLabel(transferAccount!),
                  })
                : sourceWarn
                  ? t.rich('postDialog.balanceWarning.single', {
                      b: bold,
                      account: sourceAccount!.name,
                      amount: fmt(projectedBalances.sourceAfter!),
                      condition: conditionLabel(sourceAccount!),
                    })
                  : t.rich('postDialog.balanceWarning.single', {
                      b: bold,
                      account: transferAccount!.name,
                      amount: fmt(projectedBalances.transferAfter!),
                      condition: conditionLabel(transferAccount!),
                    })}
            </div>
          </div>
        );
      })()}

      <div className="space-y-4">
        {/* Transaction Date */}
        <div>
          <div className="flex items-center gap-2">
            <DateInput
              label={t('postDialog.transactionDateLabel')}
              value={transactionDate}
              onDateChange={(date) => setTransactionDate(date)}
            />
            {transactionDate !== todayStr && (
              <button
                type="button"
                onClick={() => setTransactionDate(todayStr)}
                className="shrink-0 mt-6 px-3 py-2 text-sm font-medium text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/30 border border-blue-200 dark:border-blue-700 rounded-lg hover:bg-blue-100 dark:hover:bg-blue-900/50 transition-colors"
              >
                {t('postDialog.todayButton')}
              </button>
            )}
          </div>
        </div>

        {/* Investment-kind: action-specific overrides */}
        {isInvestmentKind && (
          <>
            {(isInvestmentQuantityPrice || isInvestmentQuantityOnly) && (
              <NumericInput
                label={t('postDialog.quantityLabel')}
                decimalPlaces={8}
                min={0}
                value={investmentQuantity === '' ? undefined : investmentQuantity}
                onChange={(value) =>
                  isInvestmentQuantityPrice
                    ? handleInvestmentQuantityChange(value)
                    : setInvestmentQuantity(value ?? '')
                }
              />
            )}
            {isInvestmentQuantityPrice && (
              <>
                <NumericInput
                  label={t('postDialog.pricePerShareLabel')}
                  decimalPlaces={6}
                  min={0}
                  placeholder={
                    roundedMarketPrice != null
                      ? t('postDialog.latestPlaceholder', { price: formatPrice(roundedMarketPrice) })
                      : undefined
                  }
                  value={investmentPrice === '' ? undefined : investmentPrice}
                  onChange={handleInvestmentPriceChange}
                />
                <CurrencyInput
                  label={t('postDialog.totalPriceLabel')}
                  prefix={getCurrencySymbol(scheduledTransaction.currencyCode)}
                  value={
                    typeof investmentTotalValue === 'number'
                      ? investmentTotalValue
                      : undefined
                  }
                  onChange={handleInvestmentTotalValueChange}
                />
                {scheduledTransaction.investmentSecurityId && priceHistoryEmpty && investmentPrice === '' && (
                  <p className="-mt-2 text-xs text-gray-500 dark:text-gray-400">
                    {t('postDialog.noPriceHistory')}
                  </p>
                )}
              </>
            )}
            {isInvestmentAmountOnly && (
              <CurrencyInput
                label={t('postDialog.totalAmountLabel')}
                prefix={getCurrencySymbol(scheduledTransaction.currencyCode)}
                value={typeof investmentTotalAmount === 'number' ? investmentTotalAmount : undefined}
                onChange={(value) => setInvestmentTotalAmount(value ?? '')}
                allowNegative={false}
              />
            )}
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                {t('postDialog.descriptionLabel')}
              </label>
              <Input
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={t('postDialog.descriptionPlaceholder')}
              />
            </div>
          </>
        )}

        {/* Amount — non-investment only.

            While posting a foreign-currency schedule this is the same pair of
            fields the transaction form uses: the biller's amount on the left,
            the account-currency total on the right, either one editable. Typing
            in the right-hand field derives the rate rather than just overwriting
            a number, so the posted row still reconciles.

            The copy button sits in an items-stretch row with the Amount input
            and takes its height from it (mt-6 clears the input's label); the
            conversion caption is a sibling *below* that row, so it does not
            stretch the button past the field it belongs to. */}
        {!isInvestmentKind && (
        <div>
          <div className={isForeignPosting ? 'grid grid-cols-1 md:grid-cols-2 gap-4 items-start' : ''}>
            <div className="flex items-stretch gap-2">
              <div className="flex-1 min-w-0">
                <CurrencyInput
                  label={
                    isForeignPosting
                      ? t('postDialog.fx.amountInCurrency', { currency: entryCurrency })
                      : t('postDialog.amountLabel')
                  }
                  prefix={getCurrencySymbol(
                    isForeignPosting ? entryCurrency : scheduledTransaction.currencyCode,
                  )}
                  value={isForeignPosting ? foreignAmount : amount}
                  onChange={(value) =>
                    isForeignPosting
                      ? setForeignAmount(roundToCents(value ?? 0))
                      : setAmount(value ?? 0)
                  }
                  allowSignToggle
                />
              </div>
              <button
                type="button"
                onClick={handleCopyAmount}
                title={t('postDialog.copyAmount')}
                aria-label={t('postDialog.copyAmount')}
                className="shrink-0 self-stretch mt-6 flex items-center justify-center px-3 text-gray-600 dark:text-gray-300 bg-gray-50 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-600 transition-colors"
              >
                {amountCopied ? (
                  <CheckIcon className="w-5 h-5 text-green-600 dark:text-green-400" />
                ) : (
                  <ClipboardDocumentIcon className="w-5 h-5" />
                )}
              </button>
            </div>
            {isForeignPosting && (
              <CurrencyInput
                label={t('postDialog.fx.totalInCurrency', {
                  currency: scheduledTransaction.currencyCode,
                })}
                prefix={getCurrencySymbol(scheduledTransaction.currencyCode)}
                value={foreignConversion ? foreignConversion.total : undefined}
                onChange={handleConvertedTotalChange}
                allowSignToggle
              />
            )}
          </div>
            {isForeignPosting && (
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                {foreignConversion ? (
                  <span>
                    {t('postDialog.fx.rateCaption', {
                      total: formatCurrency(
                        foreignConversion.total,
                        scheduledTransaction.currencyCode,
                      ),
                      from: entryCurrency,
                      rate: formatNumber(
                        postFxRate as number,
                        FX_RATE_DISPLAY_DECIMALS,
                      ),
                      to: scheduledTransaction.currencyCode,
                      date: transactionDate,
                    })}
                  </span>
                ) : !postFxRateLoading && !rateLookupFailed ? (
                  // Only when the server answered "none". A failed request says
                  // nothing about whether a rate exists, so it shows no preview
                  // rather than a claim it cannot support.
                  <span className="text-amber-600 dark:text-amber-400">
                    {t('postDialog.fx.noRateWarning', {
                      from: entryCurrency,
                      to: scheduledTransaction.currencyCode,
                      date: transactionDate,
                    })}
                  </span>
                ) : null}
                {foreignConversion && foreignConversion.fee !== 0 && (
                  <span>
                    {' '}
                    {t('postDialog.fx.feeCaption', {
                      percent: formatNumber(postFxFeePercent as number, 2),
                      fee: formatCurrency(
                        Math.abs(foreignConversion.fee),
                        scheduledTransaction.currencyCode,
                      ),
                    })}
                  </span>
                )}
              </p>
            )}
        </div>
        )}

        {/* Transfer indicator - shown instead of category for transfers */}
        {!isInvestmentKind && (
        scheduledTransaction.isTransfer ? (
          <div className="bg-blue-50 dark:bg-blue-900/30 border border-blue-200 dark:border-blue-700 rounded-lg p-4">
            <div className="flex items-center">
              <svg className="h-5 w-5 text-blue-500 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
              </svg>
              <span className="text-sm font-medium text-blue-700 dark:text-blue-300">
                {t('postDialog.transferSummary', {
                  from: scheduledTransaction.account?.name ?? '',
                  to: scheduledTransaction.transferAccount?.name ?? '',
                })}
              </span>
            </div>
            {/* A categorized transfer (#743) shows its category here so it is
                clear it will be applied to both legs on posting. */}
            {currentCategoryLabel && (
              <div className="mt-2 pl-7 text-sm text-blue-700 dark:text-blue-300">
                {t('postDialog.categorySummary', { category: currentCategoryLabel })}
              </div>
            )}
          </div>
        ) : (
          <>
            {/* Split toggle */}
            <label className="flex items-center gap-2 cursor-pointer w-fit">
              <ToggleSwitch
                checked={isSplit}
                onChange={(next) => {
                  setIsSplit(next);
                  if (next && splits.length < 2) {
                    setSplits(createEmptySplits(amount));
                  }
                }}
                label={t('postDialog.splitLabel')}
              />
              <span className="text-sm text-gray-700 dark:text-gray-300">
                {t('postDialog.splitLabel')}
              </span>
            </label>

            {/* Category or Splits */}
            {isSplit ? (
              <SplitEditor
                splits={splits}
                onChange={setSplits}
                categories={categories}
                accounts={accounts}
                sourceAccountId={scheduledTransaction.accountId}
                parentAccountSubType={
                  accounts.find((a) => a.id === scheduledTransaction.accountId)
                    ?.accountSubType ?? null
                }
                transactionAmount={amount}
                onTransactionAmountChange={handleAmountChange}
                currencyCode={scheduledTransaction.currencyCode}
                onCreateCategory={onCreateCategory}
              />
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    {t('postDialog.categoryLabel')}
                  </label>
                  <Combobox
                    placeholder={t('postDialog.selectCategoryPlaceholder')}
                    options={categoryOptions}
                    value={categoryId}
                    initialDisplayValue={currentCategory?.name || ''}
                    onChange={(value) => setCategoryId(value || '')}
                    onCreateNew={
                      onCreateCategory
                        ? async (name) => {
                            const created = await onCreateCategory(name);
                            if (created) setCategoryId(created.id);
                          }
                        : undefined
                    }
                    allowCustomValue={!!onCreateCategory}
                    valueIsId
                  />
                </div>
                {referenceNumberField}
              </div>
            )}
          </>
        )
        )}

        {/* Reference # — only here for split/transfer rows; regular rows show it beside the Category */}
        {!isInvestmentKind && (isSplit || scheduledTransaction.isTransfer) && referenceNumberField}

        {/* Description — full-width, multi-line; non-investment only (investment renders description in its own block) */}
        {!isInvestmentKind && (
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            {t('postDialog.descriptionLabel')}
          </label>
          <textarea
            rows={2}
            className="block w-full rounded-md border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 shadow-sm focus:border-blue-500 focus:ring-blue-500"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t('postDialog.descriptionPlaceholder')}
          />
        </div>
        )}
      </div>

      {/* Actions */}
      <div className="mt-6 flex justify-end space-x-3">
        <Button variant="outline" onClick={onClose} disabled={isLoading}>
          {tc('cancel')}
        </Button>
        <Button onClick={handlePost} isLoading={isLoading}>
          {t('postDialog.postButton')}
        </Button>
      </div>
    </Modal>
  );
}
