import {
  MnyAccount,
  MnyCategory,
  MnyCurrency,
  MnyExchangeRate,
  MnyFileDefaults,
  MnyPayee,
} from "../model/mny-rows";
import {
  toAmount,
  toBoolean,
  toDate,
  toHandle,
  toInteger,
  toNumber,
  toOptionalText,
  toText,
} from "../model/mny-values";
import { MnyDatabase } from "../msisam/open-mny";
import { RowSpec, TableAvailability, readTableByName } from "./table-reader";

/**
 * Readers for Money's reference tables: file defaults, currencies, exchange
 * rates, accounts, payees and categories.
 */

const FILE_DEFAULTS_SPEC: RowSpec<MnyFileDefaults> = {
  defaultCurrency: { from: "hcrncDef", as: toHandle },
  displayCurrency: { from: "hcrncCur", as: toHandle },
  localeId: { from: "lcid", as: toInteger },
};

const CURRENCY_SPEC: RowSpec<MnyCurrency> = {
  handle: { from: "hcrnc", as: toHandle },
  isoCode: { from: "szIsoCode", as: toText },
  name: { from: "szName", as: toText },
  quoteSymbol: { from: "szSymbol", as: toText },
  hidden: { from: "fHidden", as: toBoolean },
};

const EXCHANGE_RATE_SPEC: RowSpec<MnyExchangeRate> = {
  fromCurrency: { from: "hcrncFrom", as: toHandle },
  toCurrency: { from: "hcrncTo", as: toHandle },
  rate: { from: "rate", as: toNumber },
  date: { from: "dt", as: toDate },
  historical: { from: "fHist", as: toBoolean },
};

const ACCOUNT_SPEC: RowSpec<MnyAccount> = {
  handle: { from: "hacct", as: toHandle },
  type: { from: "at", as: (value) => toInteger(value, -1) },
  name: { from: "szFull", as: toText },
  relatedAccount: { from: "hacctRel", as: toHandle },
  currency: { from: "hcrnc", as: toHandle },
  openingBalance: { from: "amtOpen", as: toAmount },
  creditLimit: { from: "amtLimit", as: toAmount },
  openedOn: { from: "dtOpen", as: toDate },
  closedOn: { from: "dtClose", as: toDate },
  closed: { from: "fClosed", as: toBoolean },
  favourite: { from: "fFavorite", as: toBoolean },
  watch: { from: "fWatch", as: toBoolean },
  comment: { from: "mComment", as: toOptionalText },
};

const PAYEE_SPEC: RowSpec<MnyPayee> = {
  handle: { from: "hpay", as: toHandle },
  name: { from: "szFull", as: toText },
  hidden: { from: "fHidden", as: toBoolean },
};

const CATEGORY_SPEC: RowSpec<MnyCategory> = {
  handle: { from: "hcat", as: toHandle },
  name: { from: "szFull", as: toText },
  parent: { from: "hcatParent", as: toHandle },
  level: { from: "nLevel", as: toInteger },
  categoryType: { from: "lType", as: (value) => toInteger(value, -1) },
  taxRelated: { from: "fTax", as: toBoolean },
};

export interface MnyReferenceData {
  /** `DHD`'s single row, or null when the table is missing or empty. */
  readonly defaults: MnyFileDefaults | null;
  readonly currencies: MnyCurrency[];
  readonly exchangeRates: MnyExchangeRate[];
  readonly accounts: MnyAccount[];
  readonly payees: MnyPayee[];
  /** Sorted by `level` so a parent is always read before its children. */
  readonly categories: MnyCategory[];
  readonly availability: readonly TableAvailability[];
}

export function readReferenceData(db: MnyDatabase): MnyReferenceData {
  const defaults = readTableByName(db, "DHD", FILE_DEFAULTS_SPEC);
  const currencies = readTableByName(db, "CRNC", CURRENCY_SPEC);
  const exchangeRates = readTableByName(db, "CRNC_EXCHG", EXCHANGE_RATE_SPEC);
  const accounts = readTableByName(db, "ACCT", ACCOUNT_SPEC);
  const payees = readTableByName(db, "PAY", PAYEE_SPEC);
  const categories = readTableByName(db, "CAT", CATEGORY_SPEC);

  return {
    defaults: defaults.rows[0] ?? null,
    currencies: currencies.rows,
    exchangeRates: exchangeRates.rows,
    accounts: accounts.rows,
    payees: payees.rows,
    categories: [...categories.rows].sort((a, b) => a.level - b.level),
    availability: [
      defaults.availability,
      currencies.availability,
      exchangeRates.availability,
      accounts.availability,
      payees.availability,
      categories.availability,
    ],
  };
}
