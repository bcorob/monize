import { Injectable } from "@nestjs/common";
import { DataSource } from "typeorm";

import { returnedRows } from "../db/query-result";
import { withScopedDb } from "../db/scoped-db";
import { withSystemContext } from "../db/with-context";
import { APPLICATION_NAME_PREFIX } from "./instance-id";

/** How long a process must have been running before the census counts it. */
export const REPLICA_CENSUS_MIN_AGE_MINUTES = 10;

/**
 * How long a count stays reportable. The system-alert sweep refreshes it every
 * fifteen minutes; two missed sweeps and the figure is no longer a fact about
 * now, so the health endpoint reports nothing rather than an old number.
 */
export const REPLICA_CENSUS_MAX_AGE_MS = 35 * 60 * 1000;

/**
 * Reads the start time back out of `monize-backend:<uuid>@<started>`. A name
 * that does not end that way yields NULL, so it never matches and never raises.
 */
const STARTED_AT_PATTERN = "@([0-9]{1,12})$";

/**
 * Counts the backend processes connected to this database, so a deployment
 * that asserted `CLUSTER_MODE=single` can notice that it is not alone.
 *
 * Each process stamps its sessions with `application_name =
 * monize-backend:<INSTANCE_ID>@<started>` (`instance-id.ts`), so the number of
 * distinct values in `pg_stat_activity` is the number of processes.
 * `application_name` is readable on every session whatever role opened it (the
 * view masks `backend_start`, `query` and the like on other roles' rows, not
 * the name), and one process counts once however many roles or connections it
 * uses.
 *
 * Only processes that started more than ten minutes ago count, so the brief
 * overlap of a rolling deployment -- old and new pod both connected while
 * traffic moves -- is not read as two replicas. The age is the process's, from
 * the name, not the session's `backend_start`: the pool closes a connection
 * idle for ten seconds, so a session of a quiet replica is never ten minutes
 * old, and `backend_start` is masked on another role's rows anyway.
 *
 * A peer is visible only while it holds a connection, which an idle pool does
 * not. The system-alert sweep runs on the same wall-clock schedule on every
 * replica, so their sessions overlap at the moment it asks; the count still
 * errs towards "one" and never invents a peer.
 *
 * A census, not a lock: it answers "how many right now", races with every
 * process starting and stopping, and drives only a warning and a health field.
 * Nothing may be decided from it.
 *
 * `pg_stat_activity` covers every database on the server, so the count is
 * limited to `current_database()`: a staging and a production deployment on
 * one PostgreSQL server are two single-replica deployments, not one with two
 * replicas.
 *
 * The last count is kept, with when it was taken, for `GET /health`: that
 * endpoint is unauthenticated and unthrottled, so it reads this cache and never
 * queries. The cache is two scalars describing this process's own last read,
 * per replica by construction.
 *
 * `pg_stat_activity` is a system view with no owner column, and the callers are
 * a cron and the health endpoint, neither of which carries a user identity --
 * so the read seeds a system context, and this file is on
 * `WITH_CONTEXT_ALLOWLIST`.
 */
@Injectable()
export class ReplicaCensusService {
  private lastCount: number | null = null;
  private lastCountAt = 0;

  constructor(private readonly dataSource: DataSource) {}

  /** Distinct backend processes, running for over ten minutes, connected now. */
  async countActiveProcesses(): Promise<number> {
    const result = await withSystemContext(() =>
      withScopedDb(this.dataSource, (m) =>
        m.query(
          `SELECT count(DISTINCT application_name)::int AS n
             FROM pg_stat_activity
            WHERE datname = current_database()
              AND starts_with(application_name, $1)
              AND substring(application_name FROM $2)::bigint
                  < extract(epoch FROM now())::bigint - $3::int * 60`,
          [
            APPLICATION_NAME_PREFIX,
            STARTED_AT_PATTERN,
            REPLICA_CENSUS_MIN_AGE_MINUTES,
          ],
        ),
      ),
    );
    const [row] = returnedRows<{ n: number | string }>(result);
    const count = Number(row?.n ?? 0);
    this.lastCount = count;
    this.lastCountAt = Date.now();
    return count;
  }

  /**
   * The count the last census took, or `null` when none was taken within
   * {@link REPLICA_CENSUS_MAX_AGE_MS}. Never queries: this is what a caller
   * that must not cost a database round trip reads.
   */
  lastKnownCount(now: number = Date.now()): number | null {
    if (this.lastCount === null) return null;
    if (now - this.lastCountAt > REPLICA_CENSUS_MAX_AGE_MS) return null;
    return this.lastCount;
  }
}
