import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@/test/render';
import { useAuthStore } from '@/store/authStore';
import type { Warranty } from '@/types/warranty';
import { WarrantyDetailCard } from './WarrantyDetailCard';

const mockGetPayee = vi.fn();
vi.mock('@/lib/payees', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/payees')>()),
  payeesApi: { getById: (...args: unknown[]) => mockGetPayee(...args) },
}));
const mockGetAccounts = vi.fn();
vi.mock('@/lib/accounts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/accounts')>()),
  accountsApi: { getAll: (...args: unknown[]) => mockGetAccounts(...args) },
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

/** Renders and lets the account read settle. */
async function renderCard(w: Warranty) {
  let result!: ReturnType<typeof render>;
  await act(async () => {
    result = render(<WarrantyDetailCard warranty={w} />);
  });
  return result;
}

function warranty(overrides: Partial<Warranty> = {}): Warranty {
  return {
    id: 'w-1',
    name: 'Laptop',
    vendorName: 'Best Buy',
    payeeId: 'p-1',
    payee: { id: 'p-1', name: 'Best Buy', hasLogo: true },
    modelNumber: 'XPS-13',
    serialNumbers: ['SN-1', 'SN-2'],
    warrantyKind: 'extended',
    purchaseDate: '2026-10-01',
    expiresOn: '2028-10-01',
    isLifetime: false,
    purchasePrice: 1299.99,
    currencyCode: 'CAD',
    productUrl: 'https://example.com/laptop',
    notes: 'Keep the box',
    today: '2026-10-21',
    status: 'active',
    daysLeft: 711,
    documentCount: 0,
    openClaimCount: 0,
    linkedTransactionHidden: false,
    transactionId: 'tx-1',
    linkedTransaction: {
      id: 'tx-1',
      transactionDate: '2026-10-01',
      payeeName: 'Best Buy',
      // A decimal crosses the wire as a string.
      amount: '-1299.9900' as unknown as number,
      currencyCode: 'CAD',
      accountId: 'acc-1',
    },
    archivedAt: null,
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
    ...overrides,
  };
}

