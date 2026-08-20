/**
 * Smoke harness for the `.mny` decrypt + reader layers.
 *
 *   npm run mny:inspect -- path/to/file.mny [--password secret] [--table TRN]
 *
 * Prints what the reader can see: encryption scheme, table list with row and
 * column counts, a summary of what the table readers made of the file, what the
 * mappers make of it (accounts, transaction counts, per-account final balances,
 * warnings), and optionally the first rows of one table. Its job is to prove
 * that a real-world file -- a 200 MB Money Plus Sunset file, a Money 2001 file
 * -- decrypts, reads and maps to sane numbers before an import is attempted.
 *
 * Per-account balances and per-security holdings are the mappers' own output, so
 * they are the same numbers the verification report reconciles against. That
 * makes this the validation harness task M0.5 asked for, now complete: a
 * per-account or per-holding discrepancy can be traced against a real file
 * without importing anything.
 */
import { MnyImportError } from "./mny-errors";
import {
  cashKeyByAccountKey,
  currencyCodesByHandle,
  mapAccounts,
} from "./map/map-reference";
import { mapTransactions } from "./map/map-transactions";
import { mapSecurities, tradedSecurityHandles } from "./map/map-securities";
import { mapInvestments } from "./map/map-investments";
import {
  applyInvestmentCashSources,
  reconcileEmbeddedAccruedInterest,
  tradesByHandle,
} from "./map/investment-cash";
import { mapBills } from "./map/map-bills";
import { mapLoans } from "./map/map-loans";
import { crossCheckHoldings } from "./map/check-holdings";
import { computeExpectedBalances, todayIsoDate } from "./mny-parser.service";
import { DEFAULT_MNY_IMPORT_OPTIONS } from "./model/mny-import-options";
import { summarizeWarnings } from "./model/mny-warnings";
import { MnyDatabase, openMnyFile } from "./msisam/open-mny";
import {
  MnyTables,
  missingFields,
  missingTables,
  readMnyTables,
} from "./tables/read-mny-tables";

interface InspectOptions {
  file: string;
  password?: string;
  table?: string;
  rows: number;
}

export function parseInspectArgs(argv: readonly string[]): InspectOptions {
  const positional: string[] = [];
  let password: string | undefined;
  let table: string | undefined;
  let rows = 5;

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--password":
        password = argv[++i];
        break;
      case "--table":
        table = argv[++i];
        break;
      case "--rows":
        rows = Number(argv[++i]);
        break;
      default:
        positional.push(argv[i]);
    }
  }

  if (positional.length !== 1) {
    throw new Error(
      "usage: mny:inspect -- <file.mny> [--password <password>] [--table <NAME>] [--rows <n>]",
    );
  }
  return { file: positional[0], password, table, rows };
}

/**
 * Summarises what the table readers made of the file: the counts a preview
 * will show, plus anything this Money version could not supply.
 */
export function summarise(tables: MnyTables): string[] {
  const { reference, transactions, investments, bills } = tables;
  const baseCurrency = reference.currencies.find(
    (currency) => currency.handle === reference.defaults?.defaultCurrency,
  );
  const absentTables = missingTables(tables);
  const defaulted = missingFields(tables);

  return [
    "summary:",
    `  base currency:   ${baseCurrency ? `${baseCurrency.isoCode} (${baseCurrency.name})` : "unknown"}`,
    `  accounts:        ${reference.accounts.length}`,
    `  payees:          ${reference.payees.length}`,
    `  categories:      ${reference.categories.length}`,
    `  currencies:      ${reference.currencies.length} (${reference.exchangeRates.length} exchange rates)`,
    `  transactions:    ${transactions.transactions.length} (${transactions.splits.length} split children, ${transactions.transfers.length} transfer pairs)`,
    `  securities:      ${investments.securities.length} (${investments.prices.length} prices, ${investments.securitySplits.length} stock splits, ${investments.lots.length} lots)`,
    `  bills:           ${bills.supported ? String(bills.bills.length) : "not supported by this Money version"}`,
    `  missing tables:  ${absentTables.length > 0 ? absentTables.join(", ") : "none"}`,
    `  defaulted fields:${defaulted.length > 0 ? ` ${defaulted.join(", ")}` : " none"}`,
  ];
}

