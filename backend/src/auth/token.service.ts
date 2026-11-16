import { Injectable, UnauthorizedException, Logger } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import {
  DataSource,
  EntityManager,
  EntityTarget,
  LessThan,
  ObjectLiteral,
  Repository,
} from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { lockTokenFamily } from "../common/db/locks";
import { Cron, CronExpression } from "@nestjs/schedule";
import * as crypto from "crypto";

import { User } from "../users/entities/user.entity";
import { RefreshToken } from "./entities/refresh-token.entity";
import { ACCESS_TOKEN_TYPE } from "./access-token";
import { hashToken } from "./crypto.util";
import { revokeUserRefreshFamilies } from "./refresh-revocation";
import { withSystemContext } from "../common/db/with-context";
import { tr } from "../i18n/translate";

export interface DelegationTokenContext {
  actingAsUserId: string;
  delegationId: string;
}

/** What the refresh transaction decided; a refusal is raised after it commits. */
type RefreshOutcome =
  | {
      kind: "issued";
      accessToken: string;
      refreshToken: string | null;
      userId: string;
    }
  | { kind: "refused"; message: string };

function refused(message: string): RefreshOutcome {
  return { kind: "refused", message };
}

@Injectable()
export class TokenService {
  /**
   * How long the immediate predecessor of a fresh successor is answered with an
   * access token instead of being read as reuse. Two tabs of one browser
   * refreshing together collide within milliseconds; the window is kept this
   * short because, inside it, a thief presenting the predecessor is not
   * detected (it gets one 15-minute access token and no refresh token, so it
   * cannot keep the session).
   */
  static readonly ROTATION_GRACE_SECONDS = 10;

  private readonly logger = new Logger(TokenService.name);
  private readonly ACCESS_TOKEN_EXPIRY = "15m";
  private readonly REFRESH_TOKEN_EXPIRY_MS = 1 * 24 * 60 * 60 * 1000; // 1 day
  private readonly REMEMBER_ME_EXPIRY_MS: number;

  constructor(
    private jwtService: JwtService,
    private dataSource: DataSource,
    private configService: ConfigService,
  ) {
    const rememberMeDays = parseInt(
      this.configService.get<string>("REMEMBER_ME_DAYS", "30"),
      10,
    );
    this.REMEMBER_ME_EXPIRY_MS =
      (rememberMeDays > 0 ? rememberMeDays : 30) * 24 * 60 * 60 * 1000;
  }

  /**
   * One repository call in its own short scoped transaction -- the RLS-era
   * replacement for the injected repositories this class used to hold, with the
   * same autocommit boundary each of those calls had. Multi-statement units use
   * an explicit `withScopedDb` block so their statements share one transaction.
   */
  private scoped<E extends ObjectLiteral, T>(
    entity: EntityTarget<E>,
    fn: (repo: Repository<E>) => Promise<T>,
  ): Promise<T> {
    return withScopedDb(this.dataSource, (manager) =>
      fn(manager.getRepository(entity)),
    );
  }

  getRefreshExpiryMs(rememberMe?: boolean): number {
    return rememberMe
      ? this.REMEMBER_ME_EXPIRY_MS
      : this.REFRESH_TOKEN_EXPIRY_MS;
  }

