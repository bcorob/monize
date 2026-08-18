import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@/test/render';
import { ReconcileTable } from './ReconcileTable';
import type { ComponentProps } from 'react';
import { Transaction, TransactionStatus } from '@/types/transaction';

vi.mock('@/hooks/useDateFormat', () => ({
  useDateFormat: () => ({ dateFormat: 'browser', datePattern: 'YYYY-MM-DD', formatDate: (d: string) => String(d) }),
}));

function row(overrides: Partial<Transaction> & { id: string }): Transaction {
  return {
    transactionDate: '2026-02-01',
    amount: '-10.0000' as unknown as number,
    status: TransactionStatus.UNRECONCILED,
    payee: null,
    payeeName: null,
    category: null,
    ...overrides,
  } as Transaction;
}

const transactions = [
  row({ id: 'tx-c', transactionDate: '2026-02-10', amount: '-120.5000' as unknown as number, payeeName: 'Electric Co', status: TransactionStatus.CLEARED }),
  row({ id: 'tx-a', transactionDate: '2026-02-01', amount: '-50.2500' as unknown as number, payeeName: 'Grocery' }),
  row({ id: 'tx-b', transactionDate: '2026-02-05', amount: '3000.0000' as unknown as number, payeeName: 'Salary' }),
];

const defaults: ComponentProps<typeof ReconcileTable> = {
  transactions,
  selectedIds: new Set<string>(),
  onToggle: vi.fn(),
  sortField: 'date',
  sortDirection: 'asc',
  onSort: vi.fn(),
  groupByFlow: false,
  lastReconciledDate: null,
  overdueBefore: '2026-01-01',
  formatCurrency: (a: number | string | null | undefined) => `$${Number(a).toFixed(2)}`,
  onEdit: vi.fn(),
  onDelete: vi.fn(),
  onCycleStatus: vi.fn(),
  reconciledLocked: false,
};

function renderTable(props: Partial<ComponentProps<typeof ReconcileTable>> = {}) {
  return render(<ReconcileTable {...defaults} {...props} />);
}

function renderedIds(): string[] {
  return screen
    .getAllByTestId(/^reconcile-row-/)
    .map((el) => el.getAttribute('data-testid')!.replace('reconcile-row-', ''));
}

