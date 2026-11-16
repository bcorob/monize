import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Cron, CronExpression } from "@nestjs/schedule";
import { DataSource } from "typeorm";
import { UserPreference } from "../users/entities/user-preference.entity";
import { patchUserPreferences } from "../users/user-preference-writer";
import { withScopedDb } from "../common/db/scoped-db";
import { withSystemContext } from "../common/db/with-context";
import { returnedRows } from "../common/db/query-result";
import { UpdateCheckState } from "./entities/update-check-state.entity";

// Version comes from the backend package.json at build/run time. Using require
// keeps the read synchronous and avoids ESM import-assertion issues.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const backendPkg = require("../../package.json") as { version: string };

const GITHUB_LATEST_RELEASE_URL =
  "https://api.github.com/repos/kenlasko/monize/releases/latest";
const FETCH_TIMEOUT_MS = 10_000;

/**
 * How long one answer stands.
 *
 * The same twelve hours the cron runs on, and deliberately so: the cron is what
 * makes a check due, and this is what keeps a second replica's tick -- or a
 * restart's startup refresh -- from asking again inside the same window.
 */
export const UPDATE_CHECK_WINDOW_MS = 12 * 60 * 60 * 1000;

interface GithubRelease {
  tag_name: string;
  name: string;
  html_url: string;
  published_at: string;
  draft: boolean;
  prerelease: boolean;
}

/** The stored answer, as every reader consumes it. */
export interface LatestRelease {
  latestVersion: string | null;
  releaseUrl: string | null;
  releaseName: string | null;
  publishedAt: string | null;
  checkedAt: string | null;
  error: string | null;
}

/** Nothing known yet: no row, or the check disabled. */
const NO_RELEASE: LatestRelease = {
  latestVersion: null,
  releaseUrl: null,
  releaseName: null,
  publishedAt: null,
  checkedAt: null,
  error: null,
};

export interface UpdateStatus {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  releaseUrl: string | null;
  releaseName: string | null;
  publishedAt: string | null;
  checkedAt: string | null;
  dismissed: boolean;
  disabled: boolean;
  error: string | null;
}

/**
 * Parse a version string like "1.8.40" or "v1.8.40" into [major, minor, patch].
 * Returns null if the string does not match that shape.
 */
