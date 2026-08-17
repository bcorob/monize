/**
 * Reconciliation status shared by transactions and investment transactions.
 *
 * Lives in its own module (re-exported by transaction.entity for existing
 * importers) because investment-transaction.entity needs it at decoration
 * time, and importing it from transaction.entity there closes a require cycle
 * -- transaction.entity -> transaction-split.entity ->
 * investment-transaction.entity -- that leaves the enum undefined while the
 * decorators run.
 */
export enum TransactionStatus {
  UNRECONCILED = "UNRECONCILED",
  CLEARED = "CLEARED",
  RECONCILED = "RECONCILED",
  VOID = "VOID",
}
