import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StrictMode } from 'react';
import { render, screen, fireEvent, act, waitFor } from '@/test/render';
import { renderHook } from '@testing-library/react';
import {
  CashFilterBar,
  CashFilterToggleButton,
  countActiveCashFilters,
  EMPTY_CASH_FILTERS,
  useCashFilterOptions,
} from './CashRegisterFilters';
import { transactionsApi } from '@/lib/transactions';

vi.mock('@/lib/transactions', () => ({
  transactionsApi: { getRegisterFilterOptions: vi.fn() },
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

const getOptions = transactionsApi.getRegisterFilterOptions as ReturnType<typeof vi.fn>;

const OPTIONS = {
  payees: [{ id: 'payee-1', name: 'Payroll' }],
  categories: [
    { id: 'cat-bills', name: 'Bills', parentId: null },
    { id: 'cat-cell', name: 'Cell Phone', parentId: 'cat-bills' },
  ],
};

function renderWithMessages(ui: React.ReactElement) {
  return render(ui);
}

describe('countActiveCashFilters', () => {
  it('counts each of the four that is narrowing the list', () => {
    expect(countActiveCashFilters(EMPTY_CASH_FILTERS)).toBe(0);
    expect(
      countActiveCashFilters({
        payeeIds: ['p'],
        categoryIds: ['c'],
        startDate: '2026-01-01',
        endDate: '2026-12-31',
      }),
    ).toBe(4);
  });

  it('counts a filled picker once, however many it holds', () => {
    expect(
      countActiveCashFilters({ ...EMPTY_CASH_FILTERS, payeeIds: ['a', 'b', 'c'] }),
    ).toBe(1);
  });
});

describe('CashFilterToggleButton', () => {
  it('shows how many filters are already applied', () => {
    renderWithMessages(<CashFilterToggleButton activeCount={2} onClick={vi.fn()} />);
    expect(screen.getByRole('button')).toHaveTextContent('2');
  });

  it('shows no count when nothing is applied', () => {
    renderWithMessages(<CashFilterToggleButton activeCount={0} onClick={vi.fn()} />);
    expect(screen.getByRole('button')).toHaveTextContent('Filter');
    expect(screen.getByRole('button')).not.toHaveTextContent('0');
  });
});

describe('CashFilterBar', () => {
  it('offers the payees it was given', async () => {
    renderWithMessages(
      <CashFilterBar options={OPTIONS} value={EMPTY_CASH_FILTERS} onChange={vi.fn()} />,
    );

    fireEvent.click(screen.getByText('All payees'));
    expect(screen.getByText('Payroll')).toBeInTheDocument();
  });

  it('nests a sub-category under the parent it came with', () => {
    // The ancestors travel with the used categories for exactly this: the
    // picker builds its top level from the rows with no parent.
    renderWithMessages(
      <CashFilterBar options={OPTIONS} value={EMPTY_CASH_FILTERS} onChange={vi.fn()} />,
    );

    fireEvent.click(screen.getByText('All categories'));
    expect(screen.getByText('Bills')).toBeInTheDocument();
    expect(screen.getByText('Cell Phone')).toBeInTheDocument();
  });

  it('reports a chosen payee as a whole filter value', () => {
    const onChange = vi.fn();
    renderWithMessages(
      <CashFilterBar options={OPTIONS} value={EMPTY_CASH_FILTERS} onChange={onChange} />,
    );

    fireEvent.click(screen.getByText('All payees'));
    fireEvent.click(screen.getByText('Payroll'));

    expect(onChange).toHaveBeenCalledWith({
      ...EMPTY_CASH_FILTERS,
      payeeIds: ['payee-1'],
    });
  });

  it('clears everything at once', () => {
    const onChange = vi.fn();
    renderWithMessages(
      <CashFilterBar
        options={OPTIONS}
        value={{ ...EMPTY_CASH_FILTERS, payeeIds: ['payee-1'], startDate: '2026-01-01' }}
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByText('Clear Filters'));

    expect(onChange).toHaveBeenCalledWith(EMPTY_CASH_FILTERS);
  });

  it('offers no clear action when nothing is applied', () => {
    renderWithMessages(
      <CashFilterBar options={OPTIONS} value={EMPTY_CASH_FILTERS} onChange={vi.fn()} />,
    );

    expect(screen.queryByText('Clear Filters')).not.toBeInTheDocument();
  });
});

describe('useCashFilterOptions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getOptions.mockResolvedValue(OPTIONS);
  });

  it('asks for the accounts on screen once the register is showing', async () => {
    const { result } = renderHook(() => useCashFilterOptions(true, ['cash-1']));

    await waitFor(() => expect(result.current.payees).toHaveLength(1));
    expect(getOptions).toHaveBeenCalledWith(['cash-1']);
  });

  it('asks for nothing while the register is not on screen', async () => {
    renderHook(() => useCashFilterOptions(false, ['cash-1']));
    await act(async () => {});

    expect(getOptions).not.toHaveBeenCalled();
  });

  it('asks again when the accounts change, and not on a bare re-render', async () => {
    const { rerender } = renderHook(
      ({ ids }: { ids: string[] }) => useCashFilterOptions(true, ids),
      { initialProps: { ids: ['cash-1'] } },
    );
    await waitFor(() => expect(getOptions).toHaveBeenCalledTimes(1));

    // A fresh array of the same ids is the same question.
    rerender({ ids: ['cash-1'] });
    await act(async () => {});
    expect(getOptions).toHaveBeenCalledTimes(1);

    rerender({ ids: ['cash-1', 'cash-2'] });
    await waitFor(() => expect(getOptions).toHaveBeenCalledTimes(2));
    expect(getOptions).toHaveBeenLastCalledWith(['cash-1', 'cash-2']);
  });

  it('still lands its options under a double-invoked effect', async () => {
    // React's development StrictMode mounts, unmounts and remounts, so a
    // cleanup flag that discards the response throws away the only request
    // that ever ran -- the second pass finds the key already claimed and starts
    // none. Both pickers then read "No options found" for the whole session,
    // which is exactly what dev showed while the tests were green.
    const { result } = renderHook(() => useCashFilterOptions(true, ['cash-1']), {
      wrapper: StrictMode,
    });

    await waitFor(() => expect(result.current.payees).toHaveLength(1));
  });

  it('leaves a failed lookup retryable rather than reporting an empty ledger', async () => {
    getOptions.mockRejectedValueOnce(new Error('offline'));
    const { rerender } = renderHook(
      ({ on }: { on: boolean }) => useCashFilterOptions(on, ['cash-1']),
      { initialProps: { on: true } },
    );
    await waitFor(() => expect(getOptions).toHaveBeenCalledTimes(1));

    // Nothing latched: coming back to the register asks again, rather than
    // showing an empty picker for the rest of the session.
    getOptions.mockResolvedValue(OPTIONS);
    rerender({ on: false });
    rerender({ on: true });
    await waitFor(() => expect(getOptions).toHaveBeenCalledTimes(2));
  });
});
