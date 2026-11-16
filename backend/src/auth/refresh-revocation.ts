import { Logger } from "@nestjs/common";
import { DataSource, In } from "typeorm";

import { withScopedDb } from "../common/db/scoped-db";
import { lockTokenFamily } from "../common/db/locks";
import { hashToken } from "./crypto.util";
import { RefreshToken } from "./entities/refresh-token.entity";

/**
 * Revoke every refresh session `userId` has open *right now*, converging
 * against rotations running beside it. `TokenService.revokeAllUserRefreshTokens`
 * documents the protocol; this is its body, as a function, so the services that
 * cannot inject `TokenService` without a module cycle (users, admin, delegation)
 * end sessions the same way instead of with one blanket
 * `UPDATE ... WHERE user_id = ? AND is_revoked = false`, which misses a successor
 * a concurrent rotation inserts after the statement's snapshot (A26-M02).
 *
 * Never call it inside another transaction: each pass is its own `withScopedDb`
 * transaction, and nesting would collapse the passes into one. Call it after the
 * credential write commits, under the identity that can see `userId`'s rows.
 */
export async function revokeUserRefreshFamilies(
  dataSource: DataSource,
  userId: string,
  logger: Logger,
  keepSessionOf?: string,
): Promise<void> {
  const keepHash = keepSessionOf ? hashToken(keepSessionOf) : null;
  // First round: the families this user has a live session in, captured before
  // any revocation. This is the whole set the operation is allowed to touch.
  const families = await withScopedDb(dataSource, async (manager) => {
    const rows: { family_id: string }[] = await manager.query(
      `SELECT DISTINCT family_id FROM refresh_tokens
        WHERE user_id = $1 AND is_revoked = false
          AND family_id IS DISTINCT FROM (
            SELECT kept.family_id FROM refresh_tokens kept
             WHERE kept.user_id = $1 AND kept.token_hash = $2
             LIMIT 1)`,
      [userId, keepHash],
    );
    // Ascending, the same fixed order every other multi-lock path uses, so a
    // pass cannot deadlock against a rotation holding one family.
    return rows.map((r) => r.family_id).sort((a, b) => a.localeCompare(b));
  });
  if (families.length === 0) return;

  // Bounded: a legitimate client rotates once per refresh, so two passes is
  // the realistic worst case. The cap stops a pathological caller spinning
  // here forever rather than expressing a real expectation.
  const MAX_PASSES = 10;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const affected = await withScopedDb(dataSource, async (manager) => {
      for (const familyId of families) {
        await lockTokenFamily(manager, familyId);
      }
      // Scoped to `familyId IN (captured)`: never a blanket sweep of every
      // unrevoked token, so a family opened mid-operation is left alone.
      const result = await manager
        .getRepository(RefreshToken)
        .update(
          { userId, familyId: In(families), isRevoked: false },
          { isRevoked: true },
        );
      return result.affected ?? 0;
    });
    if (affected === 0) return;
  }
  logger.warn(
    `Gave up revoking sessions for user ${userId} after ${MAX_PASSES} passes; ` +
      "a client may be rotating refresh tokens in a loop",
  );
}
