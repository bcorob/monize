import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/render';
import { OverrideEditorDialog } from './OverrideEditorDialog';

// A payroll bill's occurrence opens on its deduction lines as the yearly room
// leaves them (docs/specs/payroll-deductions.md decision 7), never the
// template's, so the Edit Occurrence dialog shows the paycheque the posting
// will book. The real `toSplitRows`, booking and format helpers run here.
vi.mock('react-hot-toast', () => ({
  default: { success: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/scheduled-transactions', () => ({
  scheduledTransactionsApi: {
    createOverride: vi.fn().mockResolvedValue({}),
    updateOverride: vi.fn().mockResolvedValue({}),
    deleteOverride: vi.fn().mockResolvedValue({}),
  },
}));
vi.mock('@/lib/investments', () => ({
  investmentsApi: { getSecurityPrices: vi.fn().mockResolvedValue([]) },
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));
vi.mock('@/hooks/useDateFormat', () => ({
  useDateFormat: () => ({ formatDate: (d: string) => d, dateFormat: 'browser', datePattern: 'YYYY-MM-DD' }),
}));
vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return { useNumberFormat: () => numberFormatMockDefaults() };
});
vi.mock('@/components/transactions/SplitEditor', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/transactions/SplitEditor')>()),
  SplitEditor: ({ splits, transactionAmount }: any) => (
    <div data-testid="split-editor">
      <span data-testid="parent">{transactionAmount}</span>
      {splits.map((s: any) => (
        <span key={s.id} data-testid="line">{s.amount}</span>
      ))}
    </div>
  ),
}));

const paycheque = {
  id: 'st-pay',
  name: 'Paycheque',
  amount: 2436,
  currencyCode: 'CAD',
  accountId: 'a1',
  categoryId: null,
  description: '',
  isTransfer: false,
  isSplit: true,
  account: { name: 'Main' },
  splits: [
    { id: '11111111-1111-4111-8111-111111111111', transferAccountId: null, transferAccount: null, categoryId: 'cat-gross', amount: 2500, memo: 'Gross' },
    { id: '22222222-2222-4222-8222-222222222222', transferAccountId: null, transferAccount: null, categoryId: 'cat-ei', amount: -64, memo: 'EI' },
  ],
} as any;

const renderEditor = (props: Partial<React.ComponentProps<typeof OverrideEditorDialog>> = {}) =>
  render(
    <OverrideEditorDialog
      isOpen
      scheduledTransaction={paycheque}
      overrideDate="2026-05-08"
      categories={[
        { id: 'cat-gross', name: 'Salary', parentId: null },
        { id: 'cat-ei', name: 'EI', parentId: null },
      ] as any[]}
      accounts={[{ id: 'a1', name: 'Main', accountType: 'CHEQUING' }] as any[]}
      onClose={vi.fn()}
      onSave={vi.fn()}
      {...props}
    />,
  );
const lines = () => screen.getAllByTestId('line').map((el) => el.textContent);

describe('OverrideEditorDialog: a payroll occurrence as the yearly room leaves it', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('opens on the capped deduction line and the re-summed net pay', () => {
    renderEditor({ payrollDeductions: { 'cat-ei': 36 } });
    expect(lines()).toEqual(['2500', '-36']);
    expect(screen.getByTestId('parent')).toHaveTextContent('2464');
  });

  it('zeroes the line once the room is spent, and keeps the template without a projection', () => {
    renderEditor({ payrollDeductions: { 'cat-ei': 0 } });
    expect(lines()).toEqual(['2500', '0']);
    expect(screen.getByTestId('parent')).toHaveTextContent('2500');
  });

  it('leaves an override with lines of its own, or a stated amount, as the user wrote it', () => {
    const { unmount } = renderEditor({
      payrollDeductions: { 'cat-ei': 36 },
      existingOverride: {
        id: 'o1',
        scheduledTransactionId: 'st-pay',
        originalDate: '2026-05-08',
        overrideDate: '2026-05-08',
        amount: null,
        categoryId: null,
        description: null,
        isSplit: true,
        splits: [
          { categoryId: 'cat-gross', transferAccountId: null, amount: 2600, memo: null },
          { categoryId: 'cat-ei', transferAccountId: null, amount: -64, memo: null },
        ],
        investmentQuantity: null,
        investmentPrice: null,
        investmentTotalAmount: null,
      } as any,
    });
    expect(lines()).toEqual(['2600', '-64']);
    unmount();
    renderEditor({
      payrollDeductions: { 'cat-ei': 36 },
      existingOverride: {
        id: 'o2',
        scheduledTransactionId: 'st-pay',
        originalDate: '2026-05-08',
        overrideDate: '2026-05-08',
        amount: 3000,
        categoryId: null,
        description: null,
        isSplit: null,
        splits: null,
        investmentQuantity: null,
        investmentPrice: null,
        investmentTotalAmount: null,
      } as any,
    });
    expect(screen.getByTestId('parent')).toHaveTextContent('3000');
  });
});
