import { Injectable, Logger, UnauthorizedException } from "@nestjs/common";
import * as jwt from "jsonwebtoken";
import * as crypto from "crypto";
import { DataSource } from "typeorm";
import { withScopedDb } from "../../common/db/scoped-db";
import { tr } from "../../i18n/translate";

/**
 * Cryptographic re-authentication for OIDC accounts.
 *
 * The destructive surfaces -- account deletion, data deletion, backup restore,
 * and the .mny import's wipe-first mode -- each require a second proof of
 * identity beyond the session. For a local account that is the password. For an
 * OIDC account there is no Monize-managed password, and the previous
 * implementation resolved that by testing whether a client-supplied string was
 * non-empty: the frontend sent the literal `"oidc-session-confirmed"`, the
 * backend accepted anything, and the specs pinned the sentinel as expected
 * behaviour (P2-005). The second proof collapsed into possession of the first,
 * so a stolen-but-valid session that could satisfy CSRF could restore over,
 * delete the data of, or delete outright any OIDC account.
 *
 * What replaces it: the server sends the user through the identity provider with
 * `prompt=login`, and the OIDC callback -- which already verifies state, nonce,
 * issuer, audience and signature through `openid-client` -- mints a short-lived
 * artifact bound to the user id, the intended action, and a one-time id. The
 * destructive handler consumes it. Every property the audit asked for is
 * checked: signature, type, subject, action, freshness, single use.
 *
 * The client never mints it and cannot forge it, because it is signed with
 * JWT_SECRET, which is exactly the property the sentinel lacked.
 *
 * Signing goes through `jsonwebtoken` directly rather than Nest's `JwtService`
 * so this class does not depend on `AuthModule`'s providers. That is what lets
 * `UsersModule` provide it without importing `AuthModule` -- which it cannot,
 * the two are mutually dependent through `NotificationsModule` (see the
 * module's own comment about `PasswordBreachService`). The one injected
 * dependency is TypeORM's `DataSource`, which the global `TypeOrmModule`
 * resolves in every module, so re-providing this class stays cheap.
 *
 * Replay: a consumed `jti` is a row in `oidc_step_up_claims`, not a field in
 * this process. A `Map` enforces single use inside one Node process, and this
 * repo explicitly deploys with several backend replicas -- two destructive
 * requests carrying the same artifact could be routed to different replicas,
 * each find its own map empty, and both proceed; with N replicas the same
 * artifact was accepted up to N times under favourable routing. `INSERT ... ON
 * CONFLICT DO NOTHING` on the primary key is atomic across every replica:
 * whoever inserts the row has spent the artifact, and everyone else gets zero
 * rows back and is refused.
 */

/** The actions an OIDC re-authentication artifact can be minted for. */
export const OIDC_REAUTH_PURPOSES = [
  "delete-account",
  "delete-data",
  "restore-backup",
  "import-wipe",
  "emergency-access",
] as const;

export type OidcReauthPurpose = (typeof OIDC_REAUTH_PURPOSES)[number];

export function isOidcReauthPurpose(
  value: unknown,
): value is OidcReauthPurpose {
  return (
    typeof value === "string" &&
    (OIDC_REAUTH_PURPOSES as readonly string[]).includes(value)
  );
}

/** Five minutes: long enough to finish the action, short enough to be useless later. */
export const OIDC_REAUTH_TTL_SECONDS = 5 * 60;

/**
 * Clock-drift tolerance, in seconds, applied to `auth_time` comparisons in both
 * directions -- a genuine fresh authentication can report a timestamp a little
 * before the flow start (our clock ahead of the IdP's) or a little after `now`.
 */
export const OIDC_AUTH_TIME_SKEW_SECONDS = 60;

