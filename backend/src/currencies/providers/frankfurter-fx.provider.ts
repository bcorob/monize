import { Logger } from "@nestjs/common";
import {
  ProviderAdmission,
  ProviderHealthService,
} from "../../provider-health/provider-health.service";
import { isCalendarDate } from "../../common/validators/is-calendar-date.validator";
import {
  FxObservation,
  FxProviderName,
  FxRateProvider,
} from "./fx-provider.interface";
import { isRecord } from "../../common/helpers/is-record";

/** The id this adapter reports under. Must match `TRACKED_PROVIDERS`. */
export const FRANKFURTER_PROVIDER = "frankfurter";

/** The public instance; `FX_FRANKFURTER_BASE_URL` points at a self-hosted one or a proxy. */
export const DEFAULT_FRANKFURTER_BASE_URL = "https://api.frankfurter.dev/v1";

/** A latest-rates or currency-list call answers in one small body. */
export const FRANKFURTER_LATEST_TIMEOUT_MS = 15_000;

/** A date range answers daily however long it is (2,560 rows for a decade), so it gets longer. */
export const FRANKFURTER_SERIES_TIMEOUT_MS = 60_000;

/** The currency list is held this long, the `max-age` the public instance serves it with. */
export const FRANKFURTER_CURRENCY_LIST_TTL_MS = 24 * 60 * 60_000;

/**
 * How long the compiled-in list stands in after the list could not be
 * fetched, before the adapter asks again. Short, so a boot during an outage
 * picks up the instance's own list minutes after it recovers; bounded, so a
 * refresh over forty currencies does not ask once per `carries` call while
 * the breaker is still counting towards opening.
 */
export const FRANKFURTER_CURRENCY_LIST_RETRY_MS = 5 * 60_000;

/**
 * The currencies the public instance carried on 2026-10-07
 * (`docs/specs/exchange-rate-providers.md`, section 6.4). The adapter
 * reads the instance's own list and uses this only when that list cannot be
 * fetched, so an outage at boot does not make it claim to carry nothing.
 */
export const FRANKFURTER_FALLBACK_CURRENCIES: readonly string[] = [
  "AUD",
  "BRL",
  "CAD",
  "CHF",
  "CNY",
  "CZK",
  "DKK",
  "EUR",
  "GBP",
  "HKD",
  "HUF",
  "IDR",
  "ILS",
  "INR",
  "ISK",
  "JPY",
  "KRW",
  "MXN",
  "MYR",
  "NOK",
  "NZD",
  "PHP",
  "PLN",
  "RON",
  "SEK",
  "SGD",
  "THB",
  "TRY",
  "USD",
  "ZAR",
];

const FALLBACK_CURRENCY_SET: ReadonlySet<string> = new Set(
  FRANKFURTER_FALLBACK_CURRENCIES,
);

/** Names the deployment to the instance operator; the project asks for nothing more. */
const USER_AGENT = "Monize (+https://github.com/kenlasko/monize)";

/**
 * The base URL the adapter calls, from `FX_FRANKFURTER_BASE_URL`: the default
 * when unset or blank, otherwise the value trimmed with any trailing slash
 * removed, so a path can be appended with one `/`. A self-hosted instance may
 * serve at a path without `/v1`; nothing here assumes the suffix.
 */
export function resolveFrankfurterBaseUrl(
  raw: string | null | undefined,
): string {
  const trimmed = (raw ?? "").trim().replace(/\/+$/, "");
  return trimmed.length > 0 ? trimmed : DEFAULT_FRANKFURTER_BASE_URL;
}

/** What one request came back with; `null` is "did not answer". */
type FrankfurterAnswer =
  { kind: "body"; body: unknown } | { kind: "not-found" } | null;

interface CachedCurrencyList {
  codes: ReadonlySet<string>;
  validUntil: number;
}

