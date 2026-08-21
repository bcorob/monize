import {
  MnyAccount,
  MnyBill,
  MnyCategory,
  MnyCurrency,
  MnyExchangeRate,
  MnyFileDefaults,
  MnyInvestmentDetail,
  MnyLot,
  MnyPayee,
  MnySecurity,
  MnySecurityPrice,
  MnySecuritySplit,
  MnyTransaction,
  MnyTransactionSplit,
  MnyTransfer,
} from "../model/mny-rows";
import { MnyBillData } from "../tables/read-bills";
import { MnyInvestmentData } from "../tables/read-investments";
import { MnyReferenceData } from "../tables/read-reference";
import { MnyTransactionData } from "../tables/read-transactions";

/**
 * Builders for the typed rows the mappers consume.
 *
 * The mappers never see Jet bytes -- that is the whole point of the layering --
 * so their fixtures are plain objects. Each builder supplies the neutral value
 * for every field (no reference, zero amount, real posting) and takes overrides,
 * so a spec states only the field it is about. Adding a field to a row type
 * therefore does not touch a single spec.
 */

export function mnyDefaults(
  overrides: Partial<MnyFileDefaults> = {},
): MnyFileDefaults {
  return {
    defaultCurrency: null,
    displayCurrency: null,
    localeId: 1033,
    ...overrides,
  };
}

export function mnyCurrency(overrides: Partial<MnyCurrency> = {}): MnyCurrency {
  return {
    handle: 1,
    isoCode: "USD",
    name: "US dollar",
    quoteSymbol: "",
    hidden: false,
    ...overrides,
  };
}

export function mnyExchangeRate(
  overrides: Partial<MnyExchangeRate> = {},
): MnyExchangeRate {
  return {
    fromCurrency: null,
    toCurrency: null,
    rate: 1,
    date: null,
    historical: true,
    ...overrides,
  };
}

export function mnyAccount(overrides: Partial<MnyAccount> = {}): MnyAccount {
  return {
    handle: 1,
    type: 0,
    name: "Chequing",
    relatedAccount: null,
    currency: null,
    openingBalance: 0,
    creditLimit: 0,
    openedOn: null,
    closedOn: null,
    closed: false,
    favourite: false,
    watch: false,
    comment: null,
    ...overrides,
  };
}

export function mnyPayee(overrides: Partial<MnyPayee> = {}): MnyPayee {
  return {
    handle: 1,
    name: "Payee",
    hidden: false,
    ...overrides,
  };
}

export function mnyCategory(overrides: Partial<MnyCategory> = {}): MnyCategory {
  return {
    handle: 1,
    name: "Category",
    parent: null,
    level: 1,
    categoryType: 0,
    taxRelated: false,
    ...overrides,
  };
}

export function mnySecurity(overrides: Partial<MnySecurity> = {}): MnySecurity {
  return {
    handle: 1,
    symbol: "VOO",
    name: "Vanguard S&P 500",
    securityType: 0,
    currency: null,
    hidden: false,
    ...overrides,
  };
}

/** A real posting: `frq` -1, no flags, unreconciled, no investment action. */
export function mnyTransaction(
  overrides: Partial<MnyTransaction> = {},
): MnyTransaction {
  return {
    handle: 1,
    account: 1,
    linkedAccount: null,
    payee: null,
    category: null,
    security: null,
    date: "2026-01-15",
    amount: 0,
    clearedStatus: 0,
    flags: 0,
    action: -1,
    frequency: -1,
    reference: null,
    memo: null,
    billSeries: null,
    ...overrides,
  };
}

export function mnySplit(
  overrides: Partial<MnyTransactionSplit> = {},
): MnyTransactionSplit {
  return {
    child: 2,
    parent: 1,
    position: 0,
    ...overrides,
  };
}

export function mnyTransfer(overrides: Partial<MnyTransfer> = {}): MnyTransfer {
  return {
    from: 1,
    to: 2,
    ...overrides,
  };
}

export function mnyBill(overrides: Partial<MnyBill> = {}): MnyBill {
  return {
    handle: 1,
    status: 0,
    frequency: 3,
    occurrencesPerUnit: 1,
    nextDue: null,
    templateTransaction: null,
    series: null,
    instance: 0,
    endsOn: null,
    maxInstances: 0,
    ...overrides,
  };
}

export function mnySecuritySplit(
  overrides: Partial<MnySecuritySplit> = {},
): MnySecuritySplit {
  return {
    handle: 1,
    sharesBefore: 1,
    sharesAfter: 2,
    recordDate: "2026-01-15",
    price: 0,
    ...overrides,
  };
}

export function mnySecurityPrice(
  overrides: Partial<MnySecurityPrice> = {},
): MnySecurityPrice {
  return {
    handle: 1,
    security: 1,
    date: "2026-01-15",
    price: 10,
    split: null,
    ...overrides,
  };
}

/** `TRN_INV` detail. `qty` is always positive, as Money stores it. */
export function mnyInvestmentDetail(
  overrides: Partial<MnyInvestmentDetail> = {},
): MnyInvestmentDetail {
  return {
    transaction: 1,
    price: 0,
    quantity: 0,
    commission: 0,
    interest: 0,
    ...overrides,
  };
}

/** A `LOT` row. `sellTransaction` null means the lot is still open. */
export function mnyLot(overrides: Partial<MnyLot> = {}): MnyLot {
  return {
    handle: 1,
    account: 1,
    security: 1,
    quantity: 0,
    buyTransaction: null,
    sellTransaction: null,
    boughtOn: null,
    soldOn: null,
    ...overrides,
  };
}

/** `MnyBillData` for a Money version that has the `BILL` table. */
export function billData(overrides: Partial<MnyBillData> = {}): MnyBillData {
  return {
    bills: [],
    supported: true,
    availability: {
      table: "BILL",
      present: true,
      rowCount: overrides.bills?.length ?? 0,
      missingFields: [],
      resolvedColumns: {},
    },
    ...overrides,
  };
}

/** `MnyReferenceData` with empty tables, ready to be filled per spec. */
export function referenceData(
  overrides: Partial<MnyReferenceData> = {},
): MnyReferenceData {
  return {
    defaults: null,
    currencies: [],
    exchangeRates: [],
    accounts: [],
    payees: [],
    categories: [],
    availability: [],
    ...overrides,
  };
}

/** `MnyTransactionData` with empty tables. */
export function transactionData(
  overrides: Partial<MnyTransactionData> = {},
): MnyTransactionData {
  return {
    transactions: [],
    splits: [],
    transfers: [],
    availability: [],
    ...overrides,
  };
}

/**
 * `MnyInvestmentData` with empty tables. `splitSecurities` defaults to the map
 * the reader would derive from whatever `prices` the spec supplies, so a spec
 * that sets up a `SEC_SPLIT` only has to state the price row that points at it.
 */
export function investmentData(
  overrides: Partial<MnyInvestmentData> = {},
): MnyInvestmentData {
  const prices = overrides.prices ?? [];
  const derived = new Map<number, number>();
  for (const price of prices) {
    if (
      price.split !== null &&
      price.security !== null &&
      !derived.has(price.split)
    ) {
      derived.set(price.split, price.security);
    }
  }

  return {
    securities: [],
    securitySplits: [],
    prices: [],
    investmentDetails: [],
    lots: [],
    splitSecurities: derived,
    availability: [],
    ...overrides,
  };
}