export function parseVersion(version: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * Returns true if `latest` is strictly newer than `current`. Both must parse
 * into major.minor.patch; otherwise returns false (treat as "no update").
 */
export function isNewerVersion(current: string, latest: string): boolean {
  const c = parseVersion(current);
  const l = parseVersion(latest);
  if (!c || !l) return false;
  for (let i = 0; i < 3; i++) {
    if (l[i] > c[i]) return true;
    if (l[i] < c[i]) return false;
  }
  return false;
}

@Injectable()
export class UpdatesService implements OnModuleInit {
  private readonly logger = new Logger(UpdatesService.name);
  private readonly currentVersion: string = backendPkg.version;
  private readonly enabled: boolean;

  constructor(
    private readonly dataSource: DataSource,
    private readonly configService: ConfigService,
  ) {
    // Default enabled; disable with UPDATE_CHECK_ENABLED=false.
    const flag = this.configService.get<string>("UPDATE_CHECK_ENABLED");
    this.enabled = flag === undefined ? true : flag !== "false";
  }

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.log(
        "Upstream update check disabled via UPDATE_CHECK_ENABLED",
      );
      return;
    }
    // Non-blocking startup refresh so a first-ever install has an answer as
    // early as possible. It goes through the same window claim as the cron, so
    // a rollout of N pods makes at most one request and a restart inside the
    // window makes none.
    void this.refreshLatestRelease().catch((error) =>
      this.logger.warn(
        `Startup update check failed: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }

  @Cron(CronExpression.EVERY_12_HOURS)
  async scheduledRefresh(): Promise<void> {
    if (!this.enabled) return;
    await this.refreshLatestRelease();
  }

  /**
   * Ask GitHub for the latest release and store the answer, if this replica is
   * the one whose turn it is.
   *
   * The claim and the freshness check are one statement (`claimCheck`): a
   * replica that finds the stored answer younger than the window returns
   * without a request, and so does the loser of a simultaneous tick. GitHub's
   * unauthenticated rate limit is per IP, shared by every replica behind one
   * egress address, so "N replicas, N requests" is the failure this prevents.
   *
   * Network and rate-limit failures are stored as `last_error` and logged
   * rather than thrown -- the endpoint stays available, saying it could not
   * check rather than that there is nothing to install.
   */
  async refreshLatestRelease(): Promise<void> {
    if (!(await this.claimCheck())) {
      this.logger.debug(
        "Upstream release was checked inside the window; skipping",
      );
      return;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(GITHUB_LATEST_RELEASE_URL, {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "Monize-UpdateCheck",
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        this.logger.warn(
          `GitHub releases API returned status ${response.status}; skipping update`,
        );
        await this.recordError(`github_status_${response.status}`);
        return;
      }

      const release = (await response.json()) as GithubRelease;
      if (release.draft || release.prerelease) {
        this.logger.debug(
          `Latest GitHub release ${release.tag_name} is draft/prerelease; ignoring`,
        );
        // Not an error: the upstream simply has nothing released yet. The
        // window is already held by the claim, so this replica is done.
        await this.recordError(null);
        return;
      }

      const latestVersion = release.tag_name.replace(/^v/, "");
      await this.storeRelease({
        latestVersion,
        releaseUrl: release.html_url,
        releaseName: release.name || release.tag_name,
        publishedAt: release.published_at,
      });
      this.logger.log(
        `Latest upstream release: ${latestVersion} (current: ${this.currentVersion})`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Failed to refresh latest release from GitHub: ${message}`,
      );
      await this.recordError("unreachable");
    } finally {
      clearTimeout(timeout);
    }
  }

  async getStatus(userId: string): Promise<UpdateStatus> {
    if (!this.enabled) {
      return {
        currentVersion: this.currentVersion,
        latestVersion: null,
        updateAvailable: false,
        releaseUrl: null,
        releaseName: null,
        publishedAt: null,
        checkedAt: null,
        dismissed: false,
        disabled: true,
        error: null,
      };
    }

    const {
      latestVersion,
      releaseUrl,
      releaseName,
      publishedAt,
      checkedAt,
      error,
    } = await this.readLatestRelease();

    const updateAvailable =
      !!latestVersion && isNewerVersion(this.currentVersion, latestVersion);

    let dismissed = false;
    if (updateAvailable && latestVersion) {
      const prefs = await withScopedDb(this.dataSource, (manager) =>
        manager.getRepository(UserPreference).findOne({ where: { userId } }),
      );
      dismissed = prefs?.dismissedUpdateVersion === latestVersion;
    }

    return {
      currentVersion: this.currentVersion,
      latestVersion,
      updateAvailable,
      releaseUrl,
      releaseName,
      publishedAt,
      checkedAt,
      dismissed,
      disabled: false,
      error,
    };
  }

  /**
   * Record that the user has dismissed the banner for the current latest
   * version. Stored on user_preferences so it survives across devices and
   * re-appears automatically when a newer upstream release is detected.
   */
  async dismiss(
    userId: string,
  ): Promise<{ dismissed: boolean; version: string | null }> {
    const { latestVersion } = await this.readLatestRelease();
    if (!latestVersion) {
      return { dismissed: false, version: null };
    }

    // Write only the dismissed-version column through the shared writer, which
    // materializes the row from the shared defaults when none exists yet. Never
    // a whole-entity save: a concurrent change to another preference (a theme
    // switch, a dismissed tour) must not be reverted (maintainer review
    // PR #1097, finding 3).
    await withScopedDb(this.dataSource, (manager) =>
      patchUserPreferences(manager, userId, {
        dismissedUpdateVersion: latestVersion,
      }),
    );
    return { dismissed: true, version: latestVersion };
  }

  /**
   * Take the window, and say whether this replica is the one to ask GitHub.
   *
   * One statement, so the freshness check and the claim cannot disagree: the
   * `DO UPDATE ... WHERE` arm moves `checked_at` only when the stored one is
   * older than the window, and `RETURNING id` is the win. A read followed by a
   * write would let two replicas both pass the read on the same tick, which is
   * the whole thing being prevented.
   *
   * It stamps on the *attempt*, not the outcome. A failed check therefore still
   * holds the window -- stamping only on success would turn an unreachable
   * GitHub into a request from every replica on every tick, which is exactly
   * when the rate limit is least affordable.
   */
  private async claimCheck(): Promise<boolean> {
    return withSystemContext(async () => {
      const rows = await withScopedDb(this.dataSource, (manager) =>
        manager.query(
          `INSERT INTO update_check_state (id, checked_at)
           VALUES (TRUE, CURRENT_TIMESTAMP)
           ON CONFLICT (id) DO UPDATE
              SET checked_at = CURRENT_TIMESTAMP
            WHERE update_check_state.checked_at
                    < CURRENT_TIMESTAMP - ($1::bigint::text || ' milliseconds')::interval
           RETURNING id`,
          [UPDATE_CHECK_WINDOW_MS],
        ),
      );
      return returnedRows(rows).length > 0;
    });
  }

  /** Write the answer onto the row this replica already claimed. */
  private async storeRelease(release: {
    latestVersion: string;
    releaseUrl: string;
    releaseName: string;
    publishedAt: string;
  }): Promise<void> {
    await withSystemContext(() =>
      withScopedDb(this.dataSource, (manager) =>
        manager.query(
          `UPDATE update_check_state
              SET latest_version = $1,
                  release_url = $2,
                  release_name = $3,
                  published_at = $4::timestamptz,
                  last_error = NULL
            WHERE id = TRUE`,
          [
            release.latestVersion,
            release.releaseUrl,
            release.releaseName,
            release.publishedAt,
          ],
        ),
      ),
    );
  }

  /**
   * Record why this check produced no version, keeping whatever version was
   * already known.
   *
   * The previous answer is deliberately not cleared: an instance that could
   * reach GitHub yesterday and cannot today still knows there is an update, and
   * blanking it would downgrade "cannot check" to "nothing to install".
   */
  private async recordError(error: string | null): Promise<void> {
    await withSystemContext(() =>
      withScopedDb(this.dataSource, (manager) =>
        manager.query(
          `UPDATE update_check_state SET last_error = $1 WHERE id = TRUE`,
          [error],
        ),
      ),
    );
  }

  /**
   * The stored answer, as every reader sees it.
   *
   * Read under the caller's own identity: `update_check_state` is RLS-exempt,
   * so a request transaction reads it exactly as a system one would, and
   * seeding a bypass on a request path would widen the fence for nothing
   * (`docs/backend/database-access-and-tenancy.md`). The refresh, which has no
   * request behind it, seeds its own.
   *
   * Public because it is the deployment's answer rather than this process's:
   * `getStatus` and `dismiss` read it, and so does the integration spec that
   * proves a replica which never fetched serves the same one.
   */
  async readLatestRelease(): Promise<LatestRelease> {
    const row = await withScopedDb(this.dataSource, (manager) =>
      manager.getRepository(UpdateCheckState).findOne({ where: { id: true } }),
    );
    if (!row) return NO_RELEASE;
    return {
      latestVersion: row.latestVersion,
      releaseUrl: row.releaseUrl,
      releaseName: row.releaseName,
      publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
      checkedAt: row.checkedAt ? row.checkedAt.toISOString() : null,
      error: row.lastError,
    };
  }
}
