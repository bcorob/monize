import { Logger } from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import { DataSource, EntityManager } from "typeorm";

import { PersonalAccessToken } from "./entities/personal-access-token.entity";
import { TrustedDevice } from "../users/entities/trusted-device.entity";
import { revokeUserRefreshFamilies } from "./refresh-revocation";

/**
 * Injection token for the OAuth provider's "revoke everything for this user".
 * `OAuthModule` binds it to `OAuthProviderService` (`useExisting`). A token
 * rather than the class because importing `oauth-provider.service` from here
 * closes a require cycle (it imports `AuthService`, which imports this file),
 * which leaves a constructor parameter `undefined` at boot
 * (`src/module-graph.spec.ts`).
 */
export const OAUTH_GRANT_REVOKER = "OAUTH_GRANT_REVOKER";

/** The one method of `OAuthProviderService` this file needs. */
export interface OAuthGrantRevoker {
  revokeAllForUser(userId: string): Promise<number>;
}

/**
 * What a replaced password takes with it.
 *
 * Every path that sets a password because the old one may be known to someone
 * else -- the emailed reset link, a change from settings, an admin or owner
 * reset, an emergency-access claim -- and the confirmation of an OIDC account
 * link must end every credential the old holder could still use. Revoking only
 * the web sessions left a personal access token or an MCP client's OAuth grant
 * working for whoever held it, which is the access a reset exists to cut.
 *
 * Four kinds of credential, revoked in two places:
 *
 * 1. **Inside the password write's transaction** (`revokeStandingCredentials`):
 *    personal access tokens and trusted devices. They are ordinary rows under
 *    `withScopedDb`, so they commit or roll back with the new password -- a
 *    refused reset revokes nothing, and a committed one cannot leave them live.
 * 2. **After that commit**: refresh tokens, through the converging revocation
 *    (`TokenService.revokeAllUserRefreshTokens`, or
 *    `revokeRefreshSessionsAfterCommit` below where `TokenService` cannot be
 *    injected; both run several transactions and must not be nested), and the
 *    OAuth provider's
 *    grants and tokens (`revokeOAuthGrantsAfterCommit`), which live in the
 *    provider's own store and are reached only through
 *    `OAuthProviderService.revokeAllForUser`. A failure there is logged at
 *    `error` with the account id and rethrown: the password has changed, so the
 *    caller must not report a clean success, and the log line is what makes the
 *    leftover grant alertable.
 */
export async function revokeStandingCredentials(
  manager: EntityManager,
  userId: string,
): Promise<void> {
  await manager
    .getRepository(PersonalAccessToken)
    .update({ userId, isRevoked: false }, { isRevoked: true });
  // A trusted-device cookie skips the second factor; after a credential
  // rotation it must not outlive the password it was issued alongside.
  await manager.getRepository(TrustedDevice).delete({ userId });
}

/**
 * Revoke every OAuth grant, token and session the provider holds for `userId`.
 * Call it after the password write has committed; see the note above.
 *
 * Resolved lazily through `ModuleRef` (by `OAUTH_GRANT_REVOKER`) because
 * `OAuthModule` imports `AuthModule`, so the modules that own these paths
 * cannot import it back.
 * `userId` is always server-derived (the verified reset or link token's row,
 * the session's subject, the consumed claim), never read from the request.
 */
export async function revokeOAuthGrantsAfterCommit(
  moduleRef: ModuleRef,
  userId: string,
  logger: Logger,
): Promise<void> {
  try {
    const oauth = moduleRef.get<OAuthGrantRevoker>(OAUTH_GRANT_REVOKER, {
      strict: false,
    });
    await oauth.revokeAllForUser(userId);
  } catch (error) {
    logger.error(
      `Credentials for account ${userId} were replaced, but revoking its OAuth ` +
        `grants failed; connected MCP clients may still have access and need ` +
        `revoking by hand`,
      error instanceof Error ? error.stack : String(error),
    );
    throw error;
  }
}

/**
 * End every refresh session `userId` had open, after the credential write
 * committed, converging against a concurrent rotation
 * (`revokeUserRefreshFamilies`). For the paths that cannot inject
 * `TokenService`; the in-transaction blanket UPDATE those paths keep is a
 * first pass only, since it misses a successor inserted after its snapshot.
 *
 * Same failure contract as `revokeOAuthGrantsAfterCommit`: the password has
 * already changed, so a failure is logged at `error` with the account id and
 * rethrown, never reported as a clean reset.
 */
export async function revokeRefreshSessionsAfterCommit(
  dataSource: DataSource,
  userId: string,
  logger: Logger,
): Promise<void> {
  try {
    await revokeUserRefreshFamilies(dataSource, userId, logger);
  } catch (error) {
    logger.error(
      `Credentials for account ${userId} were replaced, but revoking its ` +
        `refresh sessions failed; signed-in browsers may still have access and ` +
        `need revoking by hand`,
      error instanceof Error ? error.stack : String(error),
    );
    throw error;
  }
}
