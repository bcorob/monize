import { readFileSync } from "fs";
import { join } from "path";
import { gitListFiles } from "./repo-tree.util";
import {
  resolveNumberLocale,
  numberFormatterFor,
  defaultNumberT,
} from "./number-locale.util";
import { DEFAULT_LOCALE } from "../i18n/config";

/**
 * Issue #1316: a figure the server composes FOR A PERSON follows that person's
 * number locale, never the server's.
 *
 * The two `en-US` helpers in `format-currency.util.ts` were reached by six
 * production callers, and one of them was the bill-reminder email -- which takes
 * the recipient's localized translator and then rendered the amount as
 * `zl18,812.71` inside Polish copy. The helpers are not wrong; the classification
 * of their callers was.
 *
 * So this guard holds two things: the classification (below), and the behaviour
 * of the resolver every addressed surface now goes through.
 */
const srcRoot = join(__dirname, "..");

const sourceFiles = (): string[] =>
  gitListFiles(srcRoot)
    .filter((file) => file.endsWith(".ts"))
    .filter((file) => !file.endsWith(".spec.ts"));

const read = (file: string): string =>
  readFileSync(join(srcRoot, file), "utf8");

/**
 * Callers of the deterministic `en-US` helpers, each with the reason its output
 * is NOT addressed to a person. Every one of these is a documented fixed-locale
 * contract; a new caller must earn its line here or use
 * `number-locale.util.ts` instead.
 *
 * `budgets/budgets.service.ts` was on this list and should not have been. Its
 * BILL_DUE `message` looks like the same stored-English-fallback case as the
 * action-history rows -- but PAYMENTS supports `emailNotification`, so
 * `notificationImmediateTemplate` renders that exact string into an email built
 * with the recipient's translator. "Stored English fallback" is not by itself a
 * machine format: what settles it is whether anything renders the string TO A
 * PERSON, and for that one it did.
 */
const MACHINE_FORMAT_CALLERS: Record<string, string> = {
  "ai/forecast/ai-forecast.service.ts":
    "builds an LLM prompt: one stable representation, read by a model",
  "transactions/transactions.service.ts":
    "the English `description` fallback on an action-history row; the reader's client formats `amountValue`/`amountCurrency` instead",
  "transactions/transaction-transfer.service.ts":
    "same action-history English fallback, for the transfer pair",
  "transactions/transaction-conversion.service.ts":
    "same action-history English fallback, for a conversion's entry",
};

/** Where the helpers themselves live. */
const HELPER_MODULE = "common/format-currency.util.ts";

