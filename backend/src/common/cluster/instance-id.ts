import { randomUUID } from "node:crypto";

/**
 * One random id per backend process, minted when this module is first loaded.
 *
 * It exists so a PostgreSQL session can be attributed to the process that
 * opened it: every pooled connection carries it in `application_name`
 * (`app.module.ts`), and `ReplicaCensusService` counts the distinct values in
 * `pg_stat_activity` to learn how many backend processes share this database.
 *
 * Identity for observation, never for authorization. Nothing may decide who a
 * caller is, what a caller may do, or which process owns a job from this value:
 * any role that can connect can read every session's `application_name`, and a
 * restart mints a new one. Cross-replica ownership is a row
 * (`JobClaimService`), not this.
 *
 * A module-scope constant is process-local by construction, which is exactly
 * the property wanted here. The per-replica-state guard
 * (`process-local-state.guard.spec.ts`) matches only `Map`/`Set` fields on a
 * class, so it neither sees nor needs to see this.
 */
export const INSTANCE_ID: string = randomUUID();

/**
 * When this process started, in whole Unix seconds. Carried in the session name
 * so a peer can tell a long-running process from one that has just started,
 * whatever the age of the session it happens to hold (`ReplicaCensusService`).
 */
export const PROCESS_STARTED_AT_EPOCH_S: number = Math.floor(Date.now() / 1000);

/**
 * The `application_name` prefix every backend session carries. The census
 * matches on it, so another client of the same database (psql, a migration
 * runner, a BI tool) is never counted as a backend process.
 */
export const APPLICATION_NAME_PREFIX = "monize-backend:";

/**
 * `monize-backend:<uuid>@<started>`: 62 characters until the year 2286, inside
 * PostgreSQL's 63-byte `NAMEDATALEN` limit, so the server never truncates it
 * into a value two processes could share or a start time it cannot read back.
 */
export const APPLICATION_NAME = `${APPLICATION_NAME_PREFIX}${INSTANCE_ID}@${PROCESS_STARTED_AT_EPOCH_S}`;