/**
 * How `TRN.amt` is signed in this file, and every column `TRN` actually has.
 *
 * Monize has no income/expense column -- the sign of `amount` *is* the
 * direction -- so if Money does not sign `amt`, every row imports as income.
 * No committed fixture contains a single banking transaction, so this cannot be
 * answered from the corpus; it has to be read off a real file. The transfer
 * split matters most: a transfer's two sides are one out and one in, so if both
 * are positive the direction is not in `amt` at all and the column list below is
 * where to look for whatever carries it.
 */
export function signSummary(tables: MnyTables, db: MnyDatabase): string[] {
  const rows = tables.transactions.transactions;
  const count = (predicate: (amount: number) => boolean): number =>
    rows.filter((row) => predicate(row.amount)).length;

  const transferHandles = new Set<number>();
  for (const transfer of tables.transactions.transfers) {
    if (transfer.from !== null) transferHandles.add(transfer.from);
    if (transfer.to !== null) transferHandles.add(transfer.to);
  }
  const transferRows = rows.filter(
    (row) => row.handle !== null && transferHandles.has(row.handle),
  );
  const transferPositive = transferRows.filter((row) => row.amount > 0).length;

  const trn = db.getTableOrNull("TRN");

  return [
    "TRN.amt signs:",
    `  positive:        ${count((amount) => amount > 0)}`,
    `  negative:        ${count((amount) => amount < 0)}`,
    `  zero:            ${count((amount) => amount === 0)}`,
    `  transfer sides:  ${transferRows.length} (${transferPositive} positive)`,
    "",
    "  Monize reads the direction from this sign alone. All-positive means the",
    "  direction is carried by some other column -- these are the ones TRN has:",
    ...(trn
      ? chunkColumns(trn.columnNames).map((line) => `    ${line}`)
      : ["    (no TRN table)"]),
  ];
}

/** Wraps a long column list so the report stays readable in a terminal. */
function chunkColumns(names: readonly string[], perLine = 8): string[] {
  const lines: string[] = [];
  for (let index = 0; index < names.length; index += perLine) {
    lines.push(names.slice(index, index + perLine).join(" "));
  }
  return lines;
}

/**
 * What the mappers make of the file: which Monize accounts it produces, how many
 * transactions land in each, and each account's final balance computed from the
 * file. These are the numbers the verification report reconciles against, so
 * running this against a real file is how a per-account discrepancy gets traced
 * before an import is ever attempted (task M0.5).
 *
 * The holdings block is the trust-builder for investments: Money's open tax lots
 * against the mapper's own action replay, per account and security. A file where
 * those two disagree is one where an action code is being read wrong, and this
 * says which security to look at.
 */