describe("the en-US money helpers", () => {
  it("are imported only by callers whose output is not addressed to a person", () => {
    // Matched on the import's NAMED BINDINGS, not on the file mentioning the
    // word: `number-locale.util.ts` imports `getDecimalPlacesForCurrency` from
    // the same module and declares its own `formatCurrency` in an interface, so
    // a whole-file grep classified the replacement as an offender.
    const IMPORTS_THE_FORMATTERS =
      /import\s*\{([^}]*)\}\s*from\s*["'][^"']*format-currency\.util["']/;
    const importers = sourceFiles().filter((file) => {
      const named = IMPORTS_THE_FORMATTERS.exec(read(file))?.[1];
      return named !== undefined && /\bformatCurrency(Amount)?\b/.test(named);
    });
    // An empty subject set passes every assertion below, so prove it is not one.
    expect(importers.length).toBeGreaterThan(2);

    const unclassified = importers.filter(
      (file) => !(file in MACHINE_FORMAT_CALLERS),
    );
    expect(unclassified).toEqual([]);
  });

  it("keeps the classification list honest", () => {
    // A stale entry silently covers a future caller in the same file.
    const files = sourceFiles();
    for (const file of Object.keys(MACHINE_FORMAT_CALLERS)) {
      // A classified file that no longer exists, or no longer imports the
      // helpers, is a stale exemption -- it would silently cover a future
      // caller in the same path.
      expect(files).toContain(file);
      expect(read(file)).toMatch(
        /import\s*\{[^}]*\bformatCurrency(Amount)?\b[^}]*\}\s*from\s*["'][^"']*format-currency\.util["']/,
      );
    }
  });

  it("hold the only hardcoded en-US formatter in src/", () => {
    // `monthly-comparison.service.ts` built its own `new Intl.NumberFormat("en-US")`
    // for generated report notes, so the notes disagreed with the screen around
    // them. A second copy is how a classification silently stops covering
    // everything.
    const offenders = sourceFiles()
      .filter((file) => file !== HELPER_MODULE)
      .filter((file) =>
        /(?:Intl\.NumberFormat)\(\s*["']en-US["']/.test(read(file)),
      );
    expect(offenders).toEqual([]);
  });

  it("still hold that formatter, so the exemption is not vacuous", () => {
    expect(read(HELPER_MODULE)).toMatch(/Intl\.NumberFormat\(\s*["']en-US["']/);
  });
});

describe("a percentage addressed to a person", () => {
  /**
   * The frontend guard bans `toFixed` beside a literal `%`; the server composes
   * copy too, and had exactly the same defect in the budget alerts and the
   * monthly-comparison notes. Without this scan the invariant was enforced on
   * one layer and merely intended on the other, which is what makes an
   * `enforced` status wrong.
   */
  const TOFIXED_PERCENT = /\.toFixed\(\s*\d+\s*\)\s*(?:\}%|\+\s*["']%["'])/;
  const PERCENT_AFTER_INTERPOLATION = /\}%/;

  /**
   * Modules whose `%`-bearing strings are read by a MACHINE, with the reason.
   * A SQL LIKE pattern (`` `%${term}%` ``) is not a percentage at all and is
   * excluded by the pattern above rather than by a listing.
   */
  const MACHINE_PERCENT: Record<string, string> = {
    "ai/query/tool-executor.service.ts":
      "tool summaries a model reads; a stable representation is the point",
    "ai/query/calculate-tool.ts":
      "a calculator tool's result shape, read by a model",
    "ai/insights/ai-insights.service.ts": "prompt aggregates a model reads",
    "securities/yahoo-finance.service.ts":
      "provider metric strings assembled for matching, never rendered",
  };

  /**
   * Modules whose `%` is a TRANSLATABLE LITERAL rather than a figure this code
   * formats -- the English source of a catalog string, whose `{{ percent }}`
   * arrives already rendered through the recipient's formatter and whose sign
   * every other locale places for itself (`12,3 %` in French). Exempt because
   * there is nothing here to route through a locale, which is a different claim
   * from {@link MACHINE_PERCENT}'s "nobody reads this but a machine": these
   * strings are read by a person, in their own language.
   *
   * The honesty check below is therefore not the same one either -- it holds
   * that the file is still a catalog and formats nothing.
   */
  const MESSAGE_CATALOGS: Record<string, string> = {
    "notifications/notification-email-messages.ts":
      "English source strings for `notificationEmailCopy`; the figure is interpolated already formatted, and `backend/src/i18n/locales/*/emails.json` carries each locale's own placement",
  };

  /**
   * Two shapes that are not a figure addressed to a person. A CSS length
   * (`width: ${pct}%`) has to stay a plain number -- CSS does not read a locale
   * -- and a log line is read by an operator, not by the account holder.
   */
  const CSS_LENGTH =
    /(width|height|left|right|top|bottom|inset|margin|padding)\s*:/i;

  /**
   * A SQL LIKE pattern is not a percentage: there `%` is the wildcard. Both
   * shapes appear -- `` `%${escapeLikePattern(x)}%` `` for a contains match and
   * `` `${escapeLikeWildcards(x)}%` `` for a prefix one -- so the tell is the
   * LIKE context rather than the leading `%`, which the prefix form does not
   * have. An earlier version excluded these with a lookahead for the closing
   * backtick instead, and that also swallowed every genuine percentage that
   * ended its template, which is the commonest shape there is.
   */
  const SQL_LIKE = /`%\$\{|\bLike\(|escapeLike/;

  /**
   * Blank the ARGUMENTS of every logger call, keeping newlines so line numbers
   * survive. A per-line test cannot do this: the loan-recalculation log builds
   * its message across seven concatenated lines and the `%` is on the second, so
   * the `logger.log(` that explains it is nowhere near the match.
   */
  function withoutLoggerCalls(source: string): string {
    const call = /(this\.)?logger\.(debug|log|warn|error|verbose)\(/g;
    let out = source;
    for (const match of [...source.matchAll(call)].reverse()) {
      let i = match.index + match[0].length - 1;
      let depth = 0;
      const start = i;
      while (i < out.length) {
        if (out[i] === "(") depth += 1;
        else if (out[i] === ")") {
          depth -= 1;
          if (depth === 0) break;
        }
        i += 1;
      }
      const body = out.slice(start, i);
      out = out.slice(0, start) + body.replace(/[^\n]/g, " ") + out.slice(i);
    }
    return out;
  }

  /** Lines carrying a `%` that is neither a CSS length nor a log message. */
  function percentLines(source: string): string[] {
    return withoutLoggerCalls(source)
      .split("\n")
      .filter(
        (line) =>
          (TOFIXED_PERCENT.test(line) ||
            PERCENT_AFTER_INTERPOLATION.test(line)) &&
          !CSS_LENGTH.test(line) &&
          !SQL_LIKE.test(line),
      );
  }

  it("does not mistake a SQL LIKE pattern for a percentage", () => {
    expect(percentLines("const p = `%${escapeLikePattern(term)}%`;")).toEqual(
      [],
    );
    expect(percentLines("name: Like(`${escapeLikeWildcards(q)}%`),")).toEqual(
      [],
    );
    // ...but a real percentage on a line with neither is still reported.
    expect(percentLines("const shown = `${pct}%`;")).toHaveLength(1);
  });

  it("blanks a logger call without moving the lines after it", () => {
    // A guard that silently stopped matching would pass every assertion below.
    const source = [
      "this.logger.log(",
      "  `rate=${x}%, ` +",
      "    `freq=${y}`,",
      ");",
      "const shown = `${pct}%`;",
    ].join("\n");
    const stripped = withoutLoggerCalls(source);
    expect(stripped.split("\n")).toHaveLength(5);
    expect(percentLines(source)).toEqual(["const shown = `${pct}%`;"]);
  });

  it("is not composed with toFixed and a literal % outside the machine set", () => {
    const offenders = sourceFiles().filter(
      (file) =>
        !(file in MACHINE_PERCENT) &&
        !(file in MESSAGE_CATALOGS) &&
        percentLines(read(file)).length > 0,
    );

    // Use `numberFormatterFor(...).formatPercent(value, decimals)`; it takes
    // percentage units and puts the symbol where the recipient's locale does.
    expect(offenders).toEqual([]);
  });

  it("keeps the machine-percent list honest", () => {
    const files = sourceFiles();
    for (const file of Object.keys(MACHINE_PERCENT)) {
      // A stale entry silently covers a future offender in the same path.
      expect(files).toContain(file);
      expect(percentLines(read(file)).length).toBeGreaterThan(0);
    }
  });

  it("keeps the catalog exemptions to files that format nothing", () => {
    const files = sourceFiles();
    for (const file of Object.keys(MESSAGE_CATALOGS)) {
      expect(files).toContain(file);
      const source = read(file);
      // Still a catalog, and still the subject of this scan.
      expect(percentLines(source).length).toBeGreaterThan(0);
      // The exemption is "there is no formatting here to route through a
      // locale". The day a formatter appears in one of these files, that stops
      // being true and the reason on the entry stops covering it.
      expect(source).not.toMatch(/\bIntl\./);
      expect(source).not.toMatch(/\.toFixed\(/);
      expect(source).not.toMatch(/\bformatCurrency|numberFormatterFor\b/);
    }
  });
});

describe("resolveNumberLocale", () => {
  it("lets an explicit numberFormat win over the UI language", () => {
    // The whole point of the preference: German grouping with an English UI.
    expect(resolveNumberLocale("de-DE", "en")).toBe("de-DE");
    // And the reverse -- an explicit en-US is a choice, not a default.
    expect(resolveNumberLocale("en-US", "pl")).toBe("en-US");
  });

  it("falls back to the UI language when numberFormat is 'browser'", () => {
    expect(resolveNumberLocale("browser", "pl")).toBe("pl");
    expect(resolveNumberLocale("browser", "pt-BR")).toBe("pt-BR");
  });

  it("falls back to the default locale where nothing resolves", () => {
    // There is no browser on the server, so "follow the browser" and the
    // pseudo-locale both land on the documented default rather than on a guess.
    expect(resolveNumberLocale("browser", "browser")).toBe(DEFAULT_LOCALE);
    expect(resolveNumberLocale("browser", "xx")).toBe(DEFAULT_LOCALE);
    expect(resolveNumberLocale("browser", null)).toBe(DEFAULT_LOCALE);
    expect(resolveNumberLocale(null, undefined)).toBe(DEFAULT_LOCALE);
    // A user row that has never been written at all.
    expect(resolveNumberLocale(undefined, undefined)).toBe(DEFAULT_LOCALE);
  });
});

describe("numberFormatterFor", () => {
  /**
   * Asserted on the separators rather than on an exact string: ICU writes the
   * Polish group separator as a narrow no-break space (U+202F) in some versions
   * and a regular no-break space (U+00A0) in others, and pinning the byte makes
   * the suite fail on a Node upgrade with nothing wrong.
   */
  const groupsWithSpace = (formatted: string) =>
    /\d[\s\u00a0\u202f]\d/.test(formatted);

  it("renders Polish money with a comma decimal and a spaced group", () => {
    const n = numberFormatterFor("pl-PL", "en");
    const formatted = n.formatCurrency(18812.71, "PLN");
    expect(formatted).toContain("18");
    expect(formatted).toContain("812,71");
    expect(groupsWithSpace(formatted)).toBe(true);
    // The symbol trails in Polish; the screenshot in issue #1316 showed it
    // leading, as `zl18,812.71`.
    expect(formatted.trimEnd().endsWith("z\u0142")).toBe(true);
  });

  it("renders the same amount in en-US convention when that is the choice", () => {
    const n = numberFormatterFor("en-US", "pl");
    expect(n.formatCurrency(18812.71, "USD")).toBe("$18,812.71");
  });

  it("uses the currency's own decimal places", () => {
    const n = numberFormatterFor("en-US", "en");
    // JPY has none, BHD has three -- the property the en-US helper already had
    // and which must survive the move.
    expect(n.formatCurrency(1234.6, "JPY")).toBe("¥1,235");
    expect(n.formatCurrency(1234.5678, "BHD")).toContain("1,234.568");
  });

  it("rounds a money midpoint away from zero", () => {
    // 159.735 is held as 159.73499... in IEEE 754; without the pre-round it
    // formats as 159.73.
    expect(
      numberFormatterFor("en-US", "en").formatCurrency(159.735, "USD"),
    ).toBe("$159.74");
  });

  it("formats a percentage in the reader's convention", () => {
    expect(numberFormatterFor("pl-PL", "en").formatPercent(12.3, 1)).toContain(
      "12,3",
    );
    expect(numberFormatterFor("en-US", "en").formatPercent(12.3, 1)).toBe(
      "12.3%",
    );
  });

  it("formats a plain count in the reader's convention", () => {
    expect(
      groupsWithSpace(numberFormatterFor("pl-PL", "en").formatNumber(12345, 0)),
    ).toBe(true);
    expect(numberFormatterFor("en-US", "en").formatNumber(12345, 0)).toBe(
      "12,345",
    );
  });

  it("falls back to a locale-formatted number for an unknown currency code", () => {
    // An unknown code is a reason to lose the symbol, never a reason to fall
    // back to en-US -- that is the defect wearing a catch block.
    const n = numberFormatterFor("pl-PL", "en");
    expect(n.formatCurrency(1234.5, "NOTACURRENCY")).toContain("1234,50");
  });

  it("falls back to the default locale for a tag Intl cannot use", () => {
    // `en_US` -- the underscore form -- makes `Intl.NumberFormat` throw
    // `RangeError`, and nothing validated `numberFormat` before this. One such
    // stored value used to take out every formatter at once: the Monthly
    // Comparison report 500'd, and the cron composing bill reminders and budget
    // alerts threw, so those emails stopped arriving with nothing saying why.
    expect(resolveNumberLocale("en_US", "pl")).toBe(DEFAULT_LOCALE);
    expect(resolveNumberLocale("browser", "pl_PL")).toBe(DEFAULT_LOCALE);
    expect(resolveNumberLocale("", "")).toBe(DEFAULT_LOCALE);
  });

  it("formats rather than throws for an unusable stored preference", () => {
    // The whole surface, not just the resolver: the first fix caught the throw
    // inside `formatCurrency` and fell back to `formatNumber`, which rebuilt
    // `Intl` from the SAME locale and threw again.
    const n = numberFormatterFor("en_US", "pl");
    expect(n.locale).toBe(DEFAULT_LOCALE);
    expect(() => n.formatCurrency(1234.5, "USD")).not.toThrow();
    expect(() => n.formatCurrencyAmount(1234.5, "USD")).not.toThrow();
    expect(() => n.formatNumber(1234.5)).not.toThrow();
    expect(() => n.formatPercent(12.3)).not.toThrow();
    expect(n.formatCurrency(1234.5, "USD")).toBe("$1,234.50");
  });

  it("keeps a well-formed but unknown tag, which Intl resolves itself", () => {
    // `zzz` does not throw -- Intl falls back to its own default. That is a
    // locale the reader asked for and the platform could not honour, which is
    // not the same thing as a value it cannot parse.
    expect(resolveNumberLocale("zzz", "en")).toBe("zzz");
  });

  it("exposes a default-locale formatter for a caller with no recipient", () => {
    expect(defaultNumberT.locale).toBe(DEFAULT_LOCALE);
  });

  it("survives being destructured", () => {
    // Email templates and the budget-alert messages call through the bundle, but
    // nothing stops a caller pulling one formatter out -- and an object method
    // would then lose its `this` and crash inside a cron-composed email.
    const { formatCurrency, formatPercent, formatNumber } = numberFormatterFor(
      "pl-PL",
      "en",
    );
    expect(() => formatCurrency(1, "PLN")).not.toThrow();
    expect(() => formatCurrency(1, "NOTACURRENCY")).not.toThrow();
    expect(() => formatPercent(1)).not.toThrow();
    expect(() => formatNumber(1)).not.toThrow();
  });
});
