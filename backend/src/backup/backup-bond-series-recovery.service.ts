import { HttpException, HttpStatus, Injectable, Logger } from "@nestjs/common";
import { DataSource } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { isTransportFailure } from "../common/http/fetch-failure.util";
import { isProviderUnavailable } from "../provider-health/provider-unavailable.error";
import { SeriesFetchError } from "../bonds/bond-adapter";
import {
  BACKFILL_ATTEMPT_INTERVAL_MS,
  BACKFILL_GAP_MS,
  BondSeriesService,
  defaultSleep,
} from "../bonds/bond-series.service";
import {
  FetchSyncService,
  bondSeriesAttemptJob,
} from "../common/jobs/fetch-sync.service";
import {
  BackupBondSeriesIdentity,
  BackupData,
  MAX_BOND_SERIES_FETCHES_PER_RESTORE,
  UnrecoveredBondSeries,
  UnrecoveredBondSeriesReason,
} from "./backup-format";
import {
  applyBondSeriesIds,
  referencedBondSeries,
  seriesKey,
} from "./restore-bond-series";

export interface BondSeriesRecoveryOptions {
  /** Waits between two fetches; injectable so a test does not wait. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/** What the recovery hands back: the document with its series ids settled, and what did not come back. */
export interface BondSeriesRecovery {
  data: BackupData;
  unrecovered: UnrecoveredBondSeries[];
}

/**
 * Gets back the bond series a backup's rows reference, before the restore
 * transaction.
 *
 * `bond_instruments` is reference data a backup does not carry, and a fresh
 * deployment's catalog holds no series at all (INV-BOND-008), so a restore onto
 * a new server used to write NULL over every `investment_transactions.
 * bond_instrument_id` -- for ever, because an ADD_SHARES or an unpaired
 * TRANSFER_IN can never be re-inferred. The person's decision to hold those
 * bonds was made when they added them, and the restore is the person's own
 * action, so it may fetch the series the file references from the official
 * source (INV-BOND-008, "a restore of the person's own backup"). Only those
 * series: the file's `bondCatalog` member is identity, never terms, so the
 * official source stays the only origin of a rate (INV-BOND-006).
 *
 * Order, and why: this runs **before** the restore transaction, like staging
 * attachment bytes -- a fetch is an external effect that cannot roll back and a
 * network wait does not belong in the transaction that holds every one of the
 * user's rows. The catalog store is idempotent and global (an advisory lock per
 * instrument, an immutable first terms version), so a series fetched for a
 * restore that then fails is harmless: it is what the person's next fetch would
 * have stored. No fetched series is ever undone.
 *
 * Pacing: a restore is a bounded one-off action of the person (at most
 * `MAX_BOND_SERIES_FETCHES_PER_RESTORE` fetches), so it is not charged against
 * the interactive per-minute allowance (`limiter: "none"`, an option no route,
 * DTO or tool schema can pass). It is paced toward the issuer instead: the
 * backfill's `BACKFILL_GAP_MS` between two fetches.
 *
 * Every refusal is recorded and never fatal: a restore replaces the account from
 * the file whether or not the official source answers, and the rows whose series
 * did not come back are restored without it, as before (`unlinkedBondSeries`
 * counts them; the result lists the series and the reason).
 */
/** How long a transient failure keeps a series from being asked for again. */
export const TRANSIENT_COOLDOWN_MS = 10 * 60_000;

/** Failures that say nothing about the series, only about the moment. */
const TRANSIENT_REASONS: ReadonlySet<UnrecoveredBondSeriesReason> = new Set([
  "source-unavailable",
  "rate-limited",
]);

@Injectable()
export class BackupBondSeriesRecoveryService {
  private readonly logger = new Logger(BackupBondSeriesRecoveryService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly series: BondSeriesService,
    private readonly fetchSync: FetchSyncService,
  ) {}

