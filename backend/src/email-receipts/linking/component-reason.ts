import type { EntityManager } from "typeorm";
import { unitsOf } from "./component-lookup";

/** The `status_reason` of a `component` receipt (spec 2.1). */
export type ComponentReason = "awaiting_settlement" | "settled" | "instalment";

/**
 * Pure: no part used the component -> `awaiting_settlement`; parts took at
 * least its net -> `settled`; otherwise `instalment`. Units of 1/10000.
 */
export function componentReasonOf(
  usedBy: number,
  takenUnits: number,
  netUnits: number,
): ComponentReason {
  if (usedBy === 0) return "awaiting_settlement";
  return takenUnits >= netUnits ? "settled" : "instalment";
}

/**
 * The reason a component receipt holds now, from the link rows that name it
 * (any settlement, `component_receipt_id` is set only for `joined` and
 * `scaled`). `netUnits` is `componentNet(parsed)`.
 */
export async function componentReason(
  m: EntityManager,
  userId: string,
  receiptId: string,
  netUnits: number,
): Promise<ComponentReason> {
  const [row]: { used: string | number; taken: string | null }[] =
    await m.query(
      `SELECT COUNT(*) AS used, COALESCE(SUM(part_amount), 0) AS taken
         FROM email_receipt_links
        WHERE user_id = $1 AND component_receipt_id = $2`,
      [userId, receiptId],
    );
  return componentReasonOf(
    Number(row?.used ?? 0),
    unitsOf(row?.taken),
    netUnits,
  );
}