export function mappingSummary(tables: MnyTables): string[] {
  const accounts = mapAccounts(
    tables.reference,
    DEFAULT_MNY_IMPORT_OPTIONS,
    "USD",
  );
  const securities = mapSecurities({
    securities: tables.investments.securities,
    currencyByHandle: currencyCodesByHandle(tables.reference),
    baseCurrency: accounts.baseCurrency,
    activeHandles: tradedSecurityHandles(
      tables.transactions.transactions,
      tables.investments.lots,
    ),
  });
  // Same order as the parser, for the same reason: the two mappers answer half
  // of "where does this trade's cash sit" each.
  const mappedInvestments = mapInvestments({
    transactions: tables.transactions,
    investments: tables.investments,
    accounts,
    securities,
    bills: tables.bills.bills,
  });
  const transactions = mapTransactions({
    transactions: tables.transactions,
    accountKeyByHandle: accounts.keyByHandle,
    currencyByHandle: accounts.currencyByHandle,
    bills: tables.bills.bills,
    cashKeyByAccountKey: cashKeyByAccountKey(accounts),
    tradesByHandle: tradesByHandle(mappedInvestments),
  });
  const investments = reconcileEmbeddedAccruedInterest(
    applyInvestmentCashSources(
      mappedInvestments,
      transactions.investmentCashSources,
    ),
  );
  const holdings = crossCheckHoldings({
    transactions: investments.transactions,
    lots: tables.investments.lots,
    accounts,
    securities,
  });
  const bills = mapBills({
    bills: tables.bills,
    transactions: tables.transactions,
    investments: tables.investments,
    accounts,
    securities,
    payees: tables.reference.payees,
    asOf: todayIsoDate(),
  });
  const loans = mapLoans({ accounts, transactions, bills: bills.bills });
  const balances = computeExpectedBalances(
    accounts,
    transactions,
    todayIsoDate(),
    investments,
  );

  // `BILL.st` has never been observed in a fixture (open question 12.3): the
  // distribution over a real file is the evidence that pins its semantics.
  const statusCounts = new Map<number, number>();
  for (const row of tables.bills.bills) {
    statusCounts.set(row.status, (statusCounts.get(row.status) ?? 0) + 1);
  }

  const counts = new Map<string, number>();
  for (const transaction of transactions.transactions) {
    counts.set(
      transaction.accountKey,
      (counts.get(transaction.accountKey) ?? 0) + 1,
    );
  }
  const nameByKey = new Map(
    accounts.accounts.map((account) => [account.key, account.name]),
  );

  // The signs the *writer* would insert, which is not the same population as
  // the raw `TRN.amt` block above: that counts every row in the table, this
  // counts only the rows this import would create. A file whose raw amounts are
  // signed but whose mapped amounts are not localises the fault to the mapper.
  const signs = (values: readonly number[]): string =>
    `${values.filter((v) => v > 0).length} positive, ` +
    `${values.filter((v) => v < 0).length} negative, ` +
    `${values.filter((v) => v === 0).length} zero`;
  const mappedAmounts = transactions.transactions.map((t) => t.amount);
  const splitAmounts = transactions.transactions.flatMap((t) =>
    t.splits.map((split) => split.amount),
  );
  const investmentCash = investments.transactions.map((t) => t.cashAmount);

  return [
    "mapped import:",
    `  base currency:   ${accounts.baseCurrency}`,
    `  txn amounts:     ${signs(mappedAmounts)}`,
    `  split legs:      ${signs(splitAmounts)}`,
    `  investment cash: ${signs(investmentCash)}`,
    `  accounts:        ${accounts.accounts.length} (${accounts.skipped} skipped)`,
    `  transactions:    ${transactions.transactions.length} (${transactions.transfersLinked} transfers linked, ${transactions.skipped} skipped, ${transactions.tradeCashLegs} cash rows written by their trade, ${transactions.investmentCashSources.size} trades funded by a banking row)`,
    `  securities:      ${securities.securities.length} (${securities.skipped} skipped as currencies or unusable)`,
    `  investments:     ${investments.transactions.length} (${investments.transfersPaired} share transfers paired, ${investments.skipped} skipped)`,
    "",
    "  account                                    ccy   txns        opening          final",
    ...accounts.accounts.map((account) =>
      [
        `  ${account.name.slice(0, 40).padEnd(40)}`,
        account.currencyCode.padEnd(5),
        String(counts.get(account.key) ?? 0).padStart(5),
        account.openingBalance.toFixed(2).padStart(15),
        (balances.get(account.key) ?? 0).toFixed(2).padStart(15),
      ].join(" "),
    ),
    ...(holdings.checks.length > 0
      ? [
          "",
          "  holdings (open lots vs action replay):",
          "  account                        symbol            lots          replay  ",
          ...holdings.checks.map((check) =>
            [
              `  ${(nameByKey.get(check.accountKey) ?? check.accountKey).slice(0, 28).padEnd(28)}`,
              check.symbol.padEnd(10),
              check.lotQuantity.toFixed(4).padStart(15),
              check.replayQuantity.toFixed(4).padStart(15),
              check.matches ? "  ok" : "  MISMATCH",
            ].join(" "),
          ),
        ]
      : []),
    ...(loans.loans.length > 0
      ? [
          "",
          "  loans and mortgages (inferred terms):",
          "  account                        interest booking   payment      next due     source",
          ...loans.loans.map((loan) =>
            [
              `  ${(nameByKey.get(loan.accountKey) ?? loan.accountKey).slice(0, 28).padEnd(28)}`,
              (loan.interestBookingMode ?? "-").padEnd(18),
              (loan.paymentAmount === null
                ? "-"
                : loan.paymentAmount.toFixed(2)
              ).padStart(10),
              (loan.paymentStartDate ?? "-").padEnd(12),
              loan.sourceAccountKey === null
                ? "-"
                : (nameByKey.get(loan.sourceAccountKey) ??
                  loan.sourceAccountKey),
            ].join(" "),
          ),
        ]
      : []),
    ...(tables.bills.supported
      ? [
          "",
          `  bills: ${bills.bills.length} active candidates of ${bills.seriesInFile} series (${tables.bills.bills.length} rows, ${bills.skipped} unusable)`,
          `  BILL.st values seen: ${
            [...statusCounts]
              .sort((a, b) => a[0] - b[0])
              .map(([status, count]) => `${status} x${count}`)
              .join(", ") || "none"
          }`,
          ...bills.bills.map((bill) =>
            [
              `  ${bill.name.slice(0, 32).padEnd(32)}`,
              (nameByKey.get(bill.accountKey) ?? bill.accountKey)
                .slice(0, 24)
                .padEnd(24),
              bill.frequency.padEnd(12),
              bill.nextDueDate,
              bill.amount.toFixed(2).padStart(12),
              `st=${bill.status}`,
            ].join(" "),
          ),
        ]
      : []),
    "",
    "  warnings:",
    ...summarizeWarnings([
      ...accounts.warnings,
      ...transactions.warnings,
      ...securities.warnings,
      ...investments.warnings,
      ...holdings.warnings,
      ...bills.warnings,
      ...loans.warnings,
    ]).map(
      (warning) =>
        `    ${warning.code.padEnd(32)} ${String(warning.count).padStart(6)}  ${warning.samples.join(", ")}`,
    ),
  ];
}