  async generateTokenPair(
    user: User,
    rememberMe?: boolean,
    context?: DelegationTokenContext,
  ): Promise<{ accessToken: string; refreshToken: string }> {
    // SECURITY: `sub` is ALWAYS the real authenticated user. When acting as a
    // delegate the data-scoping id is carried separately in actingAsUserId so
    // refresh rotation / family revocation / replay detection keep keying off
    // the real user.
    const payload: Record<string, unknown> = {
      sub: user.id,
      type: ACCESS_TOKEN_TYPE,
      email: user.email,
      authProvider: user.authProvider,
      role: user.role,
    };
    if (context?.actingAsUserId && context?.delegationId) {
      payload.actingAsUserId = context.actingAsUserId;
      payload.delegationId = context.delegationId;
    }
    const accessToken = this.jwtService.sign(payload, {
      expiresIn: this.ACCESS_TOKEN_EXPIRY,
    });

    const rawRefreshToken = crypto.randomBytes(64).toString("hex");
    const tokenHash = hashToken(rawRefreshToken);
    const familyId = crypto.randomUUID();
    const expiryMs = this.getRefreshExpiryMs(rememberMe);

    await withScopedDb(this.dataSource, (manager) => {
      const repo = manager.getRepository(RefreshToken);
      return repo.save(
        repo.create({
          userId: user.id,
          tokenHash,
          familyId,
          isRevoked: false,
          expiresAt: new Date(Date.now() + expiryMs),
          replacedByHash: null,
          rememberMe: !!rememberMe,
          actingAsUserId: context?.actingAsUserId ?? null,
          delegationId: context?.delegationId ?? null,
        }),
      );
    });

    return { accessToken, refreshToken: rawRefreshToken };
  }

  /**
   * Rotate a refresh token, or refuse it.
   *
   * A refusal that revokes (reuse, expiry, an inactive user) is DECIDED inside
   * the transaction and RAISED after it commits. Throwing inside the
   * `withScopedDb` callback rolled back the very revocation the refusal
   * reported, so a thief's successor stayed live after its reuse was detected
   * (A26-H01). Only the unknown-token branch, which writes nothing, throws
   * inside.
   *
   * `refreshToken` is `null` when the presented token is the immediate
   * predecessor of a successor minted within `ROTATION_GRACE_SECONDS`: two tabs
   * of one browser sent the same cookie a moment apart (A26-M03). That answer
   * is an access token only; the caller keeps the refresh cookie the first
   * response set, and nothing is revoked or minted.
   */
  async refreshTokens(rawRefreshToken: string): Promise<{
    accessToken: string;
    refreshToken: string | null;
    userId: string;
  }> {
    const tokenHash = hashToken(rawRefreshToken);

    const outcome = await withScopedDb<RefreshOutcome>(
      this.dataSource,
      async (manager) => {
        // SECURITY: the family lock comes FIRST, before any row lock, and this
        // unlocked read exists only to learn which family to lock.
        //
        // The family lock is what makes revocation whole. Revocation is an `UPDATE
        // ... WHERE family_id = ?`, and under READ COMMITTED that statement uses
        // one snapshot: blocked on the old row, it waits, updates it -- and never
        // sees the replacement this rotation inserted *after* the snapshot was
        // taken. Logout returned success with a usable token still in the family
        // (audit P4-011).
        //
        // The order is not incidental. Taking the row lock first and the family
        // lock second would deadlock against `revokeAllUserRefreshTokens`, which
        // holds families and then wants rows. Family-then-rows, everywhere.
        // `family_id` never changes for a token row, so reading it unlocked is
        // safe -- everything the decisions below rest on is re-read under the lock.
        const familyProbe = await manager.findOne(RefreshToken, {
          where: { tokenHash },
          select: { familyId: true },
        });

        if (!familyProbe) {
          throw new UnauthorizedException(
            tr("errors.auth.invalidRefreshToken", "Invalid refresh token"),
          );
        }

        await lockTokenFamily(manager, familyProbe.familyId);

        // Re-read under the row lock, now that the family is held: this is the
        // version the rotation replaces.
        const existingToken = await manager.findOne(RefreshToken, {
          where: { tokenHash },
          lock: { mode: "pessimistic_write" },
        });

        if (!existingToken) {
          throw new UnauthorizedException(
            tr("errors.auth.invalidRefreshToken", "Invalid refresh token"),
          );
        }

        // Replay detection: a revoked token presented again is reuse, and the
        // whole family dies -- unless it is the immediate predecessor of a live
        // successor minted within the grace (a second tab, not a thief).
        const inGrace =
          existingToken.isRevoked &&
          (await this.hasGraceSuccessor(manager, existingToken));
        if (existingToken.isRevoked && !inGrace) {
          await manager.update(
            RefreshToken,
            { familyId: existingToken.familyId },
            { isRevoked: true },
          );
          return refused(
            tr(
              "errors.auth.refreshTokenReuseDetected",
              "Refresh token reuse detected",
            ),
          );
        }

        if (!inGrace && existingToken.expiresAt < new Date()) {
          existingToken.isRevoked = true;
          await manager.save(existingToken);
          return refused(
            tr("errors.auth.refreshTokenExpired", "Refresh token expired"),
          );
        }

        const user = await manager.findOne(User, {
          where: { id: existingToken.userId },
        });

        if (!user || !user.isActive) {
          await manager.update(
            RefreshToken,
            { familyId: existingToken.familyId },
            { isRevoked: true },
          );
          return refused(
            tr(
              "errors.auth.userNotFoundOrInactive",
              "User not found or inactive",
            ),
          );
        }

        if (inGrace) {
          return {
            kind: "issued",
            accessToken: this.signAccessToken(user, existingToken),
            refreshToken: null,
            userId: user.id,
          };
        }

        // Rotate: generate new refresh token in the same family
        const newRawRefreshToken = crypto.randomBytes(64).toString("hex");
        const newTokenHash = hashToken(newRawRefreshToken);

        existingToken.isRevoked = true;
        existingToken.replacedByHash = newTokenHash;
        await manager.save(existingToken);

        const rotatedExpiryMs = this.getRefreshExpiryMs(
          existingToken.rememberMe,
        );
        const newRefreshTokenEntity = manager.create(RefreshToken, {
          userId: user.id,
          tokenHash: newTokenHash,
          familyId: existingToken.familyId,
          isRevoked: false,
          expiresAt: new Date(Date.now() + rotatedExpiryMs),
          replacedByHash: null,
          rememberMe: existingToken.rememberMe,
          // Carry the delegate "acting as owner" context forward through
          // rotation so the context survives access-token expiry.
          actingAsUserId: existingToken.actingAsUserId ?? null,
          delegationId: existingToken.delegationId ?? null,
        });
        await manager.save(newRefreshTokenEntity);

        return {
          kind: "issued",
          accessToken: this.signAccessToken(user, existingToken),
          refreshToken: newRawRefreshToken,
          userId: user.id,
        };
      },
    );

    // Committed, then refused: for these branches the revocation IS the point.
    if (outcome.kind === "refused") {
      throw new UnauthorizedException(outcome.message);
    }
    return {
      accessToken: outcome.accessToken,
      refreshToken: outcome.refreshToken,
      userId: outcome.userId,
    };
  }

