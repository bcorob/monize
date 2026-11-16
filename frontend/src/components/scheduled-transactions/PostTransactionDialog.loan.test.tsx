import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@/test/render';
import { PostTransactionDialog } from './PostTransactionDialog';
import type { LoanOccurrence, LoanOccurrencesProjection } from '@/types/scheduled-transaction';

const mockPostApi = vi.fn().mockResolvedValue({});
const mockGetLoanOccurrences = vi.fn();

vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

vi.mock('@/lib/scheduled-transactions', () => ({
  scheduledTransactionsApi: {
    post: (...args: unknown[]) => mockPostApi(...args),
    getLoanOccurrences: (...args: unknown[]) => mockGetLoanOccurrences(...args),
  },
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return { useNumberFormat: () => ({ ...numberFormatMockDefaults() }) };
});

vi.mock('@/lib/forecast', () => ({
  getProjectedBalanceAtDate: (account: { currentBalance: number }) =>
    Number(account.currentBalance) || 0,
}));

// The real row conversion and booking; only the editor's chrome is replaced by
// one text node per row and a control that types into the first two rows.
vi.mock('@/components/transactions/SplitEditor', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/transactions/SplitEditor')>();
  return {
    ...actual,
    SplitEditor: ({ splits, onChange }: any) => (
      <div data-testid="split-editor">
        {splits.map((row: any, index: number) => (
          <span key={row.id} data-testid={`row-${index}`}>
            {String(row.amount)}
          </span>
        ))}
        <button
          type="button"
          onClick={() =>
            onChange([
              { ...splits[0], amount: Math.round((splits[0].amount - 1) * 100) / 100 },
              { ...splits[1], amount: Math.round((splits[1].amount + 1) * 100) / 100 },
              ...splits.slice(2),
            ])
          }
        >
          type-into-rows
        </button>
      </div>
    ),
  };
});

const LOAN_ID = '11111111-1111-4111-8111-111111111111';
const PRINCIPAL_SPLIT = '22222222-2222-4222-8222-222222222222';
const INTEREST_SPLIT = '33333333-3333-4333-8333-333333333333';
const INTEREST_CATEGORY = '44444444-4444-4444-8444-444444444444';

// A loan bill whose template was divided before a principal-only payment:
// interest 997.50 / principal 502.50.
const loanBill = {
  id: 's-loan',
  name: 'Loan payment',
  amount: -1500,
  currencyCode: 'CAD',
  accountId: 'a1',
  categoryId: null,
  description: '',
  nextDueDate: '2025-02-15T00:00:00Z',
  isTransfer: false,
  isSplit: true,
  isActive: true,
  account: { name: 'Checking' },
  splits: [
    {
      id: PRINCIPAL_SPLIT,
      kind: 'transfer',
      transferAccountId: LOAN_ID,
      transferAccount: { accountType: 'LOAN' },
      categoryId: null,
      amount: -502.5,
      memo: 'Principal',
    },
    {
      id: INTEREST_SPLIT,
      kind: 'category',
      categoryId: INTEREST_CATEGORY,
      transferAccountId: null,
      amount: -997.5,
      memo: 'Interest',
    },
  ],
} as any;

const nonLoanSplitBill = {
  ...loanBill,
  id: 's-split',
  splits: [
    { id: PRINCIPAL_SPLIT, kind: 'category', categoryId: 'c1', amount: -502.5, memo: '' },
    { id: INTEREST_SPLIT, kind: 'category', categoryId: 'c2', amount: -997.5, memo: '' },
  ],
} as any;

const occurrence = (overrides: Partial<LoanOccurrence> = {}): LoanOccurrence => ({
  originalDate: '2025-02-15',
  dueDate: '2025-02-15',
  overrideId: null,
  amount: 1500,
  principal: 552.5,
  interest: 947.5,
  extraPrincipal: 0,
  annualRate: 6,
  debtBefore: 100000,
  complete: true,
  missing: null,
  ...overrides,
});

const projection = (occ: LoanOccurrence): LoanOccurrencesProjection => ({
  scheduledTransactionId: 's-loan',
  loanAccountId: LOAN_ID,
  status: 'priced',
  currencyCode: 'CAD',
  occurrences: [occ],
});

const accounts = [
  { id: 'a1', name: 'Checking', currentBalance: 5000 },
  { id: LOAN_ID, name: 'Loan', currentBalance: -100000, accountType: 'LOAN' },
] as any[];

const props = (scheduledTransaction: any) => ({
  isOpen: true,
  scheduledTransaction,
  categories: [] as any[],
  accounts,
  scheduledTransactions: [] as any[],
  futureTransactions: [] as any[],
  onClose: vi.fn(),
  onPosted: vi.fn(),
});

const renderDialog = async (scheduledTransaction: any) => {
  await act(async () => {
    render(<PostTransactionDialog {...props(scheduledTransaction)} />);
  });
};

