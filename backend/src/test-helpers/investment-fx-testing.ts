import { InvestmentTransactionsService } from "../securities/investment-transactions.service";

/**
 * The three `InvestmentTransactionsService` methods the effective-amount
 * resolver reaches for, as one double.
 *
 * Typed as `jest.Mocked<Pick<...>>` rather than `Record<string, jest.Mock>` on
 * purpose: this is one of our own services, so `tsc` should reject a return
 * shape the real method cannot produce (see the mock rule in
 * `backend/CLAUDE.md`).
 *
 * It exists because five specs now provide the real
 * `ScheduledEffectiveAmountService` over a stubbed FX source (the amounts they
 * assert on ARE its output, so a double of the resolver would test nothing), and
 * each of them hand-rolled the same three methods. When the resolver grew
 * `resolveSettlementAccountId` every one of those specs failed with
 * "is not a function" from inside library code -- a shared factory is the one
 * place to add the next method.
 */
export type InvestmentFxMock = jest.Mocked<
  Pick<
    InvestmentTransactionsService,
    | "resolveSettlementCurrencyPair"
    | "resolveCashExchangeRateOrNull"
    | "resolveSettlementAccountId"
  >
>;

/**
 * Defaults chosen so a plain schedule's effective amount equals its stored one:
 * a same-currency settlement pair, a rate of 1, and the identity settlement
 * account (the named funding account when there is one, else the schedule's own
 * -- which is what the real resolver returns for an account that is not a
 * linked brokerage).
 *
 * That is deliberately the *uninteresting* case. A spec testing the stale-pair
 * or unknown-rate behaviour of issue #1247 overrides
 * `resolveSettlementCurrencyPair` and `resolveCashExchangeRateOrNull` per case,
 * which is the assertion worth writing.
 */
export function createInvestmentFxMock(): InvestmentFxMock {
  return {
    resolveSettlementCurrencyPair: jest
      .fn()
      .mockResolvedValue({ from: "USD", to: "USD" }),
    resolveCashExchangeRateOrNull: jest.fn().mockResolvedValue(1),
    resolveSettlementAccountId: jest
      .fn()
      .mockImplementation(
        async (
          _userId: string,
          accountId: string,
          fundingAccountId?: string | null,
        ) => fundingAccountId ?? accountId,
      ),
  } as unknown as InvestmentFxMock;
}
