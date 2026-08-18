import { describe, it, expect, vi, beforeEach } from 'vitest';
import { editCashRow } from './cash-row-edit';
import { investmentsApi } from '@/lib/investments';
import { transactionsApi } from '@/lib/transactions';
import type { Transaction } from '@/types/transaction';

vi.mock('@/lib/investments', () => ({
  investmentsApi: { getTransaction: vi.fn() },
}));

vi.mock('@/lib/transactions', () => ({
  transactionsApi: { getById: vi.fn() },
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

const getInvestment = investmentsApi.getTransaction as ReturnType<typeof vi.fn>;
const getById = transactionsApi.getById as ReturnType<typeof vi.fn>;

const row = (overrides: Partial<Transaction> = {}) =>
  ({ id: 'cash-1', amount: -100, ...overrides }) as Transaction;

function handlers() {
  return {
    openInvestment: vi.fn(),
    openCash: vi.fn(),
    onLookupFailed: vi.fn(),
  };
}

describe('editCashRow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("edits a trade's cash leg as the trade", async () => {
    // Its amount, date and payee are consequences of the trade, so a cash form
    // over it edits the wrong thing.
    const trade = { id: 'itx-9', action: 'BUY' };
    getInvestment.mockResolvedValue(trade);
    const h = handlers();

    await editCashRow(row({ linkedInvestmentTransactionId: 'itx-9' }), h);

    expect(getInvestment).toHaveBeenCalledWith('itx-9');
    expect(h.openInvestment).toHaveBeenCalledWith(trade);
    expect(h.openCash).not.toHaveBeenCalled();
  });

  it('opens nothing when the trade cannot be loaded', async () => {
    // Falling back to the cash form would be the defect this function exists to
    // prevent, arriving by another door.
    getInvestment.mockRejectedValue(new Error('offline'));
    const h = handlers();

    await editCashRow(row({ linkedInvestmentTransactionId: 'itx-9' }), h);

    expect(h.openCash).not.toHaveBeenCalled();
    expect(h.onLookupFailed).toHaveBeenCalled();
  });

  it('fetches a transfer in full before editing it', async () => {
    // The counterpart is not in the list payload.
    const full = row({ id: 'cash-1', isTransfer: true, linkedTransactionId: 'cash-2' });
    getById.mockResolvedValue(full);
    const h = handlers();

    await editCashRow(row({ isTransfer: true }), h);

    expect(getById).toHaveBeenCalledWith('cash-1');
    expect(h.openCash).toHaveBeenCalledWith(full);
  });

  it('edits a transfer from the listed row when the fetch fails', async () => {
    // A partial editor beats none for a row the user can meaningfully edit.
    getById.mockRejectedValue(new Error('offline'));
    const listed = row({ isTransfer: true });
    const h = handlers();

    await editCashRow(listed, h);

    expect(h.openCash).toHaveBeenCalledWith(listed);
  });

  it('edits an ordinary row as listed, asking for nothing', async () => {
    const listed = row();
    const h = handlers();

    await editCashRow(listed, h);

    expect(h.openCash).toHaveBeenCalledWith(listed);
    expect(getById).not.toHaveBeenCalled();
    expect(getInvestment).not.toHaveBeenCalled();
  });
});
