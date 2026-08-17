import { statusFromQifFlags } from "./qif-status.util";
import { Injectable, Logger } from "@nestjs/common";
import { Account, AccountSubType } from "../accounts/entities/account.entity";
import { Security } from "../securities/entities/security.entity";
import {
  InvestmentTransaction,
  InvestmentAction,
} from "../securities/entities/investment-transaction.entity";
import { Holding } from "../securities/entities/holding.entity";
import {
  Transaction,
  TransactionStatus,
} from "../transactions/entities/transaction.entity";
import { ImportContext, updateAccountBalance } from "./import-context";
import { roundMoney, roundToDecimals } from "../common/round.util";
import { resolveFxRateOrNull } from "../common/fx-entry.util";
import { ExchangeRateService } from "../currencies/exchange-rate.service";
import {
  applyActionToQuantity,
  acquisitionUnitCost,
  baseInvestmentAction,
  isQuantityOnlyAction,
  SHARE_MOVING_ACTIONS,
} from "../securities/investment-replay.util";

@Injectable()
export class ImportInvestmentProcessorService {
  private readonly logger = new Logger(ImportInvestmentProcessorService.name);

  constructor(private readonly exchangeRateService: ExchangeRateService) {}

  /**
   * A trade's cash effect, expressed in the CASH ACCOUNT's currency.
   *
   * `totalAmount` on an imported investment row is denominated in the security's
   * currency. It used to be written straight onto the cash transaction with
   * `exchangeRate: 1`, the row labelled with the *security's* currency, and the
   * cash account's balance moved by that raw number -- so a 1,000 USD purchase
   * settled from a CAD account took 1,000 CAD out and left a USD-labelled row
   * sitting in a CAD account. Both halves of audit P5-003, plus the silent 1:1 of
   * P5-009, in a path the audit could not execute.
   *
   * QIF and OFX carry no exchange rate, so the rate is resolved from stored
   * history. Returns `null` when the pair cannot be resolved: a cash posting that
   * cannot be denominated is worse than an absent one the user is warned about,
   * because it silently moves a real balance by the wrong number.
   */
  private async resolveCashAmountInAccountCurrency(
    amount: number,
    securityCurrencyCode: string | null,
    cashAccountCurrencyCode: string,
    transactionDate: string | Date,
  ): Promise<{ amount: number; exchangeRate: number } | null> {
    if (
      !securityCurrencyCode ||
      securityCurrencyCode === cashAccountCurrencyCode
    ) {
      return { amount: roundMoney(amount), exchangeRate: 1 };
    }

    const dateStr =
      typeof transactionDate === "string"
        ? transactionDate.substring(0, 10)
        : transactionDate.toISOString().substring(0, 10);

    const rate = await resolveFxRateOrNull(
      this.exchangeRateService,
      securityCurrencyCode,
      cashAccountCurrencyCode,
      dateStr,
    );
    if (rate === null) return null;

    const exchangeRate = rate;
    return { amount: roundMoney(amount * exchangeRate), exchangeRate };
  }