/**
 * Whether the provider's asserted authentication happened in response to
 * *this* re-authentication challenge.
 *
 * The authorization request sends `prompt=login` and `max_age=0`, but a
 * parameter is a request, not a property: providers honour them unevenly, and
 * one holding a live SSO session can answer the redirect with no credential
 * prompt at all. `auth_time` is the claim that reports what actually happened,
 * so the callback checks it before minting anything -- otherwise the
 * "re-authenticate to continue" step can be satisfied by an unattended browser
 * whose session was simply still warm.
 *
 * Freshness is anchored to when the flow began -- the pending marker's `iat` --
 * not to `now`. Anchoring to `now` with a fixed window was the subtle hole: a
 * user who authenticated a few minutes ago for something unrelated leaves a
 * warm session, and a non-compliant provider answers our `prompt=login` from it
 * with that *earlier* login's `auth_time`. That timestamp is recent enough to
 * sit inside any now-relative window, so the check passed exactly against the
 * providers it exists to defend against. Requiring `auth_time` at or after the
 * flow start refuses it: a genuine fresh challenge authenticates during the
 * round trip, so its `auth_time` cannot precede the flow.
 *
 * A provider that omits the claim has not answered the question, so an absent
 * or malformed `auth_time` is "not fresh" rather than "fine". A small skew
 * absorbs clock drift between us and the IdP in both directions.
 */
export function isFreshAuthentication(
  authTime: number | undefined,
  flowStartedAt: number,
  now = Date.now(),
): boolean {
  if (typeof authTime !== "number" || !Number.isFinite(authTime)) return false;
  const nowSeconds = Math.floor(now / 1000);
  // Implausibly in the future is a provider we cannot reason about: fail closed.
  if (authTime > nowSeconds + OIDC_AUTH_TIME_SKEW_SECONDS) return false;
  return authTime >= flowStartedAt - OIDC_AUTH_TIME_SKEW_SECONDS;
}

const TOKEN_TYPE = "oidc_reauth";

interface OidcReauthPayload {
  sub: string;
  type: string;
  purpose: string;
  jti: string;
  exp?: number;
}

/** Payload of the pending-reauth cookie set before the IdP redirect. */
interface PendingReauthPayload {
  sub: string;
  type: string;
  purpose: string;
  /** SHA-256 of the `state` this marker was minted alongside. See `flowHash`. */
  sth?: string;
  /** Issued-at, seconds. Set by `jwt.sign`; the flow-start anchor for freshness. */
  iat?: number;
  exp?: number;
}

const PENDING_TYPE = "oidc_reauth_pending";

const ALGORITHM = "HS256" as const;

/**
 * Resolved per call rather than cached: `JwtStrategy` already refuses to start
 * without a JWT_SECRET of at least 32 characters, so by the time any of this runs
 * the value exists -- but reading it fresh keeps this class free of construction
 * order assumptions.
 */
function secret(): string {
  const value = process.env.JWT_SECRET;
  if (!value) {
    throw new Error("JWT_SECRET is required to sign OIDC re-authentication");
  }
  return value;
}

/** How long the user has to complete the IdP round trip. */
export const OIDC_REAUTH_PENDING_TTL_SECONDS = 10 * 60;

/**
 * Identity of one authorization round trip, as the marker records it.
 *
 * The `state` is the only value that is unique to a single redirect and comes
 * back through the provider, so it is what a marker has to be tied to. Hashed
 * rather than stored raw: a JWT payload is readable by anyone holding the
 * cookie, and there is no reason for the marker to repeat a value the caller
 * would otherwise have to have kept.
 */
function flowHash(state: string): string {
  return crypto.createHash("sha256").update(state).digest("hex");
}

/**
 * A present, non-empty string, as a type guard.
 *
 * The header arrives typed `string | undefined` but is really `unknown` -- a
 * repeated header gives an array -- so the runtime check has to stay. Written as
 * a guard on `value` rather than inline on the artifact so `consume` reads as one
 * predicate, and so the narrowing removes the `token as string` cast that
 * followed it.
 */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Compare two `flowHash` digests without leaking where they diverge (CWE-208).
 *
 * `!==` on hex strings returns as soon as a character differs, so the time it
 * takes reports the length of the shared prefix -- and the caller controls one
 * side of the comparison via the marker cookie, so it can be probed. That is a
 * narrow lever, since forging a match also needs a preimage of the `state` this
 * hash was taken of, but constant time here costs nothing and the alternative is
 * an argument rather than a property.
 *
 * Equal-length inputs are required by `timingSafeEqual`, so a length mismatch is
 * answered first -- it is not a secret: both sides are SHA-256 hex, and anything
 * else is malformed input rather than a near miss.
 */
function flowHashMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

@Injectable()
export class OidcReauthService {
  private readonly logger = new Logger(OidcReauthService.name);

  constructor(private readonly dataSource: DataSource) {}

