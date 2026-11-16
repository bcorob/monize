import { EntityManager } from "typeorm";

import { restrictToAccountScope } from "../delegation/delegate-account-scope.util";
import { Transaction } from "../transactions/entities/transaction.entity";
import { LinkedTransaction } from "./dto/warranty-response.dto";
import { Warranty } from "./entities/warranty.entity";

/**
 * The purchases the rows link to, keyed by transaction id, in one read.
 * This is the only place a warranty reaches its purchase for a reader
 * (WTY-007): an acting delegate's `accountScope` narrows the read to the
 * accounts their delegation grants READ on, so a purchase in any other
 * account is simply absent from the map, and an empty scope reads nothing.
 * `undefined` is the owner and narrows nothing.
 */
export async function loadLinkedTransactions(
  m: EntityManager,
  userId: string,
  rows: readonly Pick<Warranty, "transactionId">[],
  accountScope: readonly string[] | undefined,
): Promise<Map<string, LinkedTransaction>> {
  const linked = new Map<string, LinkedTransaction>();
  const transactionIds = [
    ...new Set(
      rows
        .map((row) => row.transactionId)
        .filter((id): id is string => id !== null),
    ),
  ];
  if (transactionIds.length === 0 || accountScope?.length === 0) {
    return linked;
  }
  const qb = m
    .getRepository(Transaction)
    .createQueryBuilder("t")
    .leftJoin("t.payee", "p")
    .select([
      "t.id",
      "t.transactionDate",
      "t.payeeName",
      "t.amount",
      "t.currencyCode",
      "t.accountId",
      "p.id",
      "p.name",
    ])
    .where("t.id IN (:...transactionIds)", { transactionIds })
    .andWhere("t.user_id = :userId", { userId });
  const transactions = await restrictToAccountScope(
    qb,
    "t.account_id",
    accountScope,
  ).getMany();
  for (const t of transactions) {
    linked.set(t.id, {
      id: t.id,
      transactionDate: t.transactionDate,
      payeeName: t.payeeName ?? t.payee?.name ?? null,
      amount: Number(t.amount),
      currencyCode: t.currencyCode,
      accountId: t.accountId,
    });
  }
  return linked;
}

/**
 * Whether the caller's purchase `transactionId` sits in an account the
 * scope admits, read through `restrictToAccountScope` exactly as
 * `loadLinkedTransactions` narrows the purchase itself (WTY-007). An empty
 * scope admits nothing and reads nothing. Only `WarrantiesService.findAll`'s
 * `transactionId` filter asks, and only for a delegate.
 */
export async function isTransactionInScope(
  m: EntityManager,
  userId: string,
  transactionId: string,
  accountScope: readonly string[],
): Promise<boolean> {
  if (accountScope.length === 0) return false;
  const qb = m
    .getRepository(Transaction)
    .createQueryBuilder("t")
    .select("t.id")
    .where("t.id = :transactionId", { transactionId })
    .andWhere("t.user_id = :userId", { userId });
  return restrictToAccountScope(qb, "t.account_id", accountScope).getExists();
}
