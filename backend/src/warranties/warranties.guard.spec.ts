import { readdirSync, readFileSync } from "fs";
import { join, posix, relative } from "path";

/**
 * WTY-001: a warranty never writes a ledger row, a balance or a holding
 * (docs/specs/warranty-tracker.md section 5). A warranty carries a
 * purchase price for reference and links to a transaction by id; nothing in
 * `backend/src/warranties/` has any reason to reach a service that posts a
 * transaction, moves a balance or rebuilds a holding, so an import of one is
 * the first step of a change that would make a warranty move money.
 *
 * Entities stay allowed (the service reads the linked transaction and payee
 * through them), as do pure utilities such as `escapeLikePattern`.
 */
const WARRANTIES_DIR = __dirname;

/** Module paths, relative to `src/`, that write the ledger, a balance or a holding. */
const BANNED_MODULES: ReadonlyArray<{ pattern: RegExp; what: string }> = [
  {
    pattern: /^transactions\/transactions\.(service|module)$/,
    what: "TransactionsService",
  },
  {
    pattern:
      /^transactions\/(transaction-(split|transfer|bulk-create|bulk-update|reconciliation)\.service|remove-transaction-leg|convert-to-transfer)$/,
    what: "a transaction writer",
  },
  {
    pattern: /^accounts\/accounts\.(service|module)$/,
    what: "AccountsService, which writes balances",
  },
  {
    pattern: /^securities\/holdings\.service$/,
    what: "HoldingsService",
  },
  {
    pattern: /^securities\/investment-transactions\.service$/,
    what: "InvestmentTransactionsService",
  },
  {
    pattern: /^securities\/securities\.module$/,
    what: "the module that provides HoldingsService",
  },
];

/** The same writers named by class, whichever path they are reached through. */
const BANNED_NAMES = [
  "TransactionsService",
  "AccountsService",
  "HoldingsService",
  "InvestmentTransactionsService",
] as const;

/** Comments blanked, line numbers kept: this file's prose names what it bans. */
export function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
}

/**
 * Every module specifier `source` imports, re-exports, `import()`s or
 * `require()`s, resolved against `fileDir` (relative to `src/`) so `../x`,
 * `../../x` and `@/x` read the same. Package specifiers are returned as written.
 */
export function importSpecifiers(
  source: string,
  fileDir = "warranties",
): string[] {
  const stripped = stripComments(source);
  const found: string[] = [];
  for (const pattern of [
    /\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\bimport\s+["']([^"']+)["']/g,
  ]) {
    for (const match of stripped.matchAll(pattern)) found.push(match[1]);
  }
  return found.map((specifier) =>
    specifier.startsWith("./") || specifier.startsWith("../")
      ? posix.normalize(posix.join(fileDir, specifier))
      : specifier.startsWith("@/")
        ? specifier.slice("@/".length)
        : specifier,
  );
}

/** The WTY-001 offences in one source file. */
export function ledgerWriterOffences(
  source: string,
  fileDir = "warranties",
): string[] {
  const offences: string[] = [];
  for (const specifier of importSpecifiers(source, fileDir)) {
    const ban = BANNED_MODULES.find(({ pattern }) =>
      pattern.test(specifier.replace(/\.ts$/, "")),
    );
    if (ban) offences.push(`imports "${specifier}" (${ban.what})`);
  }
  const stripped = stripComments(source);
  for (const name of BANNED_NAMES) {
    if (new RegExp(`\\b${name}\\b`).test(stripped)) {
      offences.push(`names ${name}`);
    }
  }
  return offences;
}

/** Production sources under this directory, specs excluded, subdirectories included. */
function warrantySources(): Array<[string, string, string]> {
  const srcDir = join(WARRANTIES_DIR, "..");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".spec.ts"))
        files.push(full);
    }
  };
  walk(WARRANTIES_DIR);
  return files
    .sort()
    .map((full) => [
      relative(WARRANTIES_DIR, full).split("\\").join("/"),
      relative(srcDir, join(full, "..")).split("\\").join("/"),
      readFileSync(full, "utf8"),
    ]);
}

describe("WTY-001: the warranties module never reaches a ledger, balance or holding writer", () => {
  it("scans the files it claims to", () => {
    const names = warrantySources().map(([name]) => name);
    expect(names).toEqual(
      expect.arrayContaining([
        "warranties.service.ts",
        "warranties.controller.ts",
        "warranties.module.ts",
        "dto/create-warranty.dto.ts",
        "entities/warranty.entity.ts",
      ]),
    );
  });

  it("finds every warranties source clean", () => {
    const offenders = warrantySources()
      .map(
        ([name, fileDir, source]) =>
          [name, ledgerWriterOffences(source, fileDir)] as const,
      )
      .filter(([, offences]) => offences.length > 0);
    if (offenders.length > 0) {
      throw new Error(
        "WTY-001: a warranty never writes a ledger row, a balance or a holding " +
          "(docs/specs/warranty-tracker.md section 5). Read the linked " +
          "transaction through its entity instead of calling a writer:\n" +
          offenders
            .map(([name, offences]) => `  ${name}: ${offences.join("; ")}`)
            .join("\n"),
      );
    }
  });

  it("blanks comments while preserving line numbers", () => {
    const stripped = stripComments(
      'a\n// TransactionsService\n/* from "../accounts/accounts.service" */\nb',
    );
    expect(stripped.split("\n")).toHaveLength(4);
    expect(stripped).not.toContain("accounts");
    expect(stripped).not.toContain("TransactionsService");
  });

  it.each([
    [
      'import { TransactionsService } from "../transactions/transactions.service";',
    ],
    [
      'import { TransactionsModule } from "@/transactions/transactions.module";',
    ],
    [
      'import { TransactionSplitService } from "../transactions/transaction-split.service";',
    ],
    ['import { AccountsService } from "../accounts/accounts.service";'],
    ['import { HoldingsService } from "../securities/holdings.service";'],
    [
      'import { InvestmentTransactionsService } from "../securities/investment-transactions.service";',
    ],
    ['const s = await import("../transactions/transactions.service");'],
    ['const s = require("../accounts/accounts.service");'],
    ['export { x } from "../securities/holdings.service";'],
    ["constructor(private readonly holdings: HoldingsService) {}"],
  ])("trips on a planted offence: %s", (planted) => {
    // A negative control: a scan that cannot fail is not a guard.
    expect(
      ledgerWriterOffences(`${planted}\nexport const x = 1;\n`),
    ).not.toEqual([]);
  });

  it("resolves a subdirectory's imports against its own location", () => {
    expect(
      ledgerWriterOffences(
        'import { x } from "../../accounts/accounts.service";',
        "warranties/dto",
      ),
    ).not.toEqual([]);
  });

  it.each([
    [
      'import { Transaction } from "../transactions/entities/transaction.entity";',
    ],
    [
      'import { escapeLikePattern } from "../transactions/transaction-search.util";',
    ],
    ['import { Account } from "../accounts/entities/account.entity";'],
    ['import { Payee } from "../payees/entities/payee.entity";'],
    ["// TransactionsService is never imported here"],
  ])("accepts what the module may use: %s", (allowed) => {
    expect(ledgerWriterOffences(`${allowed}\nexport const x = 1;\n`)).toEqual(
      [],
    );
  });
});