  async processTransaction(ctx: ImportContext, qifTx: any): Promise<void> {
    // XIn/XOut are cash-only transfers between the investment account and
    // another account; they carry no security data and must be handled as
    // regular linked transactions rather than investment transactions.
    // The "Cash" action with a transfer account (L[Account Name]) is also
    // a pure cash transfer and must be handled the same way; otherwise it
    // gets incorrectly mapped to an INTEREST investment transaction.
    // WithdrwX and ContribX are Quicken actions where the X suffix indicates
    // a transfer to/from another account; when a transfer account is present
    // they must be routed through the cash transfer path as well.
    const qifActionRaw = (qifTx.action || "").toLowerCase();
    if (
      qifActionRaw === "xin" ||
      qifActionRaw === "xout" ||
      (qifActionRaw === "cash" && qifTx.isTransfer && qifTx.transferAccount) ||
      ((qifActionRaw === "withdrwx" || qifActionRaw === "contribx") &&
        qifTx.isTransfer &&
        qifTx.transferAccount)
    ) {
      // WithdrwX means money leaving the account (like XOut)
      if (qifActionRaw === "withdrwx") {
        qifTx.action = "xout";
      } else if (qifActionRaw === "contribx") {
        qifTx.action = "xin";
      }
      await this.processCashTransfer(ctx, qifTx);
      return;
    }

    const actionMap: Record<string, InvestmentAction> = {
      buy: InvestmentAction.BUY,
      sell: InvestmentAction.SELL,
      div: InvestmentAction.DIVIDEND,
      intinc: InvestmentAction.INTEREST,
      // Quicken/Money distinguish the term of a capital-gain distribution and
      // whether it was reinvested; Monize carries the full vocabulary (issue
      // #1149), so nothing is collapsed. CGMid/ReinvMd have no Monize term
      // refinement and keep the base action.
      cglong: InvestmentAction.CAPITAL_GAIN_LONG,
      cgshort: InvestmentAction.CAPITAL_GAIN_SHORT,
      cgmid: InvestmentAction.CAPITAL_GAIN,
      stksplit: InvestmentAction.SPLIT,
      shrsin: InvestmentAction.TRANSFER_IN,
      shrsout: InvestmentAction.TRANSFER_OUT,
      reinvdiv: InvestmentAction.REINVEST,
      reinvint: InvestmentAction.REINVEST_INTEREST,
      reinvlg: InvestmentAction.REINVEST_CAPITAL_GAIN_LONG,
      reinvsh: InvestmentAction.REINVEST_CAPITAL_GAIN_SHORT,
      reinvmd: InvestmentAction.REINVEST,
      // Quicken-specific actions
      withdrw: InvestmentAction.SELL,
      contrib: InvestmentAction.BUY,
      margint: InvestmentAction.INTEREST,
      miscexp: InvestmentAction.INTEREST,
      miscinc: InvestmentAction.INTEREST,
      rtrncap: InvestmentAction.DIVIDEND,
      shtsell: InvestmentAction.SELL,
      cvrshrt: InvestmentAction.BUY,
      xin: InvestmentAction.TRANSFER_IN,
      xout: InvestmentAction.TRANSFER_OUT,
      cash: InvestmentAction.INTEREST,
      exercise: InvestmentAction.BUY,
      expire: InvestmentAction.REMOVE_SHARES,
      grant: InvestmentAction.ADD_SHARES,
      vest: InvestmentAction.ADD_SHARES,
      // Emitted by the CSV parser (CANONICAL_TO_QIF_ACTION in csv-parser.ts)
      // for uncosted share adjustments; not part of the QIF vocabulary.
      addshares: InvestmentAction.ADD_SHARES,
      removeshares: InvestmentAction.REMOVE_SHARES,
    };

    const qifAction = (qifTx.action || "").toLowerCase();
    const baseAction = qifAction.replace(/x$/, "");
    const action =
      actionMap[baseAction] || actionMap[qifAction] || InvestmentAction.BUY;

    // Resolve security
    let securityId = qifTx.security
      ? ctx.securityMap.get(qifTx.security) || null
      : null;

    if (!securityId && qifTx.security) {
      securityId = await this.autoCreateSecurity(ctx, qifTx.security);
    }

    // Calculate amounts
    const quantity = qifTx.quantity || 0;
    const price = qifTx.price || 0;
    const commission = qifTx.commission || 0;
    let totalAmount = qifTx.amount
      ? roundToDecimals(qifTx.amount, 2)
      : roundToDecimals(quantity * price + commission, 2);

    const base = baseInvestmentAction(action);
    if (base === InvestmentAction.BUY) {
      totalAmount = roundToDecimals(quantity * price + commission, 2);
    } else if (base === InvestmentAction.SELL) {
      // REDEEM included: a redemption's proceeds are a sale's.
      totalAmount = roundToDecimals(quantity * price - commission, 2);
    } else if (
      base === InvestmentAction.SPLIT ||
      base === InvestmentAction.ADD_SHARES ||
      base === InvestmentAction.REMOVE_SHARES
    ) {
      totalAmount = 0;
    }

    // The parsed cleared/reconciled/void state, through the same derivation
    // the regular processor uses. This path used to hard-code CLEARED on both
    // cash legs and carry nothing on the investment row, so a reconciled QIF
    // trade imported downgraded and an unreconciled one imported cleared.
    const status = statusFromQifFlags(qifTx);

    // Create investment transaction
    const investmentTx = new InvestmentTransaction();
    investmentTx.userId = ctx.userId;
    investmentTx.accountId = ctx.accountId;
    investmentTx.securityId = securityId;
    investmentTx.action = action;
    investmentTx.transactionDate = qifTx.date;
    investmentTx.quantity = quantity || null;
    investmentTx.price = price || null;
    investmentTx.commission = commission;
    investmentTx.totalAmount = totalAmount;
    investmentTx.description = qifTx.memo || qifTx.payee || null;
    investmentTx.status = status;

    await ctx.manager.save(investmentTx);

    // Handle cash transaction
    await this.processCashTransaction(
      ctx,
      investmentTx,
      action,
      quantity,
      price,
      totalAmount,
      securityId,
    );

    // Update holdings. A VOID trade moved no shares: the row is imported so
    // the record survives, but its effect is excluded exactly as the holdings
    // rebuild excludes it.
    if (status !== TransactionStatus.VOID) {
      await this.processHoldings(
        ctx,
        action,
        securityId,
        quantity,
        price,
        commission,
      );
    }

    ctx.importResult.imported++;
  }

