import { Injectable } from "@nestjs/common";
import { DataSource } from "typeorm";

import { withScopedDb } from "../common/db/scoped-db";
import { returnedRows } from "../common/db/query-result";
import { hashToken } from "./crypto.util";

/**
 * "This may be used once", decided by the database.
 *
 * The claim **is** the `INSERT`. `ON CONFLICT DO NOTHING RETURNING` makes the
 * primary key the serialization point, so the winner is chosen by PostgreSQL
 * rather than by a read the loser also passed -- which is the whole difference
 * from the `Set` and `Map` fields this replaces, where each replica held its own
 * idea of what had been spent and a restart forgot all of it.
 *
 * **It joins the caller's transaction**, deliberately, and that is the opposite
 * choice from `AuthAttemptCounterService.increment`. A claim guards work: the
 * caller wants "claimed and applied" or "neither", so a failed apply must give
 * the claim back. Where the claim guards a *login* -- a TOTP code, with no
 * ambient transaction -- `withScopedDb` opens its own and commits it, which is
 * the same rule producing the right answer at both call sites.
 *
 * An expired row is still a loss. The sweep (`AuthStateSweeperService`) deletes
 * past `expires_at`; until it runs, a second claim on the same hash conflicts.
 * Nothing here needs it otherwise: what these rows guard is dead by then anyway.
 */
@Injectable()
export class SingleUseTokenService {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * Spend `token` under `purpose`. `true` means this caller won it.
   *
   * The token is hashed here rather than in SQL so the secret never leaves the
   * process -- not as a bind parameter, not in a statement log. The table has no
   * owner column and is RLS-exempt, so anything stored in it is readable by
   * every session; a stored code would be a replayable one.
   *
   * `purpose` keeps two unrelated one-shots from colliding on one hash, so it is
   * a literal at the call site, never derived from a request.
   */
  async claim(purpose: string, token: string, ttlMs: number): Promise<boolean> {
    const rows = await withScopedDb(this.dataSource, (manager) =>
      manager.query(
        `INSERT INTO single_use_tokens (purpose, token_hash, expires_at)
         VALUES ($1, $2, CURRENT_TIMESTAMP + ($3::bigint::text || ' milliseconds')::interval)
         ON CONFLICT (purpose, token_hash) DO NOTHING
         RETURNING token_hash`,
        [purpose, hashToken(token), Math.round(ttlMs)],
      ),
    );
    return returnedRows(rows).length > 0;
  }

  /**
   * Give a claim back, so the thing it guarded can be attempted again.
   *
   * For a claim whose guarded work runs in the same transaction, the rollback
   * does this and nothing calls it. It exists for the callers whose work spans
   * several transactions of its own -- there the claim has to be taken before
   * the work and handed back when the work fails, or a transient error would
   * burn a descriptor its owner is entitled to retry.
   *
   * Only the holder reaches this: `claim` returned `true` to exactly one caller,
   * and that caller is the only one on this path.
   */
  async release(purpose: string, token: string): Promise<void> {
    await withScopedDb(this.dataSource, (manager) =>
      manager.query(
        `DELETE FROM single_use_tokens WHERE purpose = $1 AND token_hash = $2`,
        [purpose, hashToken(token)],
      ),
    );
  }
}
