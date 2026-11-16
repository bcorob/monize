import { JsonbHandlerName } from "./support-backup-jsonb";

/**
 * What the support backup does to one exported column.
 *
 * The kinds and their shorthands live here, apart from the registry that uses
 * them, so the registry can be split across more than one file as it grows
 * without either half importing the other. `support-backup-rules.ts`
 * re-exports these names, so every existing import site is unchanged.
 *
 * `drop` writes NULL, so it is for a nullable column only: on a NOT NULL column
 * with no default it produces a row the restore cannot insert, and
 * `support-backup-rules.spec.ts` fails on one. Use `konst(...)` there, with a
 * value the column's own `CHECK` accepts.
 */
export type ColumnRule =
  | { t: "keep" } // structure, dates, enums, flags, FKs, public reference values
  | { t: "mask" } // free text / names: keep first+last 2 chars, star the middle
  | { t: "drop" } // set to null (highest-risk free text, secrets, bulk blobs)
  | { t: "const"; value: unknown } // fixed replacement for NOT NULL dropped fields
  | { t: "scale" } // private money magnitude x M (4 dp)
  | { t: "scaleQty" } // private quantity x M (8 dp)
  | { t: "jsonb"; handler: JsonbHandlerName }; // per-key handler for a JSON blob

export type TableRules = Record<string, ColumnRule>;

export const keep: ColumnRule = { t: "keep" };
export const mask: ColumnRule = { t: "mask" };
export const drop: ColumnRule = { t: "drop" };
export const scale: ColumnRule = { t: "scale" };
export const scaleQty: ColumnRule = { t: "scaleQty" };
export const konst = (value: unknown): ColumnRule => ({ t: "const", value });
export const jsonb = (handler: JsonbHandlerName): ColumnRule => ({
  t: "jsonb",
  handler,
});
