import { readdirSync, readFileSync } from "fs";
import { join, relative } from "path";

/**
 * INV-PAYROLL-001: a payroll deduction rule never writes the ledger
 * (docs/specs/payroll-deductions.md section 4). The module reads
 * `transactions` and `transaction_splits` for the year-to-date figure and
 * writes only its own table, so an import of a ledger writer, or a SQL write
 * against a ledger table, is the first step of a change that would let a
 * rule alter a posted transaction.
 */
const MODULE_DIR = __dirname;

/** Module specifiers, relative to `src/`, that write the ledger or a balance. */
const BANNED_IMPORTS: ReadonlyArray<{ pattern: RegExp; what: string }> = [
  {
    pattern: /transactions\/transactions\.(service|module)$/,
    what: "TransactionsService",
  },
  {
    pattern:
      /transactions\/(transaction-(split|transfer|bulk-create|bulk-update|reconciliation)\.service|remove-transaction-leg|convert-to-transfer)$/,
    what: "a transaction writer",
  },
  { pattern: /accounts\/accounts\.(service|module)$/, what: "AccountsService" },
  { pattern: /securities\/holdings\.service$/, what: "HoldingsService" },
  {
    pattern:
      /scheduled-transactions\/scheduled-transactions\.(service|module)$/,
    what: "ScheduledTransactionsService, which posts occurrences",
  },
];

const BANNED_NAMES = [
  "TransactionsService",
  "AccountsService",
  "HoldingsService",
  "ScheduledTransactionsService",
] as const;

/** A SQL write against a ledger or balance table, in a string of any kind. */
const LEDGER_WRITE =
  /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(transactions|transaction_splits|accounts|holdings|scheduled_transactions|scheduled_transaction_splits)\b/i;

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
}

function importSpecifiers(source: string): string[] {
  const stripped = stripComments(source);
  return [...stripped.matchAll(/\bfrom\s*["']([^"']+)["']/g)].map((m) => m[1]);
}

/** Production sources under this directory, specs excluded. */
function sources(): Array<[string, string]> {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".spec.ts"))
        files.push(full);
    }
  };
  walk(MODULE_DIR);
  return files
    .sort()
    .map((full) => [
      relative(MODULE_DIR, full).split("\\").join("/"),
      readFileSync(full, "utf8"),
    ]);
}

export function ledgerOffences(source: string): string[] {
  const offences: string[] = [];
  for (const specifier of importSpecifiers(source)) {
    const ban = BANNED_IMPORTS.find(({ pattern }) =>
      pattern.test(specifier.replace(/\.ts$/, "")),
    );
    if (ban) offences.push(`imports "${specifier}" (${ban.what})`);
  }
  const stripped = stripComments(source);
  for (const name of BANNED_NAMES) {
    if (new RegExp(`\\b${name}\\b`).test(stripped))
      offences.push(`names ${name}`);
  }
  if (LEDGER_WRITE.test(stripped))
    offences.push("writes a ledger table in SQL");
  return offences;
}

describe("INV-PAYROLL-001: the payroll deductions module never writes the ledger", () => {
  it("scans the files it claims to", () => {
    expect(sources().map(([name]) => name)).toEqual(
      expect.arrayContaining([
        "payroll-deductions.service.ts",
        "payroll-deductions.controller.ts",
        "payroll-deduction-cap.ts",
        "payroll-deduction-read-model.ts",
        "payroll-deduction-reset-reminder.service.ts",
      ]),
    );
  });

  it.each(sources())("%s", (_name, source) => {
    expect(ledgerOffences(source)).toEqual([]);
  });

  it("catches what it bans", () => {
    expect(
      ledgerOffences(
        'import { TransactionsService } from "../transactions/transactions.service";',
      ),
    ).toEqual([
      'imports "../transactions/transactions.service" (TransactionsService)',
      "names TransactionsService",
    ]);
    expect(
      ledgerOffences("m.query(`UPDATE transactions SET amount = 0`)"),
    ).toEqual(["writes a ledger table in SQL"]);
    expect(
      ledgerOffences("// UPDATE transactions in a comment is fine"),
    ).toEqual([]);
  });
});
