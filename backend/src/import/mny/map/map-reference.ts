import {
  AccountSubType,
  AccountType,
} from "../../../accounts/entities/account.entity";
import {
  brokerageSuffix,
  cashSuffix,
} from "../../../accounts/account-name.util";
import { MnyAccount, MnyCategory, MnyPayee } from "../model/mny-rows";
import {
  MappedAccount,
  MappedAccounts,
  MappedCategories,
  MappedCategory,
  MappedPayee,
  MappedPayees,
} from "../model/mny-import-model";
import {
  MNY_ACCOUNT_TYPE,
  isIncomeCategoryType,
  mapAccountType,
} from "../model/mny-model";
import {
  MnyImportOptions,
  accountSelection,
} from "../model/mny-import-options";
import { MnyWarning } from "../model/mny-warnings";
import { MnyReferenceData } from "../tables/read-reference";

/**
 * Money's reference tables (`CRNC`, `ACCT`, `CAT`, `PAY`) mapped onto Monize
 * entities. Pure functions over typed rows: nothing here touches the database,
 * and every judgement call that could lose data produces a warning.
 *
 * Three rules in here exist because of specific PR #192 defects:
 *   - only `fClosed` closes an account (a `'z '` name prefix is one user's
 *     filing convention, not a Money semantic);
 *   - the base currency comes from the file, never from a hardcoded literal;
 *   - degenerate payees (`#`, `*`) are Money's own junk rows and never import.
 */