/** A published rate is a positive finite number; anything else is not an observation. */
function isUsableRate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** `{ date, rates: { Q: rate } }`, the shape of `/latest` and of a single date. */
function readLatestBody(
  body: unknown,
): { date: string; rates: Record<string, unknown> } | null {
  if (!isRecord(body)) return null;
  if (!isCalendarDate(body.date) || !isRecord(body.rates)) return null;
  return { date: body.date, rates: body.rates };
}

/** `{ rates: { date: { Q: rate } } }`, the shape of a date range. */
function readSeriesBody(body: unknown): Record<string, unknown> | null {
  if (!isRecord(body) || !isRecord(body.rates)) return null;
  return body.rates;
}

/** `{ CODE: "Name" }`; a list with nothing in it is not a list this adapter can act on. */
function readCurrencyList(body: unknown): ReadonlySet<string> | null {
  if (!isRecord(body)) return null;
  const codes = Object.keys(body).filter(
    (code) => /^[A-Z]{3}$/.test(code) && typeof body[code] === "string",
  );
  return codes.length > 0 ? new Set(codes) : null;
}

/**
 * Exchange rates from Frankfurter, the ECB reference rates: no key, no
 * request cap, daily history from 1999-01-04, about thirty currencies.
 * `docs/specs/exchange-rate-providers.md` section 6 records the
 * responses this adapter is built on.
 *
 * Three endpoints. `latest?base=B&symbols=Q1,Q2` and `{start}..{end}?base=B&
 * symbols=Q` answer `rates[Q]` as "Q per 1 B", which is `FxObservation
 * { from: B, to: Q }` with no inversion; `currencies` is the list `carries`
 * and `verifyCurrency` read, cached for a day, with the compiled-in list
 * standing in while it cannot be fetched. A range or a date on a
 * non-business day is moved back to the previous business day, including the
 * start of a range, so a series drops the observations dated before `start`.
 * A date range of any length answers daily in one response.
 *
 * Every call goes through the breaker in the shape every outbound client here
 * uses, with Google Places' two asymmetries: a non-2xx is a complete answer and
 * is recorded the moment it arrives, while a 2xx is recorded only once its body
 * has arrived; and an error the breaker does not count is not an outcome, so a
 * probe holder hands the slot back. Which status means what is the table in
 * section 6.3: a 404 is "answered, nothing" (the instance does not carry a code
 * `carries` should have screened, or the window lies wholly before its
 * history), every other non-2xx and every transport failure is "did not
 * answer" (`null`), and only the second kind moves the breaker.
 * `provider-call.guard.spec.ts` holds this shape.
 *
 * Built by `CurrenciesModule`'s factory, which reads `FX_FRANKFURTER_BASE_URL`,
 * rather than resolved by Nest: the base URL is a string, not a class.
 */
export class FrankfurterFxProvider implements FxRateProvider {
  readonly name: FxProviderName = "frankfurter";
  readonly source = "frankfurter";
  private readonly logger = new Logger(FrankfurterFxProvider.name);
  private currencyList: CachedCurrencyList | null = null;
  private currencyListInFlight: Promise<ReadonlySet<string>> | null = null;

  constructor(
    private readonly health: ProviderHealthService,
    private readonly baseUrl: string = DEFAULT_FRANKFURTER_BASE_URL,
  ) {}

  async carries(code: string): Promise<boolean> {
    const codes = await this.currencyCodes();
    return codes.has(code.toUpperCase());
  }

  /**
   * Whether the instance's own list names the code. While the compiled-in list
   * stands in, a code it names is still known, but one it does not is no
   * answer: the instance may carry it.
   */
  async verifyCurrency(code: string): Promise<boolean | null> {
    const codes = await this.currencyCodes();
    if (codes.has(code.toUpperCase())) return true;
    return codes === FALLBACK_CURRENCY_SET ? null : false;
  }

