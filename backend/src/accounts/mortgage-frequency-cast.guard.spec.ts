import { readFileSync } from "fs";
import { join } from "path";
import {
  findRepoRoot,
  gitListFiles,
  requireRepoRoot,
} from "../common/repo-tree.util";
import {
  periodsPerYearForStoredFrequency,
  toMortgagePaymentFrequency,
} from "./payment-frequency.util";

/**
 * `accounts.payment_frequency` is a bare `VARCHAR(20)` that two paths write in
 * two spellings: the mortgage form stores the mortgage enum's `SEMI_MONTHLY`,
 * the loan-payment setup dialog stores the recurrence's `SEMIMONTHLY`. A caller
 * reading it back holds a string, and casting that string into
 * `MortgagePaymentFrequency` compiles while handing `getMortgagePeriodsPerYear`
 * a value it has no case for -- its `default: 12` then turned SEMIMONTHLY into a
 * monthly rate.
 *
 * Six call sites did it. Every one of them books money: the per-posting P/I
 * split, the rate-change recalculation and its scheduled-transaction sync, the
 * inference warning, and the account service's own split -- so a semi-monthly
 * mortgage was charged twice the correct interest on every payment for the life
 * of the loan, a quarterly one three times.
 *
 * Fixing five of six is what happened the first time (the setup service was
 * converted and the rest were not), which is why this is a scan rather than a
 * paragraph: `periodsPerYearForStoredFrequency` answers the count for a string
 * in either domain, `toMortgagePaymentFrequency` converts when a mortgage-domain
 * value is genuinely needed, and the cast has nowhere left to be correct.
 */
const CAST = /\bas\s+MortgagePaymentFrequency\b/;

/** `... as PaymentFrequency` is the loan-domain twin of the same mistake. */
const LOAN_CAST = /\bas\s+PaymentFrequency\b/;

/**
 * Files allowed to spell the loan-domain cast, with the reason.
 *
 * Each holds a value validated against `PAYMENT_FREQUENCIES` by class-validator
 * on the way in -- a DTO field the pipe has already narrowed -- so the cast
 * restates a fact the request boundary established. The mortgage-domain list is
 * deliberately EMPTY: every mortgage DTO field is already declared as
 * `MortgagePaymentFrequency`, so a cast there is either a no-op or a lie.
 */
const LOAN_CAST_ALLOWLIST = new Map([
  [
    "src/accounts/accounts.controller.ts",
    "LoanPreviewDto.paymentFrequency, validated by @IsIn(PAYMENT_FREQUENCIES)",
  ],
  [
    "src/accounts/loan-payment-setup.service.ts",
    "SetupLoanPaymentsDto.paymentFrequency, validated by @IsIn(PAYMENT_FREQUENCIES)",
  ],
  [
    "src/accounts/loan-mortgage-account.service.ts",
    "CreateAccountDto.paymentFrequency, validated by @IsIn(PAYMENT_FREQUENCIES)",
  ],
  [
    "src/scheduled-transactions/scheduled-transaction-loan.service.ts",
    "the loan account's cadence falling back to the schedule's own, used only " +
      "for labels; the periodic rate goes through periodsPerYearForStoredFrequency",
  ],
]);

/**
 * Every tracked production source under `backend/src`, as repo-relative paths
 * so an allowlist entry reads the way a reviewer would write it.
 *
 * Staged-but-uncommitted files are included (`--cached --others
 * --exclude-standard`), because a guard that walks the tree with `git ls-files`
 * cannot otherwise see a brand-new file -- green before `git add` and red in CI
 * on the same content.
 */
function productionSources(): [string, string][] {
  const root = requireRepoRoot(findRepoRoot(__dirname));
  return gitListFiles(root, "--cached --others --exclude-standard")
    .filter((path) => path.startsWith("backend/src/"))
    .filter((path) => path.endsWith(".ts") && !path.endsWith(".spec.ts"))
    .map((path) => [
      path.replace(/^backend\//, ""),
      readFileSync(join(root, path), "utf8"),
    ]);
}

describe("a stored payment frequency is converted, never cast", () => {
  it("has no `as MortgagePaymentFrequency` in src/", () => {
    const offenders = productionSources()
      .filter(([, source]) => CAST.test(source))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });

  it("keeps the loan-domain cast to request-validated values", () => {
    const offenders = productionSources()
      .filter(([, source]) => LOAN_CAST.test(source))
      .map(([path]) => path)
      .filter((path) => !LOAN_CAST_ALLOWLIST.has(path));
    expect(offenders).toEqual([]);
  });

  it("has no stale allowlist entry", () => {
    // An entry is a claim about a file: once the cast is gone the entry excuses
    // nothing and the next one added there inherits an argument nobody made.
    const casting = new Set(
      productionSources()
        .filter(([, source]) => LOAN_CAST.test(source))
        .map(([path]) => path),
    );
    expect(
      [...LOAN_CAST_ALLOWLIST.keys()].filter((p) => !casting.has(p)),
    ).toEqual([]);
  });

  it("scans a non-empty tree, so the rule cannot pass by accident", () => {
    const sources = productionSources();
    expect(sources.length).toBeGreaterThan(100);
    // And the patterns match what they claim to.
    expect(CAST.test("x as MortgagePaymentFrequency,")).toBe(true);
    expect(LOAN_CAST.test("x as PaymentFrequency)")).toBe(true);
    expect(CAST.test("toMortgagePaymentFrequency(x)")).toBe(false);
  });
});

describe("periodsPerYearForStoredFrequency answers both spellings", () => {
  it.each([
    ["WEEKLY", 52],
    ["ACCELERATED_WEEKLY", 52],
    ["BIWEEKLY", 26],
    ["ACCELERATED_BIWEEKLY", 26],
    ["SEMIMONTHLY", 24],
    ["SEMI_MONTHLY", 24],
    ["MONTHLY", 12],
    ["QUARTERLY", 4],
    ["YEARLY", 1],
  ])("%s is %i periods a year", (frequency, periods) => {
    expect(periodsPerYearForStoredFrequency(frequency)).toBe(periods);
  });

  it("answers null rather than monthly for anything else", () => {
    // The whole point: a value it does not know is UNKNOWN, so a caller decides
    // what to do about it instead of quietly amortizing at twelve a year.
    expect(periodsPerYearForStoredFrequency("DAILY")).toBeNull();
    expect(periodsPerYearForStoredFrequency("")).toBeNull();
    expect(periodsPerYearForStoredFrequency(null)).toBeNull();
    expect(periodsPerYearForStoredFrequency(undefined)).toBeNull();
  });

  it("agrees with toMortgagePaymentFrequency about what a mortgage can hold", () => {
    // The two answer different questions and must not disagree: a cadence the
    // mortgage helpers can express always has a period count, and the two the
    // helpers refuse (quarterly, yearly) still have one, because an ordinary
    // loan is amortized at it.
    for (const frequency of ["QUARTERLY", "YEARLY"]) {
      expect(toMortgagePaymentFrequency(frequency)).toBeNull();
      expect(periodsPerYearForStoredFrequency(frequency)).not.toBeNull();
    }
  });
});
