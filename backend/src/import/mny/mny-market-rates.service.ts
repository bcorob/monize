import { Inject, Injectable, Logger, forwardRef } from "@nestjs/common";
import { ExchangeRateService } from "../../currencies/exchange-rate.service";
import { addDaysYMD, todayYMD } from "../../common/date-utils";
import { roundFxRate } from "../../common/fx-entry.util";
import { FX_MAX_RATE_AGE_DAYS } from "../../common/time-series/fx-rate-resolver";
import {
  MnyMarketRate,
  MnyMarketRates,
  MnyRateGap,
} from "./model/mny-import-model";
import {
  MnyParseInput,
  MnyParsedFile,
  MnyParserService,
} from "./mny-parser.service";

/**
 * Parses a Money file, converting the cross-currency trades its own exchange
 * rates cannot reach at the market rate for their date.
 *
 * Money 97-99 keep a single rate per currency pair, dated when it was last
 * edited, so every earlier trade of a security quoted in another currency than
 * its account has no rate on or before its date in the file; a Money Plus file
 * can have the same hole wherever its rate history is thin. The parser stays
 * free of the database: it reports what it could not convert
 * (`investments.rateGaps`), this looks each pair and date up, and the file is
 * parsed again with the answers.
 *
 * Both the preview and the job parse through here, and the rates a lookup
 * fetches are persisted, so the job's re-read finds in the database what the
 * preview fetched and the two convert alike.
 */
@Injectable()
export class MnyMarketRateService {
  private readonly logger = new Logger(MnyMarketRateService.name);

  constructor(
    private readonly parser: MnyParserService,
    @Inject(forwardRef(() => ExchangeRateService))
    private readonly rates: ExchangeRateService,
  ) {}

  async parse(input: MnyParseInput): Promise<MnyParsedFile> {
    const parsed = this.parser.parse(input);
    const gaps = parsed.investments.rateGaps;
    if (gaps.length === 0) {
      return parsed;
    }

    const marketRates = await this.lookUp(gaps);
    if (marketRates.rates.length === 0 && marketRates.unanswered.size === 0) {
      return parsed;
    }
    // The first parse decrypted the buffer in place; a second decrypt would
    // re-encrypt it (`MnyParseInput.alreadyDecrypted`).
    return this.parser.parse({
      ...input,
      password: undefined,
      alreadyDecrypted: true,
      marketRates,
    });
  }

  /**
   * One rate per gap, through `resolveStoredRate`, the same rule every other
   * surface uses: the newest observation on or before the date, no older than
   * `FX_MAX_RATE_AGE_DAYS`. A pair with dates the stored history cannot answer
   * gets one provider window spanning all of them, persisted, and is resolved
   * again; that is one outbound call per pair however many trades it has.
   */
  async lookUp(gaps: readonly MnyRateGap[]): Promise<MnyMarketRates> {
    const today = todayYMD();
    const datesByPair = new Map<string, Set<string>>();
    for (const gap of gaps) {
      const pair = `${gap.from}->${gap.to}`;
      const dates = datesByPair.get(pair) ?? new Set<string>();
      dates.add(gap.date);
      datesByPair.set(pair, dates);
    }

    const rates: MnyMarketRate[] = [];
    const unanswered = new Set<string>();
    for (const [pair, dateSet] of datesByPair) {
      const [from, to] = pair.split("->");
      const dates = [...dateSet].sort();
      // A trade dated ahead of today is valued at today's rate, as
      // `getRateForDate` does: no later one exists yet.
      const onDate = (date: string): string => (date > today ? today : date);

      const misses: string[] = [];
      for (const date of dates) {
        const rate = await this.storedRate(from, to, onDate(date));
        if (rate === null) {
          misses.push(date);
        } else {
          rates.push({ from, to, date, rate });
        }
      }
      if (misses.length === 0) {
        continue;
      }

      const answered = await this.fill(
        from,
        to,
        addDaysYMD(onDate(misses[0]), -FX_MAX_RATE_AGE_DAYS),
        onDate(misses[misses.length - 1]),
      );
      if (!answered) {
        unanswered.add(pair);
      }
      for (const date of misses) {
        const rate = await this.storedRate(from, to, onDate(date));
        if (rate !== null) {
          rates.push({ from, to, date, rate });
        }
      }
    }

    return { rates, unanswered };
  }

  private async storedRate(
    from: string,
    to: string,
    date: string,
  ): Promise<number | null> {
    const resolution = await this.rates.resolveStoredRate(from, to, date);
    return resolution.rate === null || !(resolution.rate > 0)
      ? null
      : roundFxRate(resolution.rate);
  }

  /**
   * Fetches and persists one window. Best-effort: a provider failure leaves
   * those trades unconverted, and says the provider did not answer, rather
   * than failing the import.
   */
  private async fill(
    from: string,
    to: string,
    start: string,
    end: string,
  ): Promise<boolean> {
    try {
      const { stored, answered } = await this.rates.fillRateWindow(
        from,
        to,
        start,
        end,
      );
      this.logger.log(
        `Stored ${stored} ${from}/${to} rates over ${start} to ${end} for a Money import`,
      );
      return answered;
    } catch (error) {
      this.logger.warn(
        `Rate lookup ${from}->${to} over ${start} to ${end} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
  }
}