  async fetchLatest(
    base: string,
    quotes: readonly string[],
  ): Promise<ReadonlyMap<string, FxObservation> | null> {
    const found = new Map<string, FxObservation>();
    if (quotes.length === 0) return found;

    const symbols = quotes.map((quote) => quote.toUpperCase()).join(",");
    const context = `latest rates for ${base} against ${symbols}`;
    // Each code encoded on its own, so the separator stays a literal comma,
    // the form the recorded requests use.
    const symbolsParam = quotes
      .map((quote) => encodeURIComponent(quote.toUpperCase()))
      .join(",");
    const answer = await this.request(
      `latest?base=${encodeURIComponent(base.toUpperCase())}&symbols=${symbolsParam}`,
      FRANKFURTER_LATEST_TIMEOUT_MS,
      context,
    );
    if (answer === null) return null;
    if (answer.kind === "not-found") return found;

    const parsed = readLatestBody(answer.body);
    if (parsed === null) return this.unreadable(context);
    for (const quote of quotes) {
      const rate = parsed.rates[quote.toUpperCase()];
      // A symbol the instance does not carry is silently absent from `rates`:
      // answered, no rate for it, which is what an absent key means to the chain.
      if (isUsableRate(rate)) {
        found.set(quote, { from: base, to: quote, date: parsed.date, rate });
      }
    }
    return found;
  }

  async fetchDailySeries(
    from: string,
    to: string,
    start: string,
    end: string,
  ): Promise<FxObservation[] | null> {
    // The dates go into the URL path. A caller passes calendar dates
    // (`ParseCalendarDatePipe`, `enumerateDaysYMD`); anything else is a bug
    // here, not a request to send.
    if (!isCalendarDate(start) || !isCalendarDate(end)) {
      throw new Error(
        `Frankfurter daily series needs YYYY-MM-DD bounds, got "${start}" and "${end}"`,
      );
    }
    const context = `daily rates for ${from}/${to} from ${start} to ${end}`;
    const answer = await this.request(
      `${start}..${end}?base=${encodeURIComponent(from.toUpperCase())}&symbols=${encodeURIComponent(to.toUpperCase())}`,
      FRANKFURTER_SERIES_TIMEOUT_MS,
      context,
    );
    if (answer === null) return null;
    if (answer.kind === "not-found") return [];

    const rates = readSeriesBody(answer.body);
    if (rates === null) return this.unreadable(context);
    const points: FxObservation[] = [];
    for (const [date, table] of Object.entries(rates)) {
      // The instance moves a start on a non-business day back to the previous
      // one and answers from there; that observation is outside the window
      // the caller asked for, and keeping it would hand the chain a day it
      // did not ask about.
      if (!isCalendarDate(date) || date < start || date > end) continue;
      const rate = isRecord(table) ? table[to.toUpperCase()] : undefined;
      if (isUsableRate(rate)) points.push({ from, to, date, rate });
    }
    return points.sort((a, b) => a.date.localeCompare(b.date));
  }

  /**
   * The instance's own currency list, fetched once and held for a day; while
   * it cannot be fetched, the compiled-in list, held for a few minutes.
   * Concurrent callers share one fetch, so a refresh's first forty `carries`
   * calls are one request, not forty.
   */
  private async currencyCodes(): Promise<ReadonlySet<string>> {
    const cached = this.currencyList;
    if (cached !== null && Date.now() < cached.validUntil) return cached.codes;
    if (this.currencyListInFlight === null) {
      this.currencyListInFlight = this.loadCurrencyList().finally(() => {
        this.currencyListInFlight = null;
      });
    }
    return this.currencyListInFlight;
  }