  /**
   * Needs the request's identity (an authenticated route, or a caller inside
   * `withUserContext`), like every database access. A file without the
   * `bondCatalog` member, or whose rows name no series it describes, is returned
   * as it came and nothing is read, fetched or written.
   */
  async recover(
    userId: string,
    data: BackupData,
    options: BondSeriesRecoveryOptions = {},
  ): Promise<BondSeriesRecovery> {
    const sleep = options.sleep ?? defaultSleep;
    const wanted = referencedBondSeries(data);
    if (wanted.length === 0) return { data, unrecovered: [] };

    const present = await this.findInCatalog(wanted);
    const missing = wanted.filter((id) => !present.has(seriesKey(id)));
    // Keyed by series so a series is reported once, whichever step refused it.
    const unrecovered = new Map<string, UnrecoveredBondSeries>();

    // One at a time, bounded: the adapters pace their own requests, and a file
    // is not allowed to make the server fetch an unbounded list.
    let stoppedBy: UnrecoveredBondSeriesReason | null = null;
    let fetched = 0;
    let failedFetches = 0;
    for (const [position, identity] of missing.entries()) {
      const key = seriesKey(identity);
      if (position >= MAX_BOND_SERIES_FETCHES_PER_RESTORE) {
        unrecovered.set(key, describe(identity, "not-attempted"));
        continue;
      }
      if (stoppedBy !== null) {
        unrecovered.set(key, describe(identity, stoppedBy));
        continue;
      }
      // The negative cache the backfill uses, shared by every replica: a series
      // asked for in the last day (by a restore, a Refresh or the cron) is not
      // asked for again, so a file that names the same unpublished codes
      // restore after restore costs the issuer one request per code a day.
      const attemptJob = bondSeriesAttemptJob(
        identity.issuerCountryCode,
        identity.seriesCode,
      );
      const claimed = await this.fetchSync.claim(
        attemptJob,
        BACKFILL_ATTEMPT_INTERVAL_MS,
      );
      if (claimed === null) {
        unrecovered.set(key, describe(identity, "not-attempted"));
        continue;
      }
      // Between two requests to the issuer, never before the first.
      if (fetched + failedFetches > 0) await sleep(BACKFILL_GAP_MS);
      try {
        await this.series.fetchSeries(
          userId,
          identity.issuerCountryCode,
          identity.seriesCode,
          { limiter: "none" },
        );
        fetched += 1;
      } catch (error) {
        failedFetches += 1;
        const reason = classifyFetchFailure(error);
        this.logger.warn(
          `Backup restore could not fetch bond series ${identity.issuerCountryCode} ` +
            `${identity.seriesCode}: ${reason} (${
              error instanceof Error ? error.message : String(error)
            })`,
        );
        unrecovered.set(key, describe(identity, reason));
        // Only a definitive answer (not published, refused) holds the day's
        // lease. A transient one shortens it to a cooldown rather than
        // clearing it: a source outage during one person's restore must not
        // keep the series from everyone for a day, and restores repeated
        // back-to-back must not hit a source that has just said "slow down".
        if (TRANSIENT_REASONS.has(reason)) {
          await this.fetchSync.release(attemptJob, claimed);
          await this.fetchSync.claim(attemptJob, TRANSIENT_COOLDOWN_MS);
        }
        // A limit answering (the source's own, since the restore is not charged
        // the per-user one) holds for every later request; asking again only
        // spends the allowance. The rest are reported, not tried.
        if (reason === "rate-limited") stoppedBy = reason;
      }
    }

    // Settled by identity, after the fetches: an id in the file is only a hint,
    // and a series fetched under another issuer than the file named is not it.
    const after = await this.findInCatalog(wanted);
    const idByBackupId = new Map<string, string>();
    for (const identity of wanted) {
      const key = seriesKey(identity);
      const targetId = after.get(key);
      if (targetId === undefined) {
        if (!unrecovered.has(key)) {
          unrecovered.set(key, describe(identity, "refused"));
        }
      } else if (!idByBackupId.has(identity.bondInstrumentId)) {
        idByBackupId.set(identity.bondInstrumentId, targetId);
      }
    }

    if (missing.length > 0) {
      this.logger.log(
        `Backup restore fetched ${fetched} of ${missing.length} bond series this ` +
          `deployment lacked for user ${userId}; ${unrecovered.size} could not be restored.`,
      );
    }
    return {
      data: applyBondSeriesIds(data, idByBackupId),
      unrecovered: [...unrecovered.values()],
    };
  }

  /** `seriesKey -> catalog id` of the identities the catalog holds, in one query. */
  private async findInCatalog(
    identities: readonly BackupBondSeriesIdentity[],
  ): Promise<Map<string, string>> {
    const rows: Array<{
      id: string;
      issuer_country_code: string;
      issuer_code: string;
      series_code: string;
    }> = await withScopedDb(this.dataSource, (m) =>
      m.query(
        `SELECT i.id, i.issuer_country_code, i.issuer_code, UPPER(i.series_code) AS series_code
           FROM bond_instruments i
           JOIN unnest($1::text[], $2::text[], $3::text[]) AS w(country, issuer, series)
             ON i.issuer_country_code = w.country
            AND i.issuer_code = w.issuer
            AND UPPER(i.series_code) = w.series`,
        [
          identities.map((i) => i.issuerCountryCode),
          identities.map((i) => i.issuerCode),
          identities.map((i) => i.seriesCode),
        ],
      ),
    );
    return new Map(
      rows.map((row) => [
        seriesKey({
          issuerCountryCode: row.issuer_country_code,
          issuerCode: row.issuer_code,
          seriesCode: row.series_code,
        }),
        row.id,
      ]),
    );
  }
}

function describe(
  identity: Pick<BackupBondSeriesIdentity, "issuerCountryCode" | "seriesCode">,
  reason: UnrecoveredBondSeriesReason,
): UnrecoveredBondSeries {
  return {
    issuerCountryCode: identity.issuerCountryCode,
    seriesCode: identity.seriesCode,
    reason,
  };
}

/**
 * Why a fetch failed, in the words the restore's report uses. A refusal the
 * adapter named maps by its code; a transport failure or an open breaker is the
 * source being down; an explicit-fetch limit is its own answer (HTTP 429);
 * anything else is a refusal of this series.
 */
export function classifyFetchFailure(
  error: unknown,
): UnrecoveredBondSeriesReason {
  if (error instanceof SeriesFetchError) {
    switch (error.code) {
      case "SERIES_NOT_PUBLISHED":
        return "not-published";
      case "SOURCE_UNAVAILABLE":
        return "source-unavailable";
      case "SERIES_FETCH_UNSUPPORTED":
        return "no-adapter";
      default:
        return "refused";
    }
  }
  if (
    error instanceof HttpException &&
    error.getStatus() === HttpStatus.TOO_MANY_REQUESTS
  ) {
    return "rate-limited";
  }
  if (isProviderUnavailable(error) || isTransportFailure(error)) {
    return "source-unavailable";
  }
  return "refused";
}