describe('WarrantyDetailCard', () => {
  beforeEach(() => {
    mockGetPayee.mockReset();
    mockGetAccounts.mockReset();
    mockGetAccounts.mockResolvedValue([{ id: 'acc-1', name: 'Visa' }]);
  });

  afterEach(() => {
    cleanup();
    useAuthStore.setState({ actingAsUserId: null });
  });

  it('shows what the warranty is from the server view', async () => {
    await renderCard(warranty());
    expect(screen.getByText('Extended')).toBeInTheDocument();
    expect(screen.getByText('XPS-13')).toBeInTheDocument();
    expect(screen.getByText('SN-1')).toBeInTheDocument();
    expect(screen.getByText('SN-2')).toBeInTheDocument();
    // Expiry, days left, purchase date and price are the summary row's.
    expect(screen.queryByText('1 year, 346 days left')).not.toBeInTheDocument();
    expect(screen.queryByText('$1,299.99 CAD')).not.toBeInTheDocument();
    expect(screen.getByText('Keep the box')).toBeInTheDocument();
  });

  it('links the vendor to its payee, and leaves a typed vendor as text', async () => {
    await renderCard(warranty());
    expect(screen.getByRole('link', { name: 'Best Buy' })).toHaveAttribute('href', '/payees/p-1');

    cleanup();
    await renderCard(
      warranty({ payeeId: null, payee: null, vendorName: 'Corner shop', linkedTransaction: null, transactionId: undefined }),
    );
    expect(screen.getByText('Corner shop')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Corner shop' })).not.toBeInTheDocument();
  });

  it('opens the product page in a new tab without a handle on this one', async () => {
    await renderCard(warranty());
    const link = screen.getByRole('link', { name: /example\.com\/laptop/ });
    expect(link).toHaveAttribute('href', 'https://example.com/laptop');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('never makes a link of an address that is not http or https', async () => {
    await renderCard(warranty({ productUrl: 'javascript:alert(1)' }));
    expect(screen.getByText('javascript:alert(1)')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /javascript/ })).not.toBeInTheDocument();
  });

  it('says None for the fields that are not filled in', async () => {
    await renderCard(warranty({
          vendorName: null,
          payeeId: null,
          payee: null,
          modelNumber: null,
          serialNumbers: [],
          purchasePrice: null,
          currencyCode: null,
          productUrl: null,
          notes: null,
        }));
    expect(screen.getAllByText('None')).toHaveLength(5);
  });

  it('edits the purchase in place, named by its date, payee and amount in its currency', async () => {
    const onEditPurchase = vi.fn();
    await act(async () => {
      render(<WarrantyDetailCard warranty={warranty()} onEditPurchase={onEditPurchase} />);
    });
    const block = screen.getByRole('button', {
      name: 'Edit the purchase of 10/01/2026: Best Buy, -$1,299.99 CAD',
    });
    expect(block).toHaveAttribute('data-testid', 'warranty-purchase');
    expect(block.className).toContain('focus-visible:ring-2');
    fireEvent.click(block);
    expect(onEditPurchase).toHaveBeenCalledWith('tx-1');
    expect(screen.getByRole('link', { name: 'View in register' })).toHaveAttribute(
      'href',
      '/transactions?targetTransactionId=tx-1',
    );
  });

  it('draws the purchase as a card, not a control, without an edit handler', async () => {
    await renderCard(warranty());
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByTestId('warranty-purchase').tagName).toBe('DIV');
    expect(screen.getByRole('link', { name: 'View in register' })).toHaveAttribute(
      'href',
      '/transactions?targetTransactionId=tx-1',
    );
  });

  it('says there is no linked transaction when the owner has none', async () => {
    await renderCard(warranty({ transactionId: undefined, linkedTransaction: null }));
    expect(screen.getByText('No linked transaction')).toBeInTheDocument();
    expect(screen.queryByText(/cannot read/)).not.toBeInTheDocument();
  });

  it('tells a delegate the purchase is in an account they cannot read, not that there is none', async () => {
    useAuthStore.setState({ actingAsUserId: 'owner-1' });
    await renderCard(warranty({ transactionId: undefined, linkedTransaction: null, linkedTransactionHidden: true }));
    expect(screen.getByText('The purchase is in an account you cannot read.')).toBeInTheDocument();
    expect(screen.queryByText('No linked transaction')).not.toBeInTheDocument();
  });

  it('tells a delegate there is no linked transaction when the server says none is hidden', async () => {
    useAuthStore.setState({ actingAsUserId: 'owner-1' });
    await renderCard(warranty({ transactionId: undefined, linkedTransaction: null }));
    expect(screen.getByText('No linked transaction')).toBeInTheDocument();
    expect(screen.queryByText(/cannot read/)).not.toBeInTheDocument();
  });

  it('shows a delegate the purchase when the server sent it', async () => {
    useAuthStore.setState({ actingAsUserId: 'owner-1' });
    await renderCard(warranty());
    const block = screen.getByTestId('warranty-purchase');
    expect(block).toHaveTextContent('Best Buy');
    expect(block).toHaveTextContent('-$1,299.99 CAD');
  });

  describe('vendor and purchase logos', () => {
    it("draws the vendor's logo beside the Vendor value from the view's payee, reading no payee", async () => {
      await renderCard(warranty());
      expect(mockGetPayee).not.toHaveBeenCalled();
      const vendorLink = screen.getByRole('link', { name: 'Best Buy' });
      const logo = vendorLink.parentElement?.querySelector('img');
      expect(logo).toHaveAttribute('src', '/api/v1/payees/p-1/logo');
    });

    it('draws the initial when the payee has no logo', async () => {
      await renderCard(warranty({ payee: { id: 'p-1', name: 'Best Buy', hasLogo: false } }));
      expect(screen.queryByRole('img')).not.toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Best Buy' }).parentElement).toHaveTextContent('BBest Buy');
    });

    it('shows a typed vendor as text alone and reads no payee', async () => {
      await renderCard(
        warranty({ payeeId: null, payee: null, vendorName: 'Corner shop', linkedTransaction: null, transactionId: undefined }),
      );
      expect(mockGetPayee).not.toHaveBeenCalled();
      const value = screen.getByText('Corner shop');
      expect(value.tagName).toBe('DD');
      expect(value.children).toHaveLength(0);
    });

    it("leads with the purchase: the vendor's logo, the server's payee, date, account and amount", async () => {
      await renderCard(warranty());
      const block = screen.getByTestId('warranty-purchase');
      expect(block.tagName).toBe('DIV');
      expect(block.querySelector('img')).toHaveAttribute('src', '/api/v1/payees/p-1/logo');
      expect(block).toHaveTextContent('Best Buy');
      expect(block).toHaveTextContent('10/01/2026 · Visa');
      expect(block).toHaveTextContent('-$1,299.99 CAD');
      expect(mockGetAccounts).toHaveBeenCalledWith(true);
    });

    it('shows the date alone when the account cannot be read', async () => {
      mockGetAccounts.mockRejectedValue(new Error('boom'));
      await renderCard(warranty());
      const block = screen.getByTestId('warranty-purchase');
      expect(block).toHaveTextContent('10/01/2026');
      expect(block).not.toHaveTextContent('·');
    });

    it('keeps the block shape, with a placeholder, for no purchase and a hidden one', async () => {
      await renderCard(warranty({ transactionId: undefined, linkedTransaction: null }));
      let block = screen.getByTestId('warranty-purchase');
      expect(block.tagName).toBe('DIV');
      expect(block).toHaveTextContent('No linked transaction');
      cleanup();
      await renderCard(warranty({ transactionId: undefined, linkedTransaction: null, linkedTransactionHidden: true }));
      block = screen.getByTestId('warranty-purchase');
      expect(block).toHaveTextContent('The purchase is in an account you cannot read.');
      expect(block.querySelector('img')).toBeNull();
      expect(mockGetAccounts).not.toHaveBeenCalled();
      expect(screen.queryByRole('link', { name: 'View in register' })).not.toBeInTheDocument();
    });
  });
});