/** Formats the report as lines so the shape is testable without stdout capture. */
export function inspect(
  buffer: Buffer,
  options: Omit<InspectOptions, "file">,
): string[] {
  const started = Date.now();
  const sizeBytes = buffer.length;
  // Peak RSS against file size is the number task M4.1 wants recorded, and the
  // number the pod memory limit has to be set from. Sampling at each stage
  // boundary is enough: the allocations that matter here are whole tables, and
  // each one is materialised inside a stage rather than across them.
  const rssSamples = [process.memoryUsage().rss];
  const sample = (): void => {
    rssSamples.push(process.memoryUsage().rss);
  };

  const db = openMnyFile(buffer, options.password);
  const decryptedAt = Date.now();
  sample();

  const lines = [
    `encryption:        ${db.scheme}`,
    `password required: ${db.passwordProtected ? "yes" : "no"}`,
    `tables:            ${db.tableNames.length}`,
    "",
  ];

  for (const name of db.tableNames) {
    try {
      // Names come from the catalogue, so the table is present by definition;
      // it can still fail to read if its definition page is damaged.
      const table = db.getTableOrNull(name)!;
      lines.push(
        `  ${name.padEnd(28)} ${String(table.rowCount).padStart(8)} rows  ${table.columnNames.length} cols`,
      );
    } catch (error) {
      // One damaged table must not hide the rest of the report -- knowing
      // which table is broken is the point of running this.
      lines.push(
        `  ${name.padEnd(28)} unreadable: ${(error as Error).message}`,
      );
    }
  }

  let readAt = decryptedAt;
  let mappedAt = decryptedAt;
  try {
    const tables = readMnyTables(db);
    readAt = Date.now();
    sample();
    lines.push(
      "",
      ...summarise(tables),
      "",
      ...signSummary(tables, db),
      "",
      ...mappingSummary(tables),
    );
    mappedAt = Date.now();
    sample();
  } catch (error) {
    // A damaged table stops the readers but not the report: the table list
    // above is what tells you which one to look at.
    lines.push("", `summary unavailable: ${(error as Error).message}`);
  }

  if (options.table) {
    const table = db.getTableOrNull(options.table);
    lines.push("", `first rows of ${options.table}:`);
    if (!table) {
      lines.push("  (table not present in this Money version)");
    } else {
      for (const row of table.rows().slice(0, options.rows)) {
        lines.push(`  ${JSON.stringify(row)}`);
      }
    }
  }

  const peakRss = Math.max(...rssSamples);
  const mib = (bytes: number): string => (bytes / (1024 * 1024)).toFixed(1);
  lines.push(
    "",
    "performance:",
    `  file size          ${mib(sizeBytes)} MiB`,
    `  decrypt + open     ${decryptedAt - started} ms`,
    `  read tables        ${readAt - decryptedAt} ms`,
    `  map                ${mappedAt - readAt} ms`,
    `  peak rss           ${mib(peakRss)} MiB (${(peakRss / Math.max(sizeBytes, 1)).toFixed(1)}x file size)`,
    "",
    `read in ${Date.now() - started} ms`,
  );
  return lines;
}

/* istanbul ignore next -- CLI entry point, exercised by hand against real files */
async function main(): Promise<void> {
  const { readFile } = await import("fs/promises");
  const options = parseInspectArgs(process.argv.slice(2));
  const buffer = await readFile(options.file);

  try {
    for (const line of inspect(buffer, options)) {
      process.stdout.write(`${line}\n`);
    }
  } catch (error) {
    if (error instanceof MnyImportError) {
      process.stderr.write(`${error.code}: ${error.message}\n`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}

/* istanbul ignore next -- only runs when invoked as a script */
if (require.main === module) {
  void main();
}