/** Money names its degenerate payee rows with punctuation, or nothing at all. */
const DEGENERATE_PAYEE = /^[#*.\-_\s]*$/;

/** Money's two category roots, which are structure rather than categories. */
const CATEGORY_ROOT_LEVEL = 0;
const INCOME_ROOT_NAME = "INCOME";

// ---------------------------------------------------------------------------
// Currencies
// ---------------------------------------------------------------------------

/** `CRNC.hcrnc` -> ISO code, for every row carrying a usable code. */
export function currencyCodesByHandle(
  reference: MnyReferenceData,
): ReadonlyMap<number, string> {
  return new Map(
    reference.currencies
      .filter(
        (currency) =>
          currency.handle !== null && /^[A-Za-z]{3}$/.test(currency.isoCode),
      )
      .map((currency) => [
        currency.handle as number,
        currency.isoCode.toUpperCase(),
      ]),
  );
}

/**
 * The file's own base currency (`DHD.hcrncDef`), falling back to the user's
 * preference. PR #192 hardcoded the author's locale here, which silently
 * relabelled every amount for everyone else.
 */
export function resolveBaseCurrency(
  reference: MnyReferenceData,
  userDefaultCurrency: string,
): string {
  const byHandle = currencyCodesByHandle(reference);
  const fileDefault =
    reference.defaults?.defaultCurrency !== null &&
    reference.defaults?.defaultCurrency !== undefined
      ? byHandle.get(reference.defaults.defaultCurrency)
      : undefined;
  return fileDefault ?? userDefaultCurrency.toUpperCase();
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

/**
 * Makes a name unique within the import by appending ` (2)`, ` (3)`, ...
 * Comparison is case-insensitive because Monize's own uniqueness checks are.
 */
function uniqueName(name: string, taken: Set<string>): string {
  const base = name === "" ? "Account" : name;
  if (!taken.has(base.toLowerCase())) {
    taken.add(base.toLowerCase());
    return base;
  }
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base} (${suffix})`;
    if (!taken.has(candidate.toLowerCase())) {
      taken.add(candidate.toLowerCase());
      return candidate;
    }
  }
}

/**
 * Handles of the cash accounts that belong to an investment account.
 *
 * Money models an investment account as an `at = 5` row plus an ordinary cash
 * account, cross-referenced through `hacctRel` (confirmed in `money2002.mny`:
 * `hacct` 2 is `at = 5` with `hacctRel` 3, and `hacct` 3 is the `at = 0` row
 * "None Investment (Cash)" pointing back). That is exactly Monize's
 * INVESTMENT_CASH + INVESTMENT_BROKERAGE pair, so the companion must not also
 * become a standalone chequing account.
 */
function investmentCompanionHandles(
  accounts: readonly MnyAccount[],
): ReadonlySet<number> {
  const byHandle = new Map(
    accounts
      .filter((account) => account.handle !== null)
      .map((account) => [account.handle as number, account]),
  );

  return new Set(
    accounts
      .filter((account) => account.type === MNY_ACCOUNT_TYPE.INVESTMENT)
      .map((account) => account.relatedAccount)
      .filter((handle): handle is number => {
        if (handle === null) {
          return false;
        }
        const companion = byHandle.get(handle);
        return (
          companion !== undefined &&
          companion.type !== MNY_ACCOUNT_TYPE.INVESTMENT
        );
      }),
  );
}

interface AccountContext {
  readonly currencyByHandle: ReadonlyMap<number, string>;
  readonly baseCurrency: string;
  readonly warnings: MnyWarning[];
  readonly takenNames: Set<string>;
}

function accountCurrency(
  account: MnyAccount,
  context: AccountContext,
  override: string | null,
): string {
  if (override) {
    return override.toUpperCase();
  }
  if (account.currency === null) {
    return context.baseCurrency;
  }
  const code = context.currencyByHandle.get(account.currency);
  if (!code) {
    context.warnings.push({
      code: "unknownCurrency",
      subject: account.name,
      detail: `hcrnc=${account.currency}`,
    });
    return context.baseCurrency;
  }
  return code;
}

/** Money records a limit on every account; only credit lines have a real one. */
function creditLimitFor(
  accountType: AccountType,
  limit: number,
): number | null {
  const usesLimit =
    accountType === AccountType.CREDIT_CARD ||
    accountType === AccountType.LINE_OF_CREDIT;
  return usesLimit && limit > 0 ? limit : null;
}

/** The Monize pair for one Money investment account and its cash companion. */
function mapInvestmentPair(
  account: MnyAccount,
  companion: MnyAccount | null,
  context: AccountContext,
  currencyOverride: string | null,
): MappedAccount[] {
  const handle = account.handle as number;
  const currencyCode = accountCurrency(account, context, currencyOverride);
  const base = account.name.trim();
  const cashKey = companion?.handle
    ? `acct-${companion.handle}`
    : `acct-${handle}-cash`;
  const brokerageKey = `acct-${handle}`;
  // Money keeps the cash balance on the companion; Monize does the same, and
  // the brokerage side's value comes entirely from its holdings.
  const openingBalance = companion
    ? companion.openingBalance
    : account.openingBalance;
  const closed = account.closed || (companion?.closed ?? false);
  const closedDate = account.closedOn ?? companion?.closedOn ?? null;

  const shared = {
    accountType: AccountType.INVESTMENT,
    currencyCode,
    creditLimit: null,
    closed,
    closedDate,
    favourite: account.favourite || (companion?.favourite ?? false),
    // A watch account holds no money on either side, so the pair is one
    // net-worth decision: both halves are excluded together.
    excludeFromNetWorth: account.watch || (companion?.watch ?? false),
    description: account.comment,
  };

  return [
    {
      ...shared,
      key: cashKey,
      handle: companion?.handle ?? null,
      name: uniqueName(`${base} - ${cashSuffix()}`, context.takenNames),
      moneyName: companion?.name ?? base,
      accountSubType: AccountSubType.INVESTMENT_CASH,
      openingBalance,
      linkedKey: brokerageKey,
    },
    {
      ...shared,
      key: brokerageKey,
      handle,
      name: uniqueName(`${base} - ${brokerageSuffix()}`, context.takenNames),
      moneyName: base,
      accountSubType: AccountSubType.INVESTMENT_BROKERAGE,
      openingBalance: 0,
      linkedKey: cashKey,
    },
  ];
}

/**
 * Maps `ACCT` onto Monize accounts, honouring the wizard's per-account include
 * and currency choices.
 *
 * Ordering matters to the caller: an investment pair's cash side comes first, so
 * a writer that saves in list order can link the pair without a second pass.
 */
export function mapAccounts(
  reference: MnyReferenceData,
  options: MnyImportOptions,
  userDefaultCurrency: string,
): MappedAccounts {
  const warnings: MnyWarning[] = [];
  const baseCurrency = resolveBaseCurrency(reference, userDefaultCurrency);
  const context: AccountContext = {
    currencyByHandle: currencyCodesByHandle(reference),
    baseCurrency,
    warnings,
    takenNames: new Set<string>(),
  };

  const companions = investmentCompanionHandles(reference.accounts);
  const byHandle = new Map(
    reference.accounts
      .filter((account) => account.handle !== null)
      .map((account) => [account.handle as number, account]),
  );

  const mapped: MappedAccount[] = [];
  let skipped = 0;

  for (const account of reference.accounts) {
    if (account.handle === null) {
      skipped += 1;
      warnings.push({ code: "unknownAccountType", subject: account.name });
      continue;
    }

    // The cash half of an investment account is created with its pair, not on
    // its own turn.
    if (companions.has(account.handle)) {
      continue;
    }

    const selection = accountSelection(options, account.handle, account.closed);
    if (!selection.include) {
      skipped += 1;
      continue;
    }

    if (account.type === MNY_ACCOUNT_TYPE.INVESTMENT) {
      const companion =
        account.relatedAccount !== null
          ? (byHandle.get(account.relatedAccount) ?? null)
          : null;
      mapped.push(
        ...mapInvestmentPair(
          account,
          companion && companions.has(companion.handle as number)
            ? companion
            : null,
          context,
          selection.currencyOverride,
        ),
      );
      continue;
    }

    const accountType = mapAccountType(account.type);
    if (accountType === null) {
      skipped += 1;
      warnings.push({
        code: "unknownAccountType",
        subject: account.name,
        detail: `at=${account.type}`,
      });
      continue;
    }

    const moneyName = account.name.trim();
    const name = uniqueName(moneyName, context.takenNames);
    if (name !== moneyName) {
      warnings.push({
        code: "duplicateAccountName",
        subject: moneyName,
        detail: name,
      });
    }

    mapped.push({
      key: `acct-${account.handle}`,
      handle: account.handle,
      name,
      moneyName,
      accountType,
      accountSubType: null,
      currencyCode: accountCurrency(
        account,
        context,
        selection.currencyOverride,
      ),
      openingBalance: account.openingBalance,
      creditLimit: creditLimitFor(accountType, account.creditLimit),
      closed: account.closed,
      closedDate: account.closedOn,
      favourite: account.favourite,
      excludeFromNetWorth: account.watch,
      description: account.comment,
      linkedKey: null,
    });
  }

  const withHandles = mapped.filter(
    (account): account is MappedAccount & { handle: number } =>
      account.handle !== null,
  );

  return {
    baseCurrency,
    currencyCodes: [
      ...new Set([baseCurrency, ...mapped.map((a) => a.currencyCode)]),
    ],
    accounts: mapped,
    keyByHandle: new Map(withHandles.map((a) => [a.handle, a.key])),
    currencyByHandle: new Map(
      withHandles.map((a) => [a.handle, a.currencyCode]),
    ),
    skipped,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

/** Ancestors of a category, root first, excluding the category itself. */
function ancestorsOf(
  category: MnyCategory,
  byHandle: ReadonlyMap<number, MnyCategory>,
): MnyCategory[] {
  const chain: MnyCategory[] = [];
  const seen = new Set<number>();
  let current = category.parent === null ? null : byHandle.get(category.parent);

  // `seen` guards against a cyclic parent chain in a damaged file, which would
  // otherwise spin here forever.
  while (current && current.handle !== null && !seen.has(current.handle)) {
    seen.add(current.handle);
    chain.unshift(current);
    current = current.parent === null ? null : byHandle.get(current.parent);
  }

  return chain;
}

/**
 * Maps `CAT` onto Monize's two-level tree.
 *
 * Money's own INCOME and EXPENSE roots are structure, not categories, so they
 * are dropped and their children become Monize's top level. A tree deeper than
 * that flattens: the level-1 ancestor stays the parent and the remaining path is
 * colon-joined into the child name, which keeps the distinction visible instead
 * of merging two subcategories into one.
 *
 * @param referenced Handles worth importing, or null to import the whole tree.
 */
export function mapCategories(
  reference: MnyReferenceData,
  referenced: ReadonlySet<number> | null,
): MappedCategories {
  const warnings: MnyWarning[] = [];
  const byHandle = new Map(
    reference.categories
      .filter((category) => category.handle !== null)
      .map((category) => [category.handle as number, category]),
  );

  const mappedByHandle = new Map<number, MappedCategory>();
  const unique = new Map<string, MappedCategory>();
  /** Money handle of the level-1 ancestor a mapped child hangs from. */
  const parentHandleByName = new Map<string, number>();
  let skipped = 0;

  // Sorted by level upstream, so a parent is always seen before its children.
  for (const category of reference.categories) {
    if (category.handle === null || category.level <= CATEGORY_ROOT_LEVEL) {
      continue;
    }
    if (referenced && !referenced.has(category.handle)) {
      skipped += 1;
      continue;
    }

    const name = category.name.trim();
    if (name === "") {
      skipped += 1;
      continue;
    }

    const ancestors = ancestorsOf(category, byHandle);
    // ancestors[0] is Money's INCOME/EXPENSE root; ancestors[1] is what Monize
    // calls the parent.
    const monizeParent = ancestors[1]?.name.trim() ?? null;
    const intermediate = ancestors
      .slice(2)
      .map((ancestor) => ancestor.name.trim())
      .filter((part) => part !== "");
    const childName = [...intermediate, name].join(":");

    if (intermediate.length > 0) {
      warnings.push({
        code: "categoryFlattened",
        subject: [monizeParent, childName].filter(Boolean).join(":"),
      });
    }

    const explicitIncome = isIncomeCategoryType(category.categoryType);
    const isIncome =
      explicitIncome ??
      (() => {
        warnings.push({
          code: "categoryTypeInferred",
          subject: name,
          detail: `lType=${category.categoryType}`,
        });
        return (
          (ancestors[0]?.name.trim().toUpperCase() ?? "") === INCOME_ROOT_NAME
        );
      })();

    const mappedCategory: MappedCategory = monizeParent
      ? {
          handle: category.handle,
          parentName: monizeParent,
          name: childName,
          fullName: `${monizeParent}:${childName}`,
          isIncome,
        }
      : {
          handle: category.handle,
          parentName: null,
          name: childName,
          fullName: childName,
          isIncome,
        };

    mappedByHandle.set(category.handle, mappedCategory);
    if (!unique.has(mappedCategory.fullName)) {
      unique.set(mappedCategory.fullName, mappedCategory);
    }
    if (monizeParent && ancestors[1]?.handle !== null) {
      parentHandleByName.set(monizeParent, ancestors[1].handle as number);
    }
  }

  // Referenced-only filtering can select a subcategory whose parent no other
  // transaction touches. Add that parent from its own `CAT` row so it is created
  // with its real income flag rather than defaulted by the writer.
  for (const [parentName, parentHandle] of parentHandleByName) {
    if (unique.has(parentName)) {
      continue;
    }
    const row = byHandle.get(parentHandle);
    unique.set(parentName, {
      handle: parentHandle,
      parentName: null,
      name: parentName,
      fullName: parentName,
      isIncome:
        (row ? isIncomeCategoryType(row.categoryType) : null) ??
        (row
          ? (ancestorsOf(row, byHandle)[0]?.name.trim().toUpperCase() ?? "") ===
            INCOME_ROOT_NAME
          : false),
    });
  }

  const all = [...unique.values()];

  return {
    // Parents first, unconditionally: the writer creates in list order and a
    // child whose parent came later would be created top-level.
    categories: [
      ...all.filter((category) => category.parentName === null),
      ...all.filter((category) => category.parentName !== null),
    ],
    byHandle: mappedByHandle,
    skipped,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Payees
// ---------------------------------------------------------------------------

/**
 * True for the rows Money keeps that are not really payees: `#`, `*`, and names
 * that are blank or pure punctuation after trimming. Always skipped, whatever
 * the referenced-only option says -- PR #192 imported them and users noticed.
 */
export function isDegeneratePayeeName(name: string): boolean {
  return DEGENERATE_PAYEE.test(name.trim());
}

/**
 * Maps `PAY` onto Monize payees.
 *
 * @param referenced Handles an imported transaction uses, or null for all rows.
 */
export function mapPayees(
  payees: readonly MnyPayee[],
  referenced: ReadonlySet<number> | null,
): MappedPayees {
  const warnings: MnyWarning[] = [];
  const nameByHandle = new Map<number, string>();
  const unique = new Map<string, MappedPayee>();
  let skipped = 0;

  for (const payee of payees) {
    if (payee.handle === null) {
      skipped += 1;
      continue;
    }
    if (isDegeneratePayeeName(payee.name)) {
      skipped += 1;
      warnings.push({
        code: "degeneratePayeeSkipped",
        subject: payee.name.trim() === "" ? "(blank)" : payee.name.trim(),
      });
      continue;
    }
    if (referenced && !referenced.has(payee.handle)) {
      skipped += 1;
      continue;
    }

    const name = payee.name.trim();
    nameByHandle.set(payee.handle, name);
    const key = name.toLowerCase();
    if (!unique.has(key)) {
      unique.set(key, { handle: payee.handle, name });
    }
  }

  return {
    payees: [...unique.values()],
    nameByHandle,
    skipped,
    warnings,
  };
}

/**
 * Brokerage account key -> the cash sleeve `mapAccounts` paired it with.
 *
 * Both the transaction mapper and the investment mapper need this: one to route
 * a transfer's investment side into the sleeve, the other to put a trade's cash
 * leg there. Deriving it in one place keeps the two from disagreeing about
 * where a brokerage's cash lives.
 */
export function cashKeyByAccountKey(
  accounts: MappedAccounts,
): ReadonlyMap<string, string> {
  const byKey = new Map<string, string>();
  for (const account of accounts.accounts) {
    if (
      account.accountSubType === AccountSubType.INVESTMENT_BROKERAGE &&
      account.linkedKey
    ) {
      byKey.set(account.key, account.linkedKey);
    }
  }
  return byKey;
}
