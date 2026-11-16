import type { ApiClient } from '../helpers/api';

// What the seeders need to find in the built-in demo data, and the lookups
// they share. Every seeder looks a record up by name first and creates it only
// when it is absent, so a second run changes nothing.

export interface Named {
  id: string;
  name: string;
}

export interface AccountRow extends Named {
  accountType: string;
  accountSubType: string | null;
  currencyCode: string;
  linkedLoanAccountId?: string | null;
  isFavourite?: boolean;
}

export interface SecurityRow {
  id: string;
  symbol: string;
  name: string;
}

export interface TagRow extends Named {
  color: string | null;
  icon: string | null;
}

export interface TransactionRow {
  id: string;
  accountId: string;
  transactionDate: string;
  payeeId: string | null;
  payeeName: string | null;
  categoryId: string | null;
  amount: string | number;
  isTransfer: boolean;
  isSplit: boolean;
  tags: { id: string }[];
}

const key = (name: string) => name.trim().toLowerCase();

export function indexByName<T extends Named>(rows: T[]): Map<string, T> {
  return new Map(rows.map((row) => [key(row.name), row]));
}

/** The record called `name`, or an error that says what is wrong with the instance. */
export function need<T>(index: Map<string, T>, name: string, kind: string): T {
  const found = index.get(key(name));
  if (!found) {
    throw new Error(
      `The instance has no ${kind} named "${name}". These pictures need the built-in demo data ` +
        '(backend/src/database/demo-seed.service.ts).',
    );
  }
  return found;
}

export function has<T>(index: Map<string, T>, name: string): boolean {
  return index.has(key(name));
}

export interface Lookups {
  accounts: Map<string, AccountRow>;
  payees: Map<string, Named>;
  categories: Map<string, Named>;
  securities: Map<string, SecurityRow>;
}

export async function loadLookups(api: ApiClient): Promise<Lookups> {
  const [accounts, payees, categories, securities] = await Promise.all([
    api.get<AccountRow[]>('/accounts'),
    api.get<Named[]>('/payees'),
    api.get<Named[]>('/categories'),
    api.get<SecurityRow[]>('/securities'),
  ]);
  return {
    accounts: indexByName(accounts),
    payees: indexByName(payees),
    categories: indexByName(categories),
    securities: new Map(securities.map((s) => [s.symbol.toUpperCase(), s])),
  };
}

export function security(lookups: Lookups, symbol: string): SecurityRow {
  const found = lookups.securities.get(symbol.toUpperCase());
  if (!found) throw new Error(`The instance has no security with the symbol ${symbol}.`);
  return found;
}

/** Every transaction of the register, newest first, over as many pages as it takes. */
export async function loadTransactions(api: ApiClient): Promise<TransactionRow[]> {
  const rows: TransactionRow[] = [];
  for (let page = 1; page <= 50; page++) {
    const res = await api.get<{ data: TransactionRow[]; pagination: { hasMore: boolean } }>(
      `/transactions?page=${page}&limit=200`,
    );
    rows.push(...res.data);
    if (!res.pagination.hasMore) break;
  }
  return rows;
}

export const money = (value: string | number): number => Number(value);