const clickPost = async () => {
  const buttons = screen.getAllByText('Post Transaction');
  await act(async () => {
    fireEvent.click(buttons[buttons.length - 1]);
  });
};

describe('PostTransactionDialog loan bill preview (A26-S15-09)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPostApi.mockResolvedValue({});
  });

  it('shows what the post will write, not the stored template', async () => {
    mockGetLoanOccurrences.mockResolvedValue(projection(occurrence()));
    await renderDialog(loanBill);

    expect(mockGetLoanOccurrences).toHaveBeenCalledWith('s-loan', 1);
    await waitFor(() => expect(screen.getByTestId('row-0')).toHaveTextContent('-552.5'));
    expect(screen.getByTestId('row-1')).toHaveTextContent('-947.5');
  });

  it('submits an unchanged preview as the template echo so the server re-prices it', async () => {
    mockGetLoanOccurrences.mockResolvedValue(projection(occurrence()));
    await renderDialog(loanBill);
    await waitFor(() => expect(screen.getByTestId('row-0')).toHaveTextContent('-552.5'));

    await clickPost();

    await waitFor(() => expect(mockPostApi).toHaveBeenCalledTimes(1));
    const [id, payload] = mockPostApi.mock.calls[0];
    expect(id).toBe('s-loan');
    expect(payload).toMatchObject({
      // The occurrence pin stays in the payload.
      expectedOccurrenceDate: '2025-02-15',
      expectedOverrideId: null,
      amount: -1500,
      isSplit: true,
    });
    expect(
      payload.splits.map((s: any) => [s.sourceSplitId, s.amount]),
    ).toEqual([
      [PRINCIPAL_SPLIT, -502.5],
      [INTEREST_SPLIT, -997.5],
    ]);
  });

  it('sends the rows as typed once the user edits a line', async () => {
    mockGetLoanOccurrences.mockResolvedValue(projection(occurrence()));
    await renderDialog(loanBill);
    await waitFor(() => expect(screen.getByTestId('row-0')).toHaveTextContent('-552.5'));

    await act(async () => {
      fireEvent.click(screen.getByText('type-into-rows'));
    });
    expect(screen.getByTestId('row-0')).toHaveTextContent('-553.5');
    await clickPost();

    await waitFor(() => expect(mockPostApi).toHaveBeenCalledTimes(1));
    const payload = mockPostApi.mock.calls[0][1];
    expect(payload.amount).toBe(-1500);
    expect(payload.splits.map((s: any) => s.amount)).toEqual([-553.5, -946.5]);
  });

  it('keeps the template pre-fill when the projection fails', async () => {
    mockGetLoanOccurrences.mockRejectedValue(new Error('offline'));
    await renderDialog(loanBill);

    expect(screen.getByTestId('row-0')).toHaveTextContent('-502.5');
    expect(screen.getByTestId('row-1')).toHaveTextContent('-997.5');
    await clickPost();
    await waitFor(() => expect(mockPostApi).toHaveBeenCalledTimes(1));
    expect(mockPostApi.mock.calls[0][1].splits.map((s: any) => s.amount)).toEqual([
      -502.5, -997.5,
    ]);
  });

  it('keeps the template pre-fill for an occurrence that is not the one posted', async () => {
    mockGetLoanOccurrences.mockResolvedValue(
      projection(occurrence({ originalDate: '2025-03-15', dueDate: '2025-03-15' })),
    );
    await renderDialog(loanBill);

    expect(screen.getByTestId('row-0')).toHaveTextContent('-502.5');
  });

  it('keeps the template pre-fill for an incomplete occurrence', async () => {
    mockGetLoanOccurrences.mockResolvedValue(
      projection(
        occurrence({
          complete: false,
          amount: null,
          principal: null,
          interest: null,
          extraPrincipal: null,
          missing: { kind: 'rate', date: '2025-02-15' },
        }),
      ),
    );
    await renderDialog(loanBill);

    expect(screen.getByTestId('row-0')).toHaveTextContent('-502.5');
  });

  it('shows a capitalized principal (negative) as a positive transfer from the loan', async () => {
    mockGetLoanOccurrences.mockResolvedValue(
      projection(
        occurrence({ amount: 1500, principal: -500, interest: 2000, unpaidInterest: 500 }),
      ),
    );
    await renderDialog(loanBill);

    await waitFor(() => expect(screen.getByTestId('row-0')).toHaveTextContent('500'));
    expect(screen.getByTestId('row-0')).not.toHaveTextContent('-');
    expect(screen.getByTestId('row-1')).toHaveTextContent('-2000');
    await clickPost();
    await waitFor(() => expect(mockPostApi).toHaveBeenCalledTimes(1));
    expect(mockPostApi.mock.calls[0][1].amount).toBe(-1500);
  });

  it('makes no projection call for a split bill that pays no loan', async () => {
    await renderDialog(nonLoanSplitBill);

    expect(mockGetLoanOccurrences).not.toHaveBeenCalled();
    expect(screen.getByTestId('row-0')).toHaveTextContent('-502.5');
  });
});
