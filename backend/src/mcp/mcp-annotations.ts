import { ToolAnnotations } from "@modelcontextprotocol/server";

/**
 * Shared MCP tool annotations.
 *
 * Annotations are optional hints (per the MCP spec) that help clients reason
 * about a tool before calling it. Every preset declares all four hints
 * explicitly -- `readOnlyHint`, `destructiveHint`, `idempotentHint`, and
 * `openWorldHint` -- so no tool relies on the SDK's implicit defaults
 * (`destructiveHint`/`idempotentHint` default to true/false respectively, which
 * is wrong for our read-only tools). Every Monize tool operates over the
 * authenticated user's own closed financial dataset, so `openWorldHint` is
 * `false` (no external/open-world interaction), except `FETCH_EXTERNAL`: the one
 * tool that reads an external site (`fetch_bond_series`).
 *
 * Pick the constant that matches the tool's effect:
 * - `READ_ONLY`  -- queries/aggregations that never mutate state (idempotent,
 *                   non-destructive).
 * - `CREATE`     -- adds a new record (non-idempotent, non-destructive).
 * - `UPDATE`     -- sets fields to given values (idempotent, non-destructive).
 * - `DELETE`     -- removes a record (destructive; idempotent end-state).
 * - `FETCH_EXTERNAL` -- stores reference data read from an external site; a
 *                   repeat converges (created=false), so it is idempotent.
 * - `WRITE`      -- a combined create/update/delete tool whose effect varies per
 *                   call (e.g. `manage_transactions`): destructive (can delete),
 *                   non-idempotent (can create).
 *
 * | Preset    | readOnly | destructive | idempotent | openWorld |
 * |-----------|----------|-------------|------------|-----------|
 * | READ_ONLY | true     | false       | true       | false     |
 * | CREATE    | false    | false       | false      | false     |
 * | UPDATE    | false    | false       | true       | false     |
 * | DELETE    | false    | true        | true       | false     |
 * | WRITE     | false    | true        | false      | false     |
 * | FETCH_EXTERNAL | false | false       | true       | true      |
 */

// A read-only query never mutates state, so it is non-destructive and
// idempotent by definition (repeating it has no additional effect).
export const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

export const CREATE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

export const UPDATE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

// Deletes a record. Destructive; idempotent because once the record is gone,
// repeating the call leaves the same end state (it just reports not-found).
export const DELETE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
};

// A combined create/update/delete tool: destructive (it can delete) and
// non-idempotent (it can create), so repeating it is not safe.
export const WRITE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};

// Reads one document from an external site and stores it as reference data
// (never the user's ledger). Open world; a repeat finds the stored row and
// changes nothing, so it is idempotent.
export const FETCH_EXTERNAL: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};
