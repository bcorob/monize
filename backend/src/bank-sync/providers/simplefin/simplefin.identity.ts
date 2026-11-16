import { createHash } from "node:crypto";

function digest(parts: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

/** Opaque provider IDs are scoped by server and institution, never by credentials. */
export function simplefinAccountId(
  origin: string,
  connectionId: string,
  accountId: string,
): string {
  return `sf2:${digest([origin, connectionId, accountId])}`;
}

/** Stable across token rotation and description changes; fits the import ledger. */
export function simplefinTransactionKey(
  origin: string,
  connectionId: string,
  accountId: string,
  transactionId: string,
): string {
  return `simplefin:v1:${digest([origin, connectionId, accountId, transactionId])}`;
}
