import { formatDateYMD, todayInTimezone } from "../../../common/date-utils";
import { getRequestTimezone } from "../../../common/request-context";
import { tr } from "../../../i18n/translate";
import { NO_BANK_OPERATION } from "../../bank-operation";
import { BankSyncProviderError } from "../bank-sync-provider.errors";
import type {
  BankAccountDescriptor,
  BankBalance,
  BankTransaction,
} from "../bank-sync-provider.interface";
import {
  simplefinAccountId,
  simplefinTransactionKey,
} from "./simplefin.identity";

type RecordValue = Record<string, unknown>;
export interface SimplefinError {
  code: string;
  message: string;
  connectionId: string | null;
  accountId: string | null;
}
export interface SimplefinConnection {
  id: string;
  name: string;
  organizationId: string;
}
export interface SimplefinTransaction extends BankTransaction {
  externalKey: string;
}
export interface SimplefinAccount {
  connectionId: string;
  remoteAccountId: string;
  descriptor: BankAccountDescriptor;
  balance: BankBalance | null;
  balanceTimestamp: number | null;
  transactions: SimplefinTransaction[];
  transactionsComplete: boolean;
  refusals: BankTransaction[];
  pendingCount: number;
  refusedCount: number;
}
export interface SimplefinAccountSet {
  connections: SimplefinConnection[];
  accounts: SimplefinAccount[];
  errors: SimplefinError[];
}

function record(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function invalid(): never {
  throw new BankSyncProviderError(
    "invalid_response",
    tr(
      "errors.bankSync.simplefinReadFailed",
      "SimpleFIN could not provide complete account data. Review the connection in SimpleFIN Bridge.",
    ),
  );
}
function text(value: unknown, max = 255): string | null {
  if (typeof value !== "string") return null;
  const cleaned = Array.from(value)
    .map((char) => {
      const code = char.charCodeAt(0);
      return code < 32 || code === 127 ? " " : char;
    })
    .join("")
    .trim();
  return cleaned ? cleaned.slice(0, max) : null;
}
function identity(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 4096 ||
    Array.from(value).some(
      (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
    )
  )
    invalid();
  return value;
}
function money(value: unknown): string | null {
  return typeof value === "string" && /^-?\d{1,16}(?:\.\d{1,4})?$/.test(value)
    ? value
    : null;
}
function currency(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z]{3}$/.test(value)
    ? value.toUpperCase()
    : null;
}
function timestamp(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= 253402300799
    ? value
    : null;
}
function utcDate(value: unknown): string | null {
  const seconds = timestamp(value);
  return seconds === null
    ? null
    : (todayInTimezone(
        getRequestTimezone() ??
          Intl.DateTimeFormat().resolvedOptions().timeZone,
        new Date(seconds * 1000),
      ) ?? formatDateYMD(new Date(seconds * 1000)));
}

/** Invalid booked rows remain explicit refusals, never fallback-hash imports. */
export function mapSimplefinTransaction(
  raw: unknown,
  origin: string,
  connectionId: string,
  accountId: string,
  currencyCode: string | null,
): SimplefinTransaction | null {
  if (
    !record(raw) ||
    (raw.pending !== undefined && typeof raw.pending !== "boolean") ||
    raw.pending === true ||
    !currencyCode
  )
    return null;
  let id: string;
  try {
    id = identity(raw.id);
  } catch {
    return null;
  }
  const signed = money(raw.amount);
  const bookingDate = utcDate(raw.posted);
  const description = text(raw.description, 750);
  if (signed === null || bookingDate === null) return null;
  const absolute = signed.startsWith("-") ? signed.slice(1) : signed;
  const negative = signed.startsWith("-") && /[1-9]/.test(absolute);
  return {
    externalKey: simplefinTransactionKey(origin, connectionId, accountId, id),
    entryReference: id,
    transactionId: id,
    bankReference: null,
    amount: absolute,
    currencyCode,
    direction: negative ? "debit" : "credit",
    booked: true,
    bookingDate,
    valueDate: null,
    transactionDate: utcDate(raw.transacted_at),
    counterpartyName: null,
    remittance: description === null ? [] : [description],
    operation: NO_BANK_OPERATION,
  };
}

function errorsOf(raw: RecordValue): SimplefinError[] {
  if (!Array.isArray(raw.errlist)) invalid();
  const result: SimplefinError[] = raw.errlist.map((value: unknown) => {
    if (!record(value)) invalid();
    return {
      code: text(value.code, 100) ?? "gen.",
      message: text(value.msg, 300) ?? "SimpleFIN reported an error.",
      connectionId: text(value.conn_id, 4096),
      accountId: text(value.account_id, 4096),
    };
  });
  if (raw.errors !== undefined) {
    if (!Array.isArray(raw.errors)) invalid();
    for (const value of raw.errors) {
      result.push({
        code: "gen.",
        message: text(value, 300) ?? "SimpleFIN reported a warning.",
        connectionId: null,
        accountId: null,
      });
    }
  }
  return result;
}