  /**
   * Claim a `jti`, atomically and across every replica.
   *
   * Returns true only for the caller whose INSERT actually created the row.
   * Expired rows are swept in the same call rather than by a timer -- but the
   * sweep runs under this request's scoped context, so under `RLS_MODE=on` the
   * isolation policy limits the DELETE to *this user's* expired rows; at
   * `RLS_MODE=off` (the default) it removes every expired row. Single-use
   * safety never depends on the sweep -- the primary-key conflict is what
   * enforces it -- so an expired row belonging to a user who never steps up
   * again is only harmless table growth, not a correctness risk. A
   * system-context retention job is the place to bound that growth; this
   * statement is best-effort housekeeping.
   *
   * `userId` must be the ambient scoped identity -- `consume` enforces
   * `payload.sub === userId` and every caller runs it as `req.user.id`, so the
   * INSERT's `user_id` matches `app_current_user_id()` and the isolation
   * policy's `WITH CHECK` passes. A caller that ever passed a different id would
   * trip that check and surface as a 500 rather than the clean 401 path; keep
   * the two the same principal.
   */
  private async claimJti(
    jti: string,
    userId: string,
    purpose: OidcReauthPurpose,
    expiresAt: Date,
  ): Promise<boolean> {
    return withScopedDb(this.dataSource, async (m) => {
      await m.query(
        `DELETE FROM oidc_step_up_claims WHERE expires_at <= now()`,
      );
      const result: { jti: string }[] = await m.query(
        `INSERT INTO oidc_step_up_claims (jti, user_id, purpose, expires_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (jti) DO NOTHING
         RETURNING jti`,
        [jti, userId, purpose, expiresAt],
      );
      return result.length > 0;
    });
  }

  /**
   * Signed marker that this user started a re-authentication for this action,
   * in *this* authorization round trip.
   *
   * Carried in an httpOnly cookie across the IdP round trip. Signed rather than
   * a plain value because the callback trusts it to decide *which* action the
   * artifact it mints is for: an attacker who could rewrite the cookie would
   * turn a re-auth for a harmless purpose into one for account deletion.
   *
   * `state` binds it to one redirect. Without that binding the marker only says
   * "a re-authentication was started", and any later callback for the same user
   * satisfies it -- including the ordinary login callback, which does not ask the
   * provider to challenge the user at all (FV-001).
   */
  createPendingMarker(
    userId: string,
    purpose: OidcReauthPurpose,
    state: string,
  ): string {
    return jwt.sign(
      { sub: userId, type: PENDING_TYPE, purpose, sth: flowHash(state) },
      secret(),
      {
        algorithm: ALGORITHM,
        expiresIn: OIDC_REAUTH_PENDING_TTL_SECONDS,
      },
    );
  }

  /**
   * Read a pending marker, or null when it is absent, expired, tampered with,
   * belongs to a different user than the one the IdP just authenticated, or was
   * minted for a different round trip than the one completing now.
   *
   * `state` is the state this callback actually validated. A marker with no
   * `sth` claim is refused rather than accepted on the older two checks: an
   * unbindable marker is exactly the case this binding exists to close, so a
   * cookie left over from a previous build has to fail closed.
   */
  readPendingMarker(
    marker: string | undefined,
    authenticatedUserId: string,
    state: string | undefined,
  ): { purpose: OidcReauthPurpose; flowStartedAt: number } | null {
    if (!marker) return null;
    let payload: PendingReauthPayload;
    try {
      payload = jwt.verify(marker, secret(), {
        algorithms: [ALGORITHM],
      }) as PendingReauthPayload;
    } catch {
      return null;
    }
    if (payload.type !== PENDING_TYPE) return null;
    if (payload.sub !== authenticatedUserId) {
      // The session that started the re-auth is not the account that came back
      // from the provider. Minting here would hand user A an artifact for a
      // round trip user B completed.
      this.logger.warn(
        `OIDC re-auth marker rejected: started by ${payload.sub}, provider ` +
          `authenticated ${authenticatedUserId}`,
      );
      return null;
    }
    if (
      !payload.sth ||
      !state ||
      !flowHashMatches(payload.sth, flowHash(state))
    ) {
      // The marker outlived the redirect it was minted for. The reachable case is
      // a second authorization request overwriting `oidc_state` while the marker
      // cookie survives -- an ordinary `GET /auth/oidc` does exactly that, and it
      // sends no `prompt=login`, so the provider may answer it from an existing
      // SSO session without challenging anyone.
      this.logger.warn(
        `OIDC re-auth marker rejected for user ${authenticatedUserId}: ` +
          `minted for a different authorization request`,
      );
      return null;
    }
    if (!isOidcReauthPurpose(payload.purpose)) return null;
    if (typeof payload.iat !== "number") {
      // Every marker we mint carries an `iat` (jwt.sign adds it), and freshness
      // is anchored to it. A marker without one is not something we issued, so
      // fail closed rather than mint with no flow-start reference.
      this.logger.warn(
        `OIDC re-auth marker rejected for user ${authenticatedUserId}: ` +
          "no iat, so the flow start is unknown",
      );
      return null;
    }
    return { purpose: payload.purpose, flowStartedAt: payload.iat };
  }