  private async autoCreateSecurity(
    ctx: ImportContext,
    securityName: string,
  ): Promise<string> {
    const words = securityName.trim().split(/\s+/);
    let generatedSymbol = words
      .map((word) => word.charAt(0).toUpperCase())
      .join("");

    if (generatedSymbol.length < 2) {
      generatedSymbol = securityName
        .substring(0, 4)
        .toUpperCase()
        .replace(/[^A-Z]/g, "");
    }
    generatedSymbol = generatedSymbol.substring(0, 9);
    generatedSymbol = `${generatedSymbol}*`;

    let existingSecurity = await ctx.manager.findOne(Security, {
      where: { symbol: generatedSymbol, userId: ctx.userId },
    });

    if (existingSecurity && existingSecurity.name !== securityName) {
      let counter = 2;
      let uniqueSymbol = `${generatedSymbol}${counter}`;
      while (
        await ctx.manager.findOne(Security, {
          where: { symbol: uniqueSymbol, userId: ctx.userId },
        })
      ) {
        counter++;
        uniqueSymbol = `${generatedSymbol}${counter}`;
      }
      generatedSymbol = uniqueSymbol;
      existingSecurity = null;
    }

    if (existingSecurity) {
      const securityId = existingSecurity.id;
      ctx.securityMap.set(securityName, securityId);
      return securityId;
    }

    const newSecurity = new Security();
    newSecurity.userId = ctx.userId;
    newSecurity.symbol = generatedSymbol;
    newSecurity.name = securityName;
    newSecurity.securityType = null;
    newSecurity.exchange = null;
    newSecurity.currencyCode = ctx.account.currencyCode;
    newSecurity.isActive = true;
    newSecurity.skipPriceUpdates = true;
    const savedSecurity = await ctx.manager.save(newSecurity);

    ctx.importResult.securitiesCreated++;
    this.logger.log(
      `Auto-created security: ${generatedSymbol} for "${securityName}" (price updates disabled)`,
    );

    ctx.securityMap.set(securityName, savedSecurity.id);
    return savedSecurity.id;
  }