  private async loadCurrencyList(): Promise<ReadonlySet<string>> {
    const context = "the list of currencies Frankfurter carries";
    const answer = await this.request(
      "currencies",
      FRANKFURTER_LATEST_TIMEOUT_MS,
      context,
    );
    const codes =
      answer?.kind === "body" ? readCurrencyList(answer.body) : null;
    if (codes === null) {
      if (answer?.kind === "body") this.unreadable(context);
      this.logger.warn(
        `The compiled-in list of ${FRANKFURTER_FALLBACK_CURRENCIES.length} Frankfurter currencies stands in ` +
          `for ${Math.round(FRANKFURTER_CURRENCY_LIST_RETRY_MS / 60_000)} minutes`,
      );
      this.currencyList = {
        codes: FALLBACK_CURRENCY_SET,
        validUntil: Date.now() + FRANKFURTER_CURRENCY_LIST_RETRY_MS,
      };
      return FALLBACK_CURRENCY_SET;
    }
    this.currencyList = {
      codes,
      validUntil: Date.now() + FRANKFURTER_CURRENCY_LIST_TTL_MS,
    };
    return codes;
  }

  /**
   * One GET against the instance, through the breaker. `null` is "did not
   * answer": refused by the breaker, a transport failure, a timeout, a body
   * that never finished, or a non-2xx other than 404. The caller decides what
   * a 404 and a body mean for its endpoint.
   */
  private async request(
    path: string,
    timeoutMs: number,
    context: string,
  ): Promise<FrankfurterAnswer> {
    let admission: ProviderAdmission;
    try {
      admission = this.health.assertAvailable(FRANKFURTER_PROVIDER);
    } catch (error) {
      // Refused before anything was asked. `logFailure` prints nothing for a
      // refusal and reports what it suppressed on the next line that prints.
      this.health.logFailure(this.logger, FRANKFURTER_PROVIDER, context, error);
      return null;
    }

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/${path}`, {
        headers: { Accept: "application/json", "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      this.reportFailure(admission, context, error);
      return null;
    }

    if (!response.ok) {
      // A complete answer with nothing left to read: the host is up, whatever
      // it said.
      this.health.recordSuccess(FRANKFURTER_PROVIDER);
      if (response.status === 404) {
        this.logger.warn(
          `Frankfurter has nothing for ${context}: a currency the instance does not carry ` +
            `(which carries() should have screened) or a window before its history begins`,
        );
        return { kind: "not-found" };
      }
      // A 429 or a 5xx is the instance declining to answer this request. Not
      // a transport failure, so the breaker does not count it; the line is
      // still rate-limited through the one door.
      this.health.logFailure(
        this.logger,
        FRANKFURTER_PROVIDER,
        context,
        new Error(`Frankfurter returned HTTP ${response.status}`),
      );
      return null;
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      // A body that never finished arriving is a transport failure after the
      // headers, which the catch above never sees; it is counted here or a
      // stalling host never opens the breaker. Malformed JSON lands here too
      // and is not counted, which is the breaker's own rule.
      this.reportFailure(admission, context, error);
      return null;
    }
    this.health.recordSuccess(FRANKFURTER_PROVIDER);
    return { kind: "body", body };
  }

  /**
   * Count and log one failed attempt, and give back the probe slot when the
   * breaker did not count it. Only the probe holder may hand the slot back: a
   * straggler admitted through a closed breaker owns nothing, and releasing
   * then would free somebody else's probe and let a second one out beside it.
   */
  private reportFailure(
    admission: ProviderAdmission,
    context: string,
    error: unknown,
  ): void {
    const counted = this.health.recordFailure(FRANKFURTER_PROVIDER, error);
    if (!counted && admission === "probe") {
      this.health.releaseProbe(FRANKFURTER_PROVIDER);
    }
    // The single door for the log line; recording is idempotent per error
    // object, so the count above is not doubled by it.
    this.health.logFailure(this.logger, FRANKFURTER_PROVIDER, context, error);
  }

  /**
   * A 2xx whose body is not the shape this adapter reads: the host answered,
   * and the answer is useless, which is "did not answer" to the chain and one
   * rate-limited line to the operator. Not a transport failure, so the breaker
   * leaves it uncounted.
   */
  private unreadable(context: string): null {
    this.health.logFailure(
      this.logger,
      FRANKFURTER_PROVIDER,
      context,
      new Error(`Frankfurter returned an unreadable response to ${context}`),
    );
    return null;
  }
}
