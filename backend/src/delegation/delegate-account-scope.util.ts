import { ObjectLiteral, SelectQueryBuilder } from "typeorm";
import { DelegationService } from "./delegation.service";

/** The request fields the scope reads, set by JwtStrategy from the token. */
export interface DelegateScopeRequest {
  user: { isActing?: boolean; delegationId?: string | null };
}

/**
 * The accounts a request may read, or `undefined` when nothing narrows it (an
 * owner, or any own-context request). An acting delegate gets exactly the
 * accounts their delegation grants READ on -- possibly none, which a caller
 * must treat as "no rows", never as "no filter".
 */
export async function delegateReadableAccountScope(
  req: DelegateScopeRequest,
  delegationService: Pick<DelegationService, "readableAccountIds">,
): Promise<string[] | undefined> {
  if (!req.user.isActing) return undefined;
  if (!req.user.delegationId) return [];
  return delegationService.readableAccountIds(req.user.delegationId);
}

/**
 * Narrow a query to an account scope from `delegateReadableAccountScope`:
 * `undefined` leaves it unchanged, and an empty scope matches nothing.
 */
export function restrictToAccountScope<T extends ObjectLiteral>(
  qb: SelectQueryBuilder<T>,
  column: string,
  scope: readonly string[] | undefined,
): SelectQueryBuilder<T> {
  if (scope === undefined) return qb;
  if (scope.length === 0) return qb.andWhere("1 = 0");
  return qb.andWhere(`${column} IN (:...delegateScopeAccountIds)`, {
    delegateScopeAccountIds: [...scope],
  });
}