  private async processCashTransfer(
    ctx: ImportContext,
    qifTx: any,
  ): Promise<void> {
    // Determine the cash account to credit/debit.
    // For brokerage accounts with a linked cash account, cash goes there.
    let cashAccountId = ctx.accountId;
    let cashCurrencyCode = ctx.account.currencyCode;
    if (
      ctx.account.accountSubType === AccountSubType.INVESTMENT_BROKERAGE &&
      ctx.account.linkedAccountId
    ) {
      cashAccountId = ctx.account.linkedAccountId;
      ctx.affectedAccountIds.add(cashAccountId);
      const linkedAccount = await ctx.manager.findOne(Account, {
        where: { id: ctx.account.linkedAccountId },
      });
      if (linkedAccount) {
        cashCurrencyCode = linkedAccount.currencyCode;
      }
    }

    // Quicken XOut uses positive amounts even though money is leaving the
    // account.  Normalise to negative so the cash transaction correctly
    // decreases the source balance and the duplicate-detection query matches
    // the linked transaction created by the counterpart XIn entry.
    const actionLower = (qifTx.action || "").toLowerCase();
    let cashAmount = qifTx.amount || 0;
    if (actionLower === "xout" && cashAmount > 0) {
      cashAmount = -cashAmount;
    }
    // Shared derivation -- unlike the old inline ternary this honours a
    // source-flagged void, so a cancelled transfer never lands live.
    const status = statusFromQifFlags(qifTx);

    let transferAccountId: string | null =
      qifTx.isTransfer && qifTx.transferAccount
        ? (ctx.accountMap.get(qifTx.transferAccount) ?? null)
        : null;
    // Case-insensitive fallback (matches resolveTransactionTarget behavior)
    if (!transferAccountId && qifTx.isTransfer && qifTx.transferAccount) {
      const lowerName = qifTx.transferAccount.toLowerCase();
      for (const [name, id] of ctx.accountMap) {
        if (id && name.toLowerCase() === lowerName) {
          transferAccountId = id;
          break;
        }
      }
    }

    // Self-referencing transfer: when the transfer account resolves to the
    // same account as the cash account (e.g. brokerage XIn with L field
    // pointing to its own account), treat it as a simple cash deposit rather
    // than a transfer pair — otherwise we create +/- entries that net to zero.
    if (transferAccountId === cashAccountId) {
      transferAccountId = null;
    }

    // Duplicate detection using the same counting approach as the regular
    // processor: compare how many matching linked transfers already exist in
    // the DB against how many same-signature entries we have seen so far in
    // this import block, and only skip when the seen count does not exceed
    // the existing count.
    if (transferAccountId) {
      const existingCount = await ctx.manager
        .createQueryBuilder(Transaction, "t")
        .innerJoin(Transaction, "linked", "t.linked_transaction_id = linked.id")
        .where("t.user_id = :userId", { userId: ctx.userId })
        .andWhere("t.account_id = :accountId", { accountId: cashAccountId })
        .andWhere("t.is_transfer = true")
        .andWhere("t.transaction_date = :date", { date: qifTx.date })
        .andWhere("t.amount = :amount", { amount: cashAmount })
        .andWhere("linked.account_id = :linkedAccountId", {
          linkedAccountId: transferAccountId,
        })
        .getCount();

      // Always count every QIF entry with this signature, including ones where
      // existingCount is zero (i.e. a fresh import where this QIF entry itself
      // creates the first DB record). This ensures that when the next entry
      // with the same signature arrives and finds existingCount=1, seenSoFar
      // is already 1 so seenSoFar+1=2 > 1 and it is not incorrectly skipped.
      const sigKey = `xfer|${qifTx.date}|${cashAmount}|${transferAccountId}`;
      const seenSoFar = ctx.transferDupCounts.get(sigKey) || 0;
      ctx.transferDupCounts.set(sigKey, seenSoFar + 1);
      if (existingCount > 0 && seenSoFar + 1 <= existingCount) {
        ctx.importResult.skipped++;
        return;
      }
    }

    const cashTx = ctx.manager.create(Transaction, {
      userId: ctx.userId,
      accountId: cashAccountId,
      transactionDate: qifTx.date,
      amount: cashAmount,
      payeeName: qifTx.payee || null,
      description: qifTx.memo || null,
      status,
      currencyCode: cashCurrencyCode,
      isTransfer: !!transferAccountId,
    });
    const savedCashTx = await ctx.manager.save(cashTx);
    await updateAccountBalance(ctx.manager, cashAccountId, cashAmount);

    if (transferAccountId) {
      ctx.affectedAccountIds.add(transferAccountId);
      const targetAccount = await ctx.manager.findOne(Account, {
        where: { id: transferAccountId },
      });
      const targetCurrency = targetAccount?.currencyCode || cashCurrencyCode;

      // The linked leg lives in the target account, so it is denominated
      // there. `-cashAmount` labelled with the target's code posted equal
      // magnitudes across two different currencies with no conversion (the
      // P5-003 shape); convert it, or leave the cash leg standing alone
      // rather than moving the target's balance by a mislabelled number.
      const counterpart = await this.resolveCashAmountInAccountCurrency(
        -cashAmount,
        cashCurrencyCode,
        targetCurrency,
        qifTx.date,
      );
      if (counterpart === null) {
        const pair = `${cashCurrencyCode} -> ${targetCurrency}`;
        const message = `No exchange rate for ${pair}: the transfer counterpart in the target account was not created; the cash movement stands alone. Import an exchange rate for that pair and re-import, or record the counterpart manually.`;
        ctx.importResult.warnings = [
          ...(ctx.importResult.warnings ?? []),
          message,
        ];
        this.logger.warn(message);
        await ctx.manager.update(Transaction, savedCashTx.id, {
          isTransfer: false,
        });
      } else {
        const linkedTx = ctx.manager.create(Transaction, {
          userId: ctx.userId,
          accountId: transferAccountId,
          transactionDate: qifTx.date,
          amount: counterpart.amount,
          payeeName: qifTx.payee || `Transfer from ${ctx.account.name}`,
          description: qifTx.memo || null,
          status,
          currencyCode: targetCurrency,
          exchangeRate: counterpart.exchangeRate,
          isTransfer: true,
          linkedTransactionId: savedCashTx.id,
        });
        const savedLinkedTx = await ctx.manager.save(linkedTx);

        await ctx.manager.update(Transaction, savedCashTx.id, {
          linkedTransactionId: savedLinkedTx.id,
        });
        await updateAccountBalance(
          ctx.manager,
          transferAccountId,
          counterpart.amount,
        );
      }
    }

    ctx.importResult.imported++;
  }

