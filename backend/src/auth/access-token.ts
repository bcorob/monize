/**
 * The `type` claim of an access token.
 *
 * One `JWT_SECRET` signs every token this server mints (access, `2fa_pending`,
 * `step_up`, the OIDC re-auth marker and artifact), so a verifier that only
 * deny-lists the types it knows accepts every type it does not. A step-up
 * token or a re-auth artifact is readable by page script, and accepted as a
 * Bearer access token it became a five-minute credential usable off-origin
 * (A26-L06). An access token therefore carries a positive type, and every
 * verifier that authenticates a request with one accepts only that type.
 */
export const ACCESS_TOKEN_TYPE = "access";

/**
 * True for an access token's payload.
 *
 * A payload with no `type` is accepted too, for one release: access tokens
 * minted before the claim existed live 15 minutes, and refusing them would
 * sign every session out across a rolling deploy. Remove the `undefined` arm in
 * the release after the one that added `ACCESS_TOKEN_TYPE`.
 */
export function isAccessTokenPayload(
  payload: { type?: unknown } | null | undefined,
): boolean {
  if (!payload) return false;
  return payload.type === ACCESS_TOKEN_TYPE || payload.type === undefined;
}
