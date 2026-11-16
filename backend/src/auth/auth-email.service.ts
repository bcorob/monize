import { Injectable, BadRequestException, Logger } from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import {
  DataSource,
  EntityTarget,
  MoreThan,
  ObjectLiteral,
  Repository,
} from "typeorm";
import { ConfigService } from "@nestjs/config";
import { withScopedDb } from "../common/db/scoped-db";
import * as bcrypt from "bcryptjs";
import * as crypto from "crypto";

import { User } from "../users/entities/user.entity";
import { hashToken } from "./crypto.util";
import { PasswordBreachService } from "./password-breach.service";
import {
  localPasswordUsable,
  oidcPasswordLoginAllowed,
} from "./oidc/oidc-password-login";
import { tr } from "../i18n/translate";
import { TokenService } from "./token.service";
import { AuthAttemptCounterService } from "./auth-attempt-counter.service";
import {
  emailInUseConflict,
  isUniqueViolation,
} from "../users/email-change.util";
import {
  revokeOAuthGrantsAfterCommit,
  revokeStandingCredentials,
} from "./credential-revocation";

/**
 * `auth_attempt_counters.scope` for the two per-email throttles.
 *
 * The key is `sha256(lowercased, trimmed email)`. The table has no owner column
 * and is RLS-exempt, so a plaintext key would make it a directory of who has
 * asked for a password reset -- which is precisely the enumeration these two
 * endpoints answer generically to avoid.
 */
export const FORGOT_PASSWORD_SCOPE = "forgot-password";
export const VERIFICATION_EMAIL_SCOPE = "verification-email";

@Injectable()
export class AuthEmailService {
  private readonly logger = new Logger(AuthEmailService.name);

  // M7: Per-email rate limiting for forgot-password
  private readonly FORGOT_PASSWORD_EMAIL_LIMIT = 3;
  private readonly FORGOT_PASSWORD_EMAIL_WINDOW_MS = 60 * 60 * 1000; // 1 hour
  // Per-email rate limiting for resending the verification email. Shares the
  // same window/limit shape as forgot-password to throttle abuse.
  private readonly VERIFICATION_EMAIL_LIMIT = 3;
  private readonly VERIFICATION_EMAIL_WINDOW_MS = 60 * 60 * 1000; // 1 hour

  constructor(
    private readonly dataSource: DataSource,
    private passwordBreachService: PasswordBreachService,
    private tokenService: TokenService,
    private readonly attemptCounters: AuthAttemptCounterService,
    private readonly moduleRef: ModuleRef,
    private readonly configService: ConfigService,
  ) {}

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

  /**
   * Count this address's use of one throttled endpoint and say whether it may
   * proceed.
   *
   * One statement decides it, so N replicas enforce one limit and a restart no
   * longer hands the sender a fresh three. The window is not extended by a
   * refused attempt: `increment` keeps `window_expires_at` as the first attempt
   * set it, which is the behaviour the `windowStart` field had.
   */
  private async withinEmailLimit(
    scope: string,
    email: string,
    limit: number,
    windowMs: number,
  ): Promise<boolean> {
    const { count } = await this.attemptCounters.increment(
      scope,
      hashToken(email.toLowerCase().trim()),
      windowMs,
      // "fixed", which is what the `windowStart` field did: a refused send does
      // not push the window out, so three sends per hour stays three sends per
      // hour however they are spaced.
      "fixed",
    );
    return count <= limit;
  }

  async generateResetToken(
    email: string,
  ): Promise<{ user: User; token: string } | null> {
    const user = await this.scoped(User, (repo) =>
      repo.findOne({
        where: { email },
      }),
    );

    if (
      !user ||
      !localPasswordUsable(user, oidcPasswordLoginAllowed(this.configService))
    ) {
      return null;
    }

    const rawResetToken = crypto.randomBytes(32).toString("hex");
    const resetTokenExpiry = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    // SECURITY: Store hashed token
    user.resetToken = hashToken(rawResetToken);
    user.resetTokenExpiry = resetTokenExpiry;
    await this.scoped(User, (repo) => repo.save(user));

    return { user, token: rawResetToken };
  }

  async resetPassword(token: string, newPassword: string): Promise<void> {
    // Check for breached password
    const isBreached = await this.passwordBreachService.isBreached(newPassword);
    if (isBreached) {
      throw new BadRequestException(
        tr(
          "errors.auth.passwordBreached",
          "This password has been found in a data breach. Please choose a different password.",
        ),
      );
    }

    // SECURITY: Hash the incoming token to compare against stored hash
    const hashedToken = hashToken(token);

    const saltRounds = 12;
    const passwordHash = await bcrypt.hash(newPassword, saltRounds);

    // M11: Atomic UPDATE...WHERE to prevent TOCTOU race condition. The
    // standing credentials go in the same transaction, so an invalid token
    // revokes nothing and a committed reset cannot leave a PAT or a trusted
    // device behind it (`credential-revocation.ts`).
    // A token minted before SSO sign-in was restricted is refused like an
    // invalid one: the policy `generateResetToken` applies at issue time.
    const oidcAllowed = oidcPasswordLoginAllowed(this.configService);
    const userId = await withScopedDb(this.dataSource, async (manager) => {
      const result = await manager
        .getRepository(User)
        .createQueryBuilder()
        .update(User)
        .set({
          passwordHash,
          resetToken: null,
          resetTokenExpiry: null,
          // Proving control of the mailbox is the recovery path out of a
          // lockout: without this, anyone who knew the address could keep the
          // owner locked out by failing a password once per lock window.
          failedLoginAttempts: 0,
          lockedUntil: null,
        })
        .where("resetToken = :hashedToken", { hashedToken })
        .andWhere(
          "resetTokenExpiry > :now AND (authProvider <> 'oidc' OR :oidcAllowed = true)",
          { now: new Date(), oidcAllowed },
        )
        .returning("id")
        .execute();

      if (!result.affected || result.affected === 0) {
        throw new BadRequestException(
          tr(
            "errors.auth.invalidOrExpiredResetToken",
            "Invalid or expired reset token",
          ),
        );
      }

      const id: string | undefined = result.raw?.[0]?.id;
      if (id) {
        await revokeStandingCredentials(manager, id);
      }
      return id;
    });

    // After the commit: every session on every device, then the OAuth grants
    // an MCP client holds -- a reset that left either live would hand the
    // account straight back to whoever the owner was locking out.
    if (userId) {
      await this.tokenService.revokeAllUserRefreshTokens(userId);
      await revokeOAuthGrantsAfterCommit(this.moduleRef, userId, this.logger);
    }
  }

