import { readFileSync } from "fs";
import { join } from "path";
import { gitListFiles } from "./repo-tree.util";
import {
  FALLBACK_DEFAULT_CURRENCY,
  preferredCurrency,
} from "./default-currency.util";

/**
 * The reporting currency a total is denominated in is one decision, so the
 * fallback behind it is one literal.
 *
 * Thirteen copies existed when the AI/MCP upcoming-bills rollup needed a
 * fourteenth (issue #1247), and they had already drifted: ten fell back to USD,
 * two to CAD, and one to CAD behind a local `DEFAULT_CURRENCY` alias -- so the
 * same user read Net Worth in USD and Portfolio and the GEM report in CAD, with
 * no conversion between them and nothing on either screen saying so. A copy is
 * not wrong on the day it is written; it drifts, and the drift is invisible until
 * somebody compares two screens.
 */
const srcRoot = join(__dirname, "..");

const sourceFiles = (): string[] =>
  gitListFiles(srcRoot)
    .filter((file) => file.endsWith(".ts"))
    .filter((file) => !file.endsWith(".spec.ts"))
    // The helper is where the literal lives.
    .filter((file) => !file.endsWith("common/default-currency.util.ts"));

/**
 * A hand-rolled fallback: any `defaultCurrency` read followed by an `||`/`??`
 * onto a quoted currency code. By shape rather than by the exact `"CAD"`, so
 * copying the pattern with a different fallback fails too -- two surfaces
 * reporting in two currencies is the same defect, louder.
 */
const HAND_ROLLED = /defaultCurrency\s*(?:\|\||\?\?)\s*["'][A-Za-z]{3}["']/;

describe("the reporting-currency fallback", () => {
  it("is written once", () => {
    const offenders = sourceFiles().filter((file) =>
      HAND_ROLLED.test(readFileSync(join(srcRoot, file), "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  it("reads a cleared preference as absent, not as a currency", () => {
    // The column is nullable AND can hold "" -- a select the user cleared. `??`
    // would hand `""` to `formatCurrency` and to every rate lookup.
    expect(preferredCurrency({ defaultCurrency: "" })).toBe(
      FALLBACK_DEFAULT_CURRENCY,
    );
    expect(preferredCurrency({ defaultCurrency: null })).toBe(
      FALLBACK_DEFAULT_CURRENCY,
    );
    expect(preferredCurrency(null)).toBe(FALLBACK_DEFAULT_CURRENCY);
    expect(preferredCurrency(undefined)).toBe(FALLBACK_DEFAULT_CURRENCY);
    expect(preferredCurrency({ defaultCurrency: "EUR" })).toBe("EUR");
  });

  it("agrees with the column default", () => {
    // The two answers cover the same question either side of one INSERT: this
    // constant answers it while the row is missing, `default_currency`'s own
    // default the moment TypeORM writes one. Disagreeing means a reader's totals
    // change currency when their preference row appears, with nothing on screen
    // saying so -- which is how Portfolio came to report CAD beside a USD Net
    // Worth for the same user.
    const entity = readFileSync(
      join(srcRoot, "users/entities/user-preference.entity.ts"),
      "utf8",
    );
    const declared = entity.match(
      /name:\s*"default_currency"[^}]*default:\s*"([A-Z]{3})"/,
    );
    expect(declared).not.toBeNull();
    expect(declared![1]).toBe(FALLBACK_DEFAULT_CURRENCY);
  });

  /**
   * Files that read `defaultCurrency` for something other than "what currency do
   * I report this total in". Each is exempt because falling back would answer a
   * question nobody asked, not because routing it was inconvenient.
   */
  const NOT_A_REPORTING_CURRENCY: Record<string, string> = {
    // Derives the user's HOME MARKET from their currency. No preference means the
    // home market is unknown; USD would assert they are American.
    "securities/securities.service.ts":
      "derives a home country, not a reporting currency",
    // The write path: it validates and stores what the user picked. A fallback
    // here would silently save a currency they did not choose.
    "users/users.service.ts": "writes the preference rather than reading it",
    // Builds the row's initial values; the column default is the fallback's
    // counterpart and the guard checks the two agree above.
    "users/user-preference-writer.ts":
      "seeds the row the fallback stands in for",
    // Reads the preference row for the NUMBER FORMAT of its generated notes
    // (issue #1316), not for a reporting currency -- that one it already gets
    // from ReportCurrencyService.getDefaultCurrency.
    "built-in-reports/monthly-comparison.service.ts":
      "reads numberFormat/language; its reporting currency comes from ReportCurrencyService",
    "built-in-reports/anomaly-reports.service.ts":
      "reads numberFormat/language; its reporting currency comes from ReportCurrencyService",
    // Puts the user's own currency (and locale) into a lookup prompt as a
    // disambiguation hint ("Hydro One" vs "Hydro-Québec"). No preference means
    // no hint; a fallback would tell the model something the user never said.
    "payees/lookup/payee-contact-lookup.service.ts":
      "a prompt hint, not a reporting currency",
  };

  it("is the currency every surface falls back to", () => {
    // Thirteen call sites, and before this helper they disagreed: ten USD, two
    // CAD, and one CAD hidden behind a local `DEFAULT_CURRENCY` alias. A
    // per-file read is correct on its own and wrong against its siblings, so the
    // check has to be one that spans them all.
    const currencyReaders = sourceFiles().filter((file) => {
      const source = readFileSync(join(srcRoot, file), "utf8");
      return (
        /getRepository\(UserPreference\)/.test(source) &&
        /defaultCurrency/.test(source)
      );
    });
    // Guard against the scan silently matching nothing -- an empty subject set
    // passes every assertion below.
    expect(currencyReaders.length).toBeGreaterThan(5);

    const notRouted = currencyReaders.filter(
      (file) =>
        !(file in NOT_A_REPORTING_CURRENCY) &&
        !/preferredCurrency|resolveUserDefaultCurrency/.test(
          readFileSync(join(srcRoot, file), "utf8"),
        ),
    );
    expect(notRouted).toEqual([]);

    // The exemption list may only shrink, and only for files that still exist.
    for (const file of Object.keys(NOT_A_REPORTING_CURRENCY)) {
      expect(sourceFiles()).toContain(file);
    }
  });

  it("has no aliased second copy", () => {
    // `const DEFAULT_CURRENCY = "CAD"` in gem-strategy.service.ts was invisible
    // to a scan for the literal beside `defaultCurrency`: the fallback and the
    // read were ten lines apart, so the shape check above could not see it and
    // the GEM report quoted CAD under a USD-reporting account.
    const aliased = sourceFiles().filter((file) =>
      /const\s+(?:DEFAULT|FALLBACK)_CURRENCY(?:_CODE)?\s*(?::\s*string\s*)?=\s*["'][A-Za-z]{3}["']/.test(
        readFileSync(join(srcRoot, file), "utf8"),
      ),
    );
    expect(aliased).toEqual([]);
  });
});