  private async processCashTransaction(
    ctx: ImportContext,
    investmentTx: InvestmentTransaction,
    action: InvestmentAction,
    quantity: number,
    price: number,
    totalAmount: number,
    securityId: string | null,
  ): Promise<void> {
    let cashAccountId = ctx.accountId;
    let cashAccountCurrency = ctx.account.currencyCode;

    if (
      ctx.account.accountSubType === AccountSubType.INVESTMENT_BROKERAGE &&
      ctx.account.linkedAccountId
    ) {
      cashAccountId = ctx.account.linkedAccountId;
      ctx.affectedAccountIds.add(cashAccountId);
      const linkedAccount = await ctx.manager.findOne(Account, {
        where: { id: ctx.account.linkedAccountId },
      });
      if (linkedAccount) {
        cashAccountCurrency = linkedAccount.currencyCode;
      }
    }

    const cashAffectingActions = [
      InvestmentAction.BUY,
      InvestmentAction.SELL,
      InvestmentAction.DIVIDEND,
      InvestmentAction.INTEREST,
      InvestmentAction.CAPITAL_GAIN,
    ];

    // Base-normalized: REDEEM and the term'd gain distributions move cash as
    // their base does, and the reinvest refinements stay cash-free.
    if (
      !cashAffectingActions.includes(
        baseInvestmentAction(action) as InvestmentAction,
      )
    ) {
      return;
    }

    const cashAmountInSecurityCurrency =
      action === InvestmentAction.BUY ? -totalAmount : totalAmount;

    let securitySymbol = "Unknown";
    let securityCurrency: string | null = null;
    if (securityId) {
      const security = await ctx.manager.findOne(Security, {
        where: { id: securityId },
      });
      if (security) {
        securitySymbol = security.symbol;
        securityCurrency = security.currencyCode;
      }
    }

    const formatAction = (act: string) => {
      return act
        .split("_")
        .map(
          (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase(),
        )
        .join(" ");
    };
    const actionLabel = formatAction(action);

    let payeeName: string;
    if (
      baseInvestmentAction(action) === InvestmentAction.BUY ||
      baseInvestmentAction(action) === InvestmentAction.SELL
    ) {
      payeeName = `${actionLabel}: ${securitySymbol} ${quantity} @ $${price.toFixed(2)}`;
    } else if (action === InvestmentAction.INTEREST) {
      payeeName = `${actionLabel}: $${totalAmount.toFixed(2)}`;
    } else {
      payeeName = `${actionLabel}: ${securitySymbol} $${totalAmount.toFixed(2)}`;
    }

    const isCrossAccountTransfer = cashAccountId !== ctx.accountId;

    // The cash leg lives in the cash account, so it is denominated there.
    const converted = await this.resolveCashAmountInAccountCurrency(
      cashAmountInSecurityCurrency,
      securityCurrency,
      cashAccountCurrency,
      investmentTx.transactionDate,
    );
    if (converted === null) {
      const pair = `${securityCurrency} -> ${cashAccountCurrency}`;
      const message = `No exchange rate for ${pair}: the cash effect of ${actionLabel} ${securitySymbol} was not posted. Import an exchange rate for that pair and re-import, or record the cash movement manually.`;
      ctx.importResult.warnings = [
        ...(ctx.importResult.warnings ?? []),
        message,
      ];
      this.logger.warn(message);
      // The trade itself is still recorded -- quantities and cost are valid --
      // but no balance is moved by a number in the wrong currency.
      await ctx.manager.save(investmentTx);
      return;
    }
    const cashAmount = converted.amount;

    const cashTx = new Transaction();
    cashTx.userId = ctx.userId;
    cashTx.accountId = cashAccountId;
    cashTx.transactionDate = investmentTx.transactionDate;
    cashTx.amount = cashAmount;
    cashTx.currencyCode = cashAccountCurrency;
    cashTx.exchangeRate = converted.exchangeRate;
    cashTx.payeeName = payeeName;
    cashTx.payeeId = null;
    cashTx.description = investmentTx.description;
    // The cash leg is the same event as the investment row, so it carries the
    // row's own parsed status rather than a hard-coded CLEARED.
    cashTx.status = investmentTx.status ?? TransactionStatus.UNRECONCILED;
    cashTx.isTransfer = isCrossAccountTransfer;

    const savedCashTx = await ctx.manager.save(cashTx);

    // Create linked transaction on the brokerage side so the target account
    // is visible from both sides of the transfer
    if (isCrossAccountTransfer) {
      // The counterpart lives in the brokerage account, so it is denominated
      // there. `-cashAmount` is a number in the CASH account's currency;
      // labelling it with the brokerage's code wrote a row claiming EUR that
      // was actually CAD (the P5-003 shape this importer's cash leg already
      // avoids) -- convert it, or leave the cash leg standing alone rather
      // than posting a mislabelled amount.
      const counterpart = await this.resolveCashAmountInAccountCurrency(
        -cashAmount,
        cashAccountCurrency,
        ctx.account.currencyCode,
        investmentTx.transactionDate,
      );
      if (counterpart === null) {
        const pair = `${cashAccountCurrency} -> ${ctx.account.currencyCode}`;
        const message = `No exchange rate for ${pair}: the brokerage-side counterpart of ${actionLabel} ${securitySymbol} was not created; the cash movement stands alone. Import an exchange rate for that pair and re-import, or record the counterpart manually.`;
        ctx.importResult.warnings = [
          ...(ctx.importResult.warnings ?? []),
          message,
        ];
        this.logger.warn(message);
        savedCashTx.isTransfer = false;
        await ctx.manager.save(savedCashTx);
        investmentTx.transactionId = savedCashTx.id;
      } else {
        const brokerageTx = new Transaction();
        brokerageTx.userId = ctx.userId;
        brokerageTx.accountId = ctx.accountId;
        brokerageTx.transactionDate = investmentTx.transactionDate;
        brokerageTx.amount = counterpart.amount;
        brokerageTx.currencyCode = ctx.account.currencyCode;
        brokerageTx.exchangeRate = counterpart.exchangeRate;
        brokerageTx.payeeName = payeeName;
        brokerageTx.payeeId = null;
        brokerageTx.description = investmentTx.description;
        brokerageTx.status =
          investmentTx.status ?? TransactionStatus.UNRECONCILED;
        brokerageTx.isTransfer = true;
        brokerageTx.linkedTransactionId = savedCashTx.id;

        const savedBrokerageTx = await ctx.manager.save(brokerageTx);

        savedCashTx.linkedTransactionId = savedBrokerageTx.id;
        await ctx.manager.save(savedCashTx);

        investmentTx.transactionId = savedBrokerageTx.id;
      }
    } else {
      investmentTx.transactionId = savedCashTx.id;
    }

    await ctx.manager.save(investmentTx);

    await updateAccountBalance(ctx.manager, cashAccountId, cashAmount);
  }

  private async processHoldings(
    ctx: ImportContext,
    action: InvestmentAction,
    securityId: string | null,
    quantity: number,
    price: number,
    commission: number,
  ): Promise<void> {
    // ADD_SHARES and REMOVE_SHARES were missing from this list, so importing
    // either left holdings untouched: shares booked without a purchase never
    // reached the position at all. Same omission the three net-worth reducers
    // had, in a path the audit could not execute. The shared list is used so a
    // new action cannot be dropped from one surface again.
    if (!SHARE_MOVING_ACTIONS.includes(action) || !securityId || !quantity) {
      return;
    }

    const holding = await ctx.manager.findOne(Holding, {
      where: { accountId: ctx.accountId, securityId },
    });

    if (action === InvestmentAction.SPLIT) {
      // Stock split: scale quantity by the ratio and divide averageCost by
      // the same ratio so total cost basis is preserved. No-op when no
      // existing position; the imported QIF should not introduce a holding
      // out of thin air on a split.
      if (!holding || quantity <= 0) return;
      const currentQuantity = Number(holding.quantity);
      const currentAvgCost = Number(holding.averageCost || 0);
      holding.quantity = applyActionToQuantity(
        currentQuantity,
        action,
        quantity,
      );
      holding.averageCost = currentAvgCost / quantity;
      await ctx.manager.save(holding);
      return;
    }

    // Direction from the shared reducer rather than a second hand-written list,
    // which is how REMOVE_SHARES came to be treated as an acquisition here.
    const quantityChange =
      applyActionToQuantity(0, action, quantity) < 0 ? -quantity : quantity;

    // ADD_SHARES / REMOVE_SHARES move shares without supplying a cost -- every
    // other surface (isQuantityOnlyAction, adjustQuantity, computeHoldingsMap)
    // treats them as basis-free, so blending an imported ShrsIn price into
    // averageCost here wrote a basis the first rebuild silently erased.
    // Per-unit acquisition cost comes through the shared helper so the
    // commission lands in the basis exactly as a rebuild computes it -- the
    // bare price here was the FR-008 live-vs-rebuild drift on the import
    // surface.
    const unitCost = isQuantityOnlyAction(action)
      ? 0
      : acquisitionUnitCost({ quantity: quantityChange, price, commission });

    if (!holding) {
      const newHolding = new Holding();
      newHolding.accountId = ctx.accountId;
      newHolding.securityId = securityId;
      newHolding.quantity = quantityChange;
      newHolding.averageCost = quantityChange > 0 ? unitCost : 0;
      await ctx.manager.save(newHolding);
      return;
    }

    const currentQuantity = Number(holding.quantity);
    const currentAvgCost = Number(holding.averageCost || 0);
    const newQuantity = currentQuantity + quantityChange;

    if (quantityChange > 0 && unitCost > 0) {
      const totalCostBefore = currentQuantity * currentAvgCost;
      const totalCostAdded = quantityChange * unitCost;
      holding.averageCost =
        newQuantity > 0 ? (totalCostBefore + totalCostAdded) / newQuantity : 0;
    }

    holding.quantity = newQuantity;
    await ctx.manager.save(holding);
  }
}