  checkForgotPasswordEmailLimit(email: string): Promise<boolean> {
    return this.withinEmailLimit(
      FORGOT_PASSWORD_SCOPE,
      email,
      this.FORGOT_PASSWORD_EMAIL_LIMIT,
      this.FORGOT_PASSWORD_EMAIL_WINDOW_MS,
    );
  }

  /**
   * Mint a fresh email-verification token for an unverified local account.
   * Returns null (and writes nothing) when no matching unverified account
   * exists, so callers can return a generic success to prevent enumeration.
   * Only the hashed token is stored; the raw value is returned for the link.
   */
  async generateVerificationToken(
    email: string,
  ): Promise<{ user: User; token: string } | null> {
    const normalizedEmail = email.toLowerCase().trim();
    const user = await this.scoped(User, (repo) =>
      repo.findOne({
        where: { email: normalizedEmail },
      }),
    );

    // Nothing to do for unknown emails or accounts that are already verified.
    if (!user || user.emailVerified) return null;

    const rawToken = crypto.randomBytes(32).toString("hex");
    user.emailVerificationToken = hashToken(rawToken);
    user.emailVerificationTokenExpiry = new Date(
      Date.now() + 24 * 60 * 60 * 1000, // 24 hours
    );
    await this.scoped(User, (repo) => repo.save(user));

    return { user, token: rawToken };
  }

  /**
   * Mark the account owning the given verification token as verified. Uses an
   * atomic UPDATE...WHERE (mirroring resetPassword) so a single click wins and
   * the token cannot be replayed once consumed.
   */
  async verifyEmail(token: string): Promise<void> {
    const hashedToken = hashToken(token);

    const result = await this.scoped(User, (repo) =>
      repo
        .createQueryBuilder()
        .update(User)
        .set({
          emailVerified: true,
          emailVerificationToken: null,
          emailVerificationTokenExpiry: null,
        })
        .where("emailVerificationToken = :hashedToken", { hashedToken })
        .andWhere("emailVerificationTokenExpiry > :now", { now: new Date() })
        .execute(),
    );

    if (!result.affected || result.affected === 0) {
      throw new BadRequestException(
        tr(
          "errors.auth.invalidOrExpiredEmailVerificationToken",
          "Invalid or expired verification link",
        ),
      );
    }
  }

  /**
   * Apply the self-service email change owning `token` (staged by
   * `EmailChangeService` when the change was requested).
   *
   * One transaction: find the live pending change, refuse when another account
   * already holds the address, then the conditional UPDATE, which is what makes
   * the link single-use -- it matches only while the stored hash and expiry are
   * still those the lookup saw, so a second click, a newer request that
   * replaced the token, or an expired link all update nothing. The unique index
   * on `users.email` decides a race the in-transaction check cannot see, and is
   * answered as the same 409, never a 500. Other sessions are signed out after
   * the commit, as a password reset does.
   */
  async confirmEmailChange(token: string): Promise<void> {
    const hashedToken = hashToken(token);
    const invalid = () =>
      new BadRequestException(
        tr(
          "errors.auth.invalidOrExpiredEmailChangeToken",
          "Invalid or expired email change link",
        ),
      );

    let userId: string;
    try {
      userId = await withScopedDb(this.dataSource, async (manager) => {
        const repo = manager.getRepository(User);
        const now = new Date();
        const pending = await repo.findOne({
          where: {
            emailChangeToken: hashedToken,
            emailChangeTokenExpiry: MoreThan(now),
          },
        });
        if (!pending || !pending.pendingEmail) throw invalid();
        const newEmail = pending.pendingEmail;

        const holder = await repo.findOne({ where: { email: newEmail } });
        if (holder && holder.id !== pending.id) throw emailInUseConflict();

        const result = await repo
          .createQueryBuilder()
          .update(User)
          .set({
            email: newEmail,
            emailVerified: true,
            pendingEmail: null,
            emailChangeToken: null,
            emailChangeTokenExpiry: null,
          })
          .where("id = :id", { id: pending.id })
          .andWhere("emailChangeToken = :hashedToken", { hashedToken })
          .andWhere("emailChangeTokenExpiry > :now", { now })
          .execute();
        if (!result.affected) throw invalid();
        return pending.id;
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw emailInUseConflict();
      throw error;
    }

    await this.tokenService.revokeAllUserRefreshTokens(userId);
  }

  checkVerificationEmailLimit(email: string): Promise<boolean> {
    return this.withinEmailLimit(
      VERIFICATION_EMAIL_SCOPE,
      email,
      this.VERIFICATION_EMAIL_LIMIT,
      this.VERIFICATION_EMAIL_WINDOW_MS,
    );
  }
}
