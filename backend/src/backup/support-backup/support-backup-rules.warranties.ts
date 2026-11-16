import {
  TableRules,
  drop,
  keep,
  konst,
  mask,
  scale,
} from "./support-backup-rule-kinds";

/**
 * The warranty tables' de-identification rules
 * (`docs/specs/warranty-tracker.md` sections 6.1 and 6.2).
 *
 * In their own file because one more table would push
 * `support-backup-rules.ts` past the repository's 800-line ceiling, and a
 * separate area from the account core besides: a warranty is a record about a
 * purchase, never a ledger row. Merged back into the one `RULES` map, so the
 * golden test still reads a single registry and a column with no rule is still
 * dropped.
 *
 * The item and vendor names are masked like every other name here. Everything
 * else that would say what the user bought, or re-identify the masked name, is
 * removed rather than masked: a model number or a product URL names the
 * product outright (the reason `payees.website` is dropped), a serial number
 * identifies the single physical item, and notes and claim text are free text.
 * `serial_numbers` is `konst([])` rather than `mask` because it is an array,
 * which the mask passes through untouched, and rather than `drop` because the
 * column is NOT NULL. The price is scaled like every other private amount.
 */
export const WARRANTY_RULES: Record<string, TableRules> = {
  warranties: {
    id: keep,
    user_id: keep,
    name: mask,
    vendor_name: mask,
    payee_id: keep,
    transaction_id: keep,
    model_number: drop,
    serial_numbers: konst([]), // NOT NULL text[]; an array the mask cannot reach
    warranty_kind: keep,
    purchase_date: keep,
    expires_on: keep,
    is_lifetime: keep,
    purchase_price: scale,
    currency_code: keep,
    product_url: drop,
    notes: drop,
    archived_at: keep,
    created_at: keep,
    updated_at: keep,
  },
  warranty_claims: {
    id: keep,
    user_id: keep,
    warranty_id: keep,
    claim_date: keep,
    status: keep,
    description: drop,
    resolution: drop,
    resolved_on: keep,
    created_at: keep,
    updated_at: keep,
  },
};
