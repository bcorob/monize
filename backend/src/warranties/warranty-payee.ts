import { EntityManager, In } from "typeorm";

import { Payee } from "../payees/entities/payee.entity";
import { Warranty } from "./entities/warranty.entity";
import { WarrantyPayee } from "./dto/warranty-response.dto";

/**
 * The vendors the rows name, keyed by payee id, in one read over the page's
 * distinct `payee_id`s (the register's payee join, narrowed to what a logo
 * needs). `hasLogo` is the payee's own `has_logo` column, the flag every read
 * path answers "is there an icon?" with (`brand-logo.columns.ts`); the bytes
 * stay behind `GET /payees/:id/logo`. A payee is not account-scoped, so the
 * delegate's `accountScope` does not narrow it: the row already carries the
 * `payeeId`.
 */
export async function loadWarrantyPayees(
  m: EntityManager,
  userId: string,
  rows: readonly Pick<Warranty, "payeeId">[],
): Promise<Map<string, WarrantyPayee>> {
  const payees = new Map<string, WarrantyPayee>();
  const payeeIds = [
    ...new Set(
      rows.map((row) => row.payeeId).filter((id): id is string => id !== null),
    ),
  ];
  if (payeeIds.length === 0) return payees;
  const found = await m.getRepository(Payee).find({
    select: { id: true, name: true, hasLogo: true },
    where: { id: In(payeeIds), userId },
  });
  for (const p of found) {
    payees.set(p.id, { id: p.id, name: p.name, hasLogo: p.hasLogo });
  }
  return payees;
}
