import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, fireEvent } from '@/test/render';
import type { Warranty } from '@/types/warranty';
import { TransactionWarrantiesLine } from './TransactionWarrantiesLine';

const mockList = vi.fn();
vi.mock('@/lib/warranties', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/warranties')>()),
  warrantiesApi: {
    list: (...args: unknown[]) => mockList(...args),
  },
}));
vi.mock('@/hooks/useDateFormat', () => ({
  useDateFormat: () => ({ formatDate: (d: string) => `D(${d})` }),
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

function makeWarranty(overrides: Partial<Warranty> = {}): Warranty {
  return {
    id: 'w-1',
    name: 'Dishwasher',
    vendorName: null,
    payeeId: null,
    payee: null,
    modelNumber: null,
    serialNumbers: [],
    warrantyKind: 'manufacturer',
    purchaseDate: '2026-01-10',
    expiresOn: '2028-01-10',
    isLifetime: false,
    purchasePrice: null,
    currencyCode: null,
    productUrl: null,
    notes: null,
    today: '2026-10-21',
    status: 'active',
    daysLeft: 446,
    documentCount: 0,
    openClaimCount: 0,
    linkedTransactionHidden: false,
    transactionId: 'tx-1',
    linkedTransaction: null,
    archivedAt: null,
    createdAt: '2026-01-10T00:00:00Z',
    updatedAt: '2026-01-10T00:00:00Z',
    ...overrides,
  };
}

describe('TransactionWarrantiesLine', () => {
  beforeEach(() => {
    mockList.mockReset();
  });

  it('with no warranties says there are none yet and fetches nothing', () => {
    render(
      <TransactionWarrantiesLine transaction={{ id: 'tx-1', warrantyCount: 0 }} onAddWarranty={vi.fn()} />,
    );
    expect(screen.getByRole('button', { name: 'Add warranty' })).toBeInTheDocument();
    expect(screen.getByText('No warranties yet')).toBeInTheDocument();
    expect(screen.queryAllByRole('link')).toHaveLength(0);
    expect(mockList).not.toHaveBeenCalled();
  });

  it('reads an absent count as none and fetches nothing', () => {
    render(<TransactionWarrantiesLine transaction={{ id: 'tx-1' }} onAddWarranty={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Add warranty' })).toBeInTheDocument();
    expect(mockList).not.toHaveBeenCalled();
  });

  it('Add warranty hands the navigation to the host rather than linking away', () => {
    // A link would leave the edit window without its unsaved-changes check;
    // the host closes the window through its own close path first.
    const onAddWarranty = vi.fn();
    render(
      <TransactionWarrantiesLine transaction={{ id: 'tx-1', warrantyCount: 0 }} onAddWarranty={onAddWarranty} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add warranty' }));
    expect(onAddWarranty).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('link', { name: 'Add warranty' })).not.toBeInTheDocument();
  });

  it('offers no Add when the host supplies no handler', () => {
    render(<TransactionWarrantiesLine transaction={{ id: 'tx-1', warrantyCount: 0 }} />);
    expect(screen.queryByRole('button', { name: 'Add warranty' })).not.toBeInTheDocument();
  });

  it('lists the linked warranties, each a link to its detail', async () => {
    mockList.mockResolvedValue({
      data: [
        makeWarranty(),
        makeWarranty({ id: 'w-2', name: 'Drill', expiresOn: null, isLifetime: true, status: 'lifetime', daysLeft: null }),
      ],
      pagination: { page: 1, limit: 50, total: 2, totalPages: 1, hasMore: false },
    });
    await act(async () => {
      render(
        <TransactionWarrantiesLine
          transaction={{ id: 'tx-1', warrantyCount: 2 }}
          onAddWarranty={vi.fn()}
          onOpenWarranty={vi.fn()}
        />,
      );
    });
    expect(mockList).toHaveBeenCalledWith({ transactionId: 'tx-1' });
    const dishwasher = screen.getByRole('link', { name: /Dishwasher/ });
    expect(dishwasher).toHaveAttribute('href', '/warranties/w-1');
    expect(dishwasher).toHaveTextContent('Active');
    expect(dishwasher).toHaveTextContent('Expires D(2028-01-10)');
    const drill = screen.getByRole('link', { name: /Drill/ });
    expect(drill).toHaveAttribute('href', '/warranties/w-2');
    expect(drill).toHaveTextContent('Lifetime');
    expect(drill).not.toHaveTextContent('Expires');
    expect(screen.getByRole('button', { name: 'Add warranty' })).toBeInTheDocument();
    expect(screen.queryByText('No warranties yet')).not.toBeInTheDocument();
  });

  it('says there are none yet when the count was stale and the list comes back empty', async () => {
    mockList.mockResolvedValue({
      data: [],
      pagination: { page: 1, limit: 50, total: 0, totalPages: 0, hasMore: false },
    });
    await act(async () => {
      render(<TransactionWarrantiesLine transaction={{ id: 'tx-1', warrantyCount: 1 }} onOpenWarranty={vi.fn()} />);
    });
    expect(screen.getByText('No warranties yet')).toBeInTheDocument();
    expect(screen.queryAllByRole('link')).toHaveLength(0);
  });

  it('says the list failed rather than showing an empty one', async () => {
    mockList.mockRejectedValue(new Error('boom'));
    await act(async () => {
      render(<TransactionWarrantiesLine transaction={{ id: 'tx-1', warrantyCount: 1 }} onOpenWarranty={vi.fn()} />);
    });
    expect(screen.getByRole('alert')).toHaveTextContent(
      'The warranties for this transaction could not be loaded.',
    );
    expect(screen.queryAllByRole('link')).toHaveLength(0);
    expect(screen.queryByText('No warranties yet')).not.toBeInTheDocument();
  });

  it('shows a loading line until the list arrives', async () => {
    let resolve: (value: unknown) => void = () => {};
    mockList.mockReturnValue(new Promise((r) => { resolve = r; }));
    render(<TransactionWarrantiesLine transaction={{ id: 'tx-1', warrantyCount: 1 }} onOpenWarranty={vi.fn()} />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading warranties');
    expect(screen.queryByText('No warranties yet')).not.toBeInTheDocument();
    await act(async () => {
      resolve({ data: [makeWarranty()], pagination: { page: 1, limit: 50, total: 1, totalPages: 1, hasMore: false } });
    });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Dishwasher/ })).toBeInTheDocument();
  });

  describe('opening a warranty', () => {
    // The line sits in a pushHistory Modal: a link's own navigation is undone
    // when the closing Modal pops its history entry, so a plain click goes to
    // the host, which closes the window first.
    beforeEach(() => {
      mockList.mockResolvedValue({
        data: [makeWarranty()],
        pagination: { page: 1, limit: 50, total: 1, totalPages: 1, hasMore: false },
      });
    });

    it('hands a plain click to the host instead of following the link', async () => {
      const onOpenWarranty = vi.fn();
      await act(async () => {
        render(<TransactionWarrantiesLine transaction={{ id: 'tx-1', warrantyCount: 1 }} onOpenWarranty={onOpenWarranty} />);
      });
      const link = screen.getByRole('link', { name: /Dishwasher/ });
      const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
      fireEvent(link, event);
      expect(onOpenWarranty).toHaveBeenCalledWith('w-1');
      expect(event.defaultPrevented).toBe(true);
    });

    it('leaves a modified click to the browser, so a new tab still opens', async () => {
      const onOpenWarranty = vi.fn();
      await act(async () => {
        render(<TransactionWarrantiesLine transaction={{ id: 'tx-1', warrantyCount: 1 }} onOpenWarranty={onOpenWarranty} />);
      });
      fireEvent.click(screen.getByRole('link', { name: /Dishwasher/ }), { ctrlKey: true });
      fireEvent.click(screen.getByRole('link', { name: /Dishwasher/ }), { button: 1 });
      expect(onOpenWarranty).not.toHaveBeenCalled();
    });

    it('lists the warranties without links when the host cannot close first', async () => {
      await act(async () => {
        render(<TransactionWarrantiesLine transaction={{ id: 'tx-1', warrantyCount: 1 }} />);
      });
      expect(screen.getByText('Dishwasher')).toBeInTheDocument();
      expect(screen.queryAllByRole('link')).toHaveLength(0);
    });

    it('lists warranties only, never their documents', async () => {
      mockList.mockResolvedValue({
        data: [makeWarranty({ documentCount: 3 })],
        pagination: { page: 1, limit: 50, total: 1, totalPages: 1, hasMore: false },
      });
      await act(async () => {
        render(<TransactionWarrantiesLine transaction={{ id: 'tx-1', warrantyCount: 1 }} onOpenWarranty={vi.fn()} />);
      });
      // The documents are in the Attachments section above.
      expect(screen.getByTestId('transaction-warranties')).not.toHaveTextContent('3');
    });
  });
});