describe('ReconcileTable', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('sorting', () => {
    it('renders in the order the active sort asks for', () => {
      renderTable();
      expect(renderedIds()).toEqual(['tx-a', 'tx-b', 'tx-c']);
    });

    it('honours a different column and direction', () => {
      renderTable({ sortField: 'amount', sortDirection: 'desc' });
      expect(renderedIds()).toEqual(['tx-b', 'tx-a', 'tx-c']);
    });

    it('asks the host to sort when a header is clicked', () => {
      renderTable();
      fireEvent.click(screen.getByText('Payee'));
      expect(defaults.onSort).toHaveBeenCalledWith('payee');
    });

    it('offers every data column as a sort target', () => {
      renderTable();
      for (const [label, field] of [
        ['Date', 'date'],
        ['Payee', 'payee'],
        ['Category', 'category'],
        ['Amount', 'amount'],
        ['Status', 'status'],
      ] as const) {
        fireEvent.click(screen.getByText(label));
        expect(defaults.onSort).toHaveBeenCalledWith(field);
      }
    });
  });

  describe('grouping', () => {
    it('draws no group headings when grouping is off', () => {
      renderTable();
      expect(screen.queryByText(/Money in/)).not.toBeInTheDocument();
    });

    it('splits into money in and money out with subtotals', () => {
      renderTable({ groupByFlow: true });
      expect(screen.getByText('Money in (1)')).toBeInTheDocument();
      expect(screen.getByText('Money out (2)')).toBeInTheDocument();
      expect(screen.getByText('Group subtotal $3000.00')).toBeInTheDocument();
      expect(screen.getByText('Group subtotal $-170.75')).toBeInTheDocument();
    });

    it('keeps every row when grouping', () => {
      renderTable({ groupByFlow: true });
      expect(renderedIds().sort()).toEqual(['tx-a', 'tx-b', 'tx-c']);
    });
  });

  describe('selection', () => {
    it('toggles from a click anywhere on the row', () => {
      renderTable();
      fireEvent.click(screen.getByTestId('reconcile-row-tx-a'));
      expect(defaults.onToggle).toHaveBeenCalledWith('tx-a');
    });

    it('toggles once, not twice, from the checkbox itself', () => {
      // The checkbox sits inside a row that also toggles; without
      // stopPropagation the click would select and immediately deselect.
      renderTable();
      const rowEl = screen.getByTestId('reconcile-row-tx-a');
      fireEvent.click(within(rowEl).getByRole('checkbox'));
      expect(defaults.onToggle).toHaveBeenCalledTimes(1);
    });
  });

  describe('row actions', () => {
    it('offers edit and delete on every row', () => {
      renderTable();
      const rowEl = screen.getByTestId('reconcile-row-tx-a');
      fireEvent.click(within(rowEl).getByLabelText('Edit'));
      expect(defaults.onEdit).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'tx-a' }),
      );
      fireEvent.click(within(rowEl).getByLabelText('Delete'));
      expect(defaults.onDelete).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'tx-a' }),
      );
    });

    it('does not also toggle the row when an action is used', () => {
      renderTable();
      const rowEl = screen.getByTestId('reconcile-row-tx-a');
      fireEvent.click(within(rowEl).getByLabelText('Edit'));
      expect(defaults.onToggle).not.toHaveBeenCalled();
    });

    it('cycles the status from the shared status cell', () => {
      renderTable();
      const rowEl = screen.getByTestId('reconcile-row-tx-a');
      fireEvent.click(within(rowEl).getByTitle('Click to cycle status'));
      expect(defaults.onCycleStatus).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'tx-a' }),
      );
      expect(defaults.onToggle).not.toHaveBeenCalled();
    });

    it('withholds the actions on a reconciled row while the lock is on', () => {
      renderTable({
        transactions: [row({ id: 'tx-r', status: TransactionStatus.RECONCILED })],
        reconciledLocked: true,
      });
      expect(screen.queryByLabelText('Edit')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Delete')).not.toBeInTheDocument();
      expect(screen.getByText('Locked')).toBeInTheDocument();
    });

    it('keeps the actions on an unreconciled row while the lock is on', () => {
      // The lock is about reconciled rows. Hiding every action would make the
      // setting unusable for the screen it matters most on.
      renderTable({ reconciledLocked: true });
      expect(screen.getAllByLabelText('Edit').length).toBe(3);
    });
  });

  describe('stale highlighting', () => {
    it('marks nothing when the account has never been reconciled', () => {
      renderTable();
      expect(screen.queryByText('Missed')).not.toBeInTheDocument();
      expect(screen.queryByText('Overdue')).not.toBeInTheDocument();
    });

    it('marks a row the last reconciled statement left out', () => {
      renderTable({ lastReconciledDate: '2026-02-05', overdueBefore: '2026-01-01' });
      expect(screen.getByTestId('reconcile-row-tx-a')).toHaveAttribute('data-stale', 'missed');
      expect(screen.getByTestId('reconcile-row-tx-b')).toHaveAttribute('data-stale', 'missed');
      expect(screen.getByTestId('reconcile-row-tx-c')).not.toHaveAttribute('data-stale');
    });

    it('marks a row older than the overdue boundary', () => {
      renderTable({ lastReconciledDate: '2025-12-31', overdueBefore: '2026-02-08' });
      expect(screen.getByTestId('reconcile-row-tx-a')).toHaveAttribute('data-stale', 'overdue');
      expect(screen.getByTestId('reconcile-row-tx-c')).not.toHaveAttribute('data-stale');
    });

    it('survives an older backend that sends no staleness dates', () => {
      // During a rolling deploy the page can receive a response predating the
      // field. Absent means no information, so nothing is marked -- it must not
      // mark everything, and it must not throw.
      renderTable({ lastReconciledDate: null, overdueBefore: '' });
      expect(screen.queryByText('Missed')).not.toBeInTheDocument();
      expect(renderedIds()).toHaveLength(3);
    });
  });
});
