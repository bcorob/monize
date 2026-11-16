import type {
  BankReadProvider,
  BankSyncProvider,
  BankSyncCredentials,
  PsuContext,
  BankBalance,
} from "../bank-sync-provider.interface";

/** Transactions must be complete; an independent balance failure means unknown balance. */
export class EnableBankingReader implements BankReadProvider {
  constructor(private readonly provider: BankSyncProvider) {}
  async readAccount(
    _userId: string,
    credentials: BankSyncCredentials,
    accountId: string,
    window: { dateFrom: string; dateTo: string },
    psu: PsuContext | null = null,
  ) {
    const transactions = await this.provider.fetchTransactions(
      credentials,
      accountId,
      window,
      psu,
    );
    let balance: BankBalance | null = null;
    let balanceFailure: unknown;
    try {
      balance = await this.provider.fetchBalance(credentials, accountId, psu);
    } catch (error) {
      balanceFailure = error;
    }
    return {
      transactions,
      balance,
      currencyCode: null,
      pending: 0,
      ...(balanceFailure !== undefined ? { balanceFailure } : {}),
    };
  }
}