  /**
   * True when `predecessor` was rotated into a successor that is still live
   * and was minted within `ROTATION_GRACE_SECONDS` (so it cannot have expired:
   * the shortest refresh lifetime is a day). Called under the family lock, so
   * no rotation of the successor can interleave.
   *
   * The recency test runs in SQL against the column's own clock
   * (`created_at` defaults to `CURRENT_TIMESTAMP`), so a process time zone that
   * differs from the database's cannot widen or close the window.
   */
  private async hasGraceSuccessor(
    manager: EntityManager,
    predecessor: RefreshToken,
  ): Promise<boolean> {
    if (!predecessor.replacedByHash) return false;
    const rows: unknown[] = await manager.query(
      `SELECT 1 FROM refresh_tokens
        WHERE token_hash = $1 AND family_id = $2 AND is_revoked = false
          AND created_at > CURRENT_TIMESTAMP - make_interval(secs => $3)`,
      [
        predecessor.replacedByHash,
        predecessor.familyId,
        TokenService.ROTATION_GRACE_SECONDS,
      ],
    );
    return rows.length > 0;
  }

  private signAccessToken(user: User, token: RefreshToken): string {
    const payload: Record<string, unknown> = {
      sub: user.id,
      type: ACCESS_TOKEN_TYPE,
      email: user.email,
      authProvider: user.authProvider,
      role: user.role,
    };
    if (token.actingAsUserId && token.delegationId) {
      payload.actingAsUserId = token.actingAsUserId;
      payload.delegationId = token.delegationId;
    }
    return this.jwtService.sign(payload, {
      expiresIn: this.ACCESS_TOKEN_EXPIRY,
    });
  }