/** Unknown or unscoped errors block the batch rather than pretending data is complete. */
export function simplefinAccountBlocked(
  errors: readonly SimplefinError[],
  connectionId: string,
  accountId: string,
): boolean {
  return errors.some((error) => {
    const prefix = error.code.split(".")[0];
    if (prefix === "con" && error.connectionId)
      return error.connectionId === connectionId;
    if (prefix === "act" && error.accountId) {
      return (
        error.accountId === accountId &&
        (!error.connectionId || error.connectionId === connectionId)
      );
    }
    return true;
  });
}

function mapAccount(
  raw: unknown,
  origin: string,
  connections: Set<string>,
): SimplefinAccount {
  if (!record(raw)) invalid();
  const accountId = identity(raw.id);
  const connectionId = identity(raw.conn_id);
  if (!connections.has(connectionId)) invalid();
  const currencyCode = currency(raw.currency);
  const amount = money(raw.balance);
  const balanceTimestamp = timestamp(raw["balance-date"]);
  const transactions: SimplefinTransaction[] = [];
  const refusals: BankTransaction[] = [];
  let refusedCount = 0;
  let pendingCount = 0;
  const transactionsComplete = Array.isArray(raw.transactions);
  if (transactionsComplete) {
    for (const row of raw.transactions as unknown[]) {
      if (record(row) && row.pending === true) {
        pendingCount++;
        continue;
      }
      const mapped = mapSimplefinTransaction(
        row,
        origin,
        connectionId,
        accountId,
        currencyCode,
      );
      if (mapped) transactions.push(mapped);
      else {
        refusedCount++;
        const value = record(row) ? row : {};
        let hasIdentity = true;
        try {
          identity(value.id);
        } catch {
          hasIdentity = false;
        }
        refusals.push({
          refusalReason: !hasIdentity
            ? "missing_identity"
            : utcDate(value.posted) === null
              ? "missing_date"
              : "invalid_amount",
          entryReference: null,
          transactionId: null,
          bankReference: null,
          amount: null,
          currencyCode,
          direction: null,
          booked: true,
          bookingDate: utcDate(value.posted),
          valueDate: null,
          transactionDate: null,
          counterpartyName: null,
          remittance: [],
          operation: NO_BANK_OPERATION,
        });
      }
    }
  }
  return {
    connectionId,
    remoteAccountId: accountId,
    descriptor: {
      externalAccountId: simplefinAccountId(origin, connectionId, accountId),
      identificationHash: simplefinAccountId(origin, connectionId, accountId),
      displayName: text(raw.name),
      identifierMasked: null,
      accountIdentifier: null,
      cashAccountType: null,
      currencyCode,
    },
    balance:
      amount !== null && currencyCode !== null && balanceTimestamp !== null
        ? {
            amount,
            currencyCode,
            referenceDate: utcDate(balanceTimestamp),
            balanceType: null,
          }
        : null,
    balanceTimestamp,
    transactions,
    transactionsComplete,
    pendingCount,
    refusedCount,
    refusals,
  };
}

/** Parses the public v2 Account Set without making network requests or inferring missing money. */
export function mapSimplefinAccountSet(
  payload: unknown,
  origin: string,
): SimplefinAccountSet {
  if (
    !record(payload) ||
    !Array.isArray(payload.connections) ||
    !Array.isArray(payload.accounts) ||
    payload.connections.length > 1000 ||
    payload.accounts.length > 1000
  )
    invalid();
  const errors = errorsOf(payload);
  const seenConnections = new Set<string>();
  const connections = payload.connections.map(
    (raw: unknown): SimplefinConnection => {
      if (!record(raw)) invalid();
      const id = identity(raw.conn_id);
      if (seenConnections.has(id)) invalid();
      seenConnections.add(id);
      return {
        id,
        name: text(raw.name) ?? "SimpleFIN",
        organizationId: identity(raw.org_id),
      };
    },
  );
  const seenAccounts = new Set<string>();
  let rowCount = 0;
  const accounts = payload.accounts.map((raw: unknown) => {
    if (record(raw) && Array.isArray(raw.transactions))
      rowCount += raw.transactions.length;
    if (rowCount > 50_000) invalid();
    const mapped = mapAccount(raw, origin, seenConnections);
    if (seenAccounts.has(mapped.descriptor.externalAccountId)) invalid();
    seenAccounts.add(mapped.descriptor.externalAccountId);
    return mapped;
  });
  return { connections, accounts, errors };
}
