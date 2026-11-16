import { EntityManager } from "typeorm";
import { RuleApplicationRow } from "./rule-run.types";
import { TransactionRuleApplication } from "./transaction-rule-application.entity";

/**
 * The latest applications of one rule, newest first, each with the row it
 * changed (date, payee, amount), for the trace view. One query: the
 * transaction is joined, not fetched per row.
 */
export async function loadRuleApplications(
  m: EntityManager,
  userId: string,
  ruleId: string,
  take: number,
): Promise<RuleApplicationRow[]> {
  const rows = await m
    .getRepository(TransactionRuleApplication)
    .createQueryBuilder("application")
    .innerJoinAndSelect("application.transaction", "transaction")
    .where("application.userId = :userId", { userId })
    .andWhere("application.ruleId = :ruleId", { ruleId })
    .orderBy("application.appliedAt", "DESC")
    .addOrderBy("application.id", "DESC")
    .take(take)
    .getMany();
  return rows.map((row) => ({
    id: row.id,
    transactionId: row.transactionId,
    date: row.transaction?.transactionDate ?? "",
    payeeName: row.transaction?.payeeName ?? null,
    amount: Number(row.transaction?.amount ?? 0),
    currencyCode: row.transaction?.currencyCode ?? "",
    source: row.source,
    changes: row.changes,
    appliedAt: row.appliedAt,
  }));
}