  /**
   * Revoke every token in one family, under the family lock.
   *
   * The lock is what makes the guarantee whole. Without it a concurrent rotation
   * could insert a replacement after this statement's snapshot was taken, so the
   * update covered the old row and missed the new one -- and the caller was told
   * the family was revoked.
   */
  async revokeTokenFamily(familyId: string): Promise<void> {
    await withScopedDb(this.dataSource, async (manager) => {
      await lockTokenFamily(manager, familyId);
      await manager
        .getRepository(RefreshToken)
        .update({ familyId }, { isRevoked: true });
    });
  }

  /**
   * Log out: revoke the presented token's whole family.
   *
   * Lookup and revocation are ONE transaction. Two of them let a rotation slip
   * between the read and the family update; the family lock inside
   * `revokeTokenFamily` joins this transaction, so the ordering holds from the
   * lookup onwards.
   */
  async revokeRefreshToken(rawRefreshToken: string): Promise<void> {
    if (!rawRefreshToken) return;
    const tokenHash = hashToken(rawRefreshToken);
    await withScopedDb(this.dataSource, async (manager) => {
      const token = await manager.getRepository(RefreshToken).findOne({
        where: { tokenHash },
      });
      if (!token) return;
      await this.revokeTokenFamily(token.familyId);
    });
  }

  /**
   * Revoke every session this user has open *right now*, whatever family it
   * belongs to.
   *
   * The set of families is captured once, in a first round, and everything below
   * is scoped to exactly those ids. A session opened *after* revocation began --
   * a concurrent login, or a rotation that minted a fresh family -- is a new
   * session the caller never asked to end, so it must survive. The earlier code
   * revoked with a blanket `WHERE user_id = ? AND is_revoked = false`, which is
   * not scoped to the families it gathered and so swept a session that appeared
   * between the read and the update (maintainer review PR #1097, finding 4).
   *
   * Then loops until a pass revokes nothing. One `UPDATE ... WHERE
   * is_revoked = false` has a statement-snapshot blind spot -- a rotation can
   * insert a replacement after the snapshot was taken -- so re-locking the
   * captured families and re-revoking until a pass changes nothing converges: a
   * rotation can only add a replacement inside a family it has just revoked, and
   * the next pass, holding that family's lock, covers it.
   *
   * `keepSessionOf` is the raw refresh token of the session making the request,
   * when that session is to survive: its family is left out of the captured set
   * (resolved by the token's hash, and only among `userId`'s own rows), so "sign
   * out everywhere else" does not sign the caller out too. An unknown or absent
   * token keeps nothing, which is the safe direction.
   *
   * The mechanism is `revokeUserRefreshFamilies` (`./refresh-revocation`), shared
   * with the services that cannot inject this one (users, admin, delegation).
   */
  async revokeAllUserRefreshTokens(
    userId: string,
    keepSessionOf?: string,
  ): Promise<void> {
    await revokeUserRefreshFamilies(
      this.dataSource,
      userId,
      this.logger,
      keepSessionOf,
    );
  }

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async purgeExpiredRefreshTokens(): Promise<void> {
    // RLS (task C2): cross-user bulk purge -- runs under a system context.
    return withSystemContext(() =>
      this.purgeExpiredRefreshTokensWithinContext(),
    );
  }

  private async purgeExpiredRefreshTokensWithinContext(): Promise<void> {
    // Only expired rows: a rotated (revoked) row is the evidence reuse
    // detection needs to revoke the family when a stolen token is replayed.
    const expiredResult = await this.scoped(RefreshToken, (repo) =>
      repo.delete({
        expiresAt: LessThan(new Date()),
      }),
    );

    const totalPurged = expiredResult.affected || 0;
    if (totalPurged > 0) {
      this.logger.log(`Purged ${totalPurged} expired refresh tokens`);
    }
  }
}