  /**
   * Mint the artifact. Only ever called from the OIDC callback, after
   * `openid-client` has verified the authorization code exchange (state, nonce,
   * issuer, audience, signature) and after the subject has been matched to this
   * account.
   */
  issue(userId: string, purpose: OidcReauthPurpose): string {
    this.logger.log(
      `OIDC re-authentication issued for user ${userId} purpose ${purpose}`,
    );
    return jwt.sign(
      { sub: userId, type: TOKEN_TYPE, purpose, jti: crypto.randomUUID() },
      secret(),
      { algorithm: ALGORITHM, expiresIn: OIDC_REAUTH_TTL_SECONDS },
    );
  }

  /**
   * Verify and spend an artifact, or throw.
   *
   * Every rejection is the same `401` with the same message: which of the checks
   * failed is a fact about the server's secrets and state, and the caller has no
   * legitimate use for it. The reason goes to the log instead.
   *
   * Spending happens in `oidc_step_up_claims` *before* the caller acts on the
   * answer, so two requests racing on one artifact cannot both be told yes --
   * including when they land on different replicas.
   */
  async consume(
    userId: string,
    purpose: OidcReauthPurpose,
    token: string | undefined,
  ): Promise<void> {
    if (!isNonEmptyString(token)) {
      this.reject(userId, purpose, "no artifact presented");
    }

    let payload: OidcReauthPayload;
    try {
      payload = jwt.verify(token, secret(), {
        algorithms: [ALGORITHM],
      }) as OidcReauthPayload;
    } catch (err) {
      this.reject(
        userId,
        purpose,
        err instanceof jwt.TokenExpiredError ? "expired" : "invalid signature",
      );
    }

    if (payload!.type !== TOKEN_TYPE) {
      // An ordinary access token, a step-up token, or a 2FA-pending token is not
      // a re-authentication: each is minted for a different question.
      this.reject(userId, purpose, `wrong type "${payload!.type}"`);
    }
    if (payload!.sub !== userId) {
      this.reject(userId, purpose, `subject mismatch (${payload!.sub})`);
    }
    if (payload!.purpose !== purpose) {
      // Action binding: an artifact minted to unlock a data deletion must not
      // authorize a restore, which overwrites everything instead.
      this.reject(
        userId,
        purpose,
        `minted for a different action ("${payload!.purpose}")`,
      );
    }
    if (!payload!.jti) {
      this.reject(userId, purpose, "no jti, so it cannot be spent once");
    }
    if (typeof payload!.exp !== "number") {
      // Every artifact we mint carries an `exp` (issue() sets `expiresIn`). A
      // token without one never expires at the JWT layer, so once the sweep
      // dropped its claim row it could be re-claimed -- single use for a token
      // that never dies. Enforce the invariant rather than trust it, in the
      // same spirit as the "no jti" refusal above.
      this.reject(userId, purpose, "no exp, so its lifetime is unbounded");
    }

    const expiresAt = new Date(payload!.exp * 1000);
    const claimed = await this.claimJti(
      payload!.jti,
      userId,
      purpose,
      expiresAt,
    );
    if (!claimed) {
      this.reject(userId, purpose, "already spent");
    }
  }

  private reject(
    userId: string,
    purpose: OidcReauthPurpose,
    reason: string,
  ): never {
    this.logger.warn(
      `OIDC re-authentication rejected for user ${userId} purpose ${purpose}: ${reason}`,
    );
    throw new UnauthorizedException(
      tr(
        "errors.auth.oidcReauthRequired",
        "Re-authenticate with your identity provider to confirm this action.",
      ),
    );
  }
}
