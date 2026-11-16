import { BadRequestException } from "@nestjs/common";
import { EntityManager } from "typeorm";
import { Account } from "../accounts/entities/account.entity";
import { assertTransactionCurrencyMatchesAccount } from "../common/fx-entry.util";
import { tr } from "../i18n/translate";
import { RuleRowInputDto } from "./dto/explain-rule-row.dto";
import { findMissingReferences } from "./rule-references";
import type { RuleRowInput } from "./transaction-rules-applier.service";

const present = (ids: ReadonlyArray<string | null | undefined>): string[] => [
  ...new Set(ids.filter((id): id is string => typeof id === "string")),
];

/**
 * The row a person sent to be tested, turned into the input the rules are
 * planned over, after it has been checked against the caller's own data.
 *
 * - Every account, payee, category and tag it names must be the caller's: the
 *   queries are scoped by `userId`, so another person's id is refused exactly
 *   like one that does not exist (400 `REFERENCE_NOT_FOUND`) and nothing about
 *   it is revealed.
 * - The currency is the account's, never the request's
 *   (`assertTransactionCurrencyMatchesAccount`): a code that differs is refused.
 *
 * Reads only, on the caller's manager. Nothing is written.
 */
export async function checkedRuleRowInput(
  m: EntityManager,
  userId: string,
  dto: RuleRowInputDto,
): Promise<RuleRowInput> {
  const account = await m.getRepository(Account).findOne({
    select: { id: true, currencyCode: true },
    where: { id: dto.accountId, userId },
  });
  const missing = await findMissingReferences(m, userId, {
    accountIds: present([dto.accountId, dto.fromAccountId, dto.toAccountId]),
    payeeIds: present([dto.payeeId]),
    categoryIds: present([dto.categoryId]),
    tagIds: present(dto.tagIds),
  });
  const refused =
    account === null ||
    missing.accountIds.length > 0 ||
    missing.payeeIds.length > 0 ||
    missing.categoryIds.length > 0 ||
    missing.tagIds.length > 0;
  if (refused) {
    throw new BadRequestException({
      message: tr(
        "errors.transactionRules.explainReferenceNotFound",
        "The transaction names an account, payee, category or tag that does not exist",
      ),
      errorCode: "REFERENCE_NOT_FOUND",
    });
  }
  return {
    accountId: dto.accountId,
    currencyCode: assertTransactionCurrencyMatchesAccount(
      dto.currencyCode,
      account.currencyCode,
    ),
    amount: dto.amount ?? null,
    isTransfer: dto.isTransfer,
    fromAccountId: dto.fromAccountId ?? null,
    toAccountId: dto.toAccountId ?? null,
    payeeId: dto.payeeId ?? null,
    payeeText: dto.payeeText ?? null,
    categoryId: dto.categoryId ?? null,
    description: dto.description ?? null,
    tagIds: dto.tagIds,
    hasSplits: dto.hasSplits,
    referenceNumber: dto.referenceNumber ?? null,
    transactionDate: dto.transactionDate ?? null,
    status: dto.status ?? null,
    hasAttachment: dto.hasAttachment === true,
    ...(dto.payeeName !== undefined ? { payeeName: dto.payeeName } : {}),
  };
}
