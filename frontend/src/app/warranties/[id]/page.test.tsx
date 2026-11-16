import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, within, cleanup } from '@/test/render';
import toast from 'react-hot-toast';
import { useAuthStore } from '@/store/authStore';
import type { Attachment } from '@/types/attachment';
import type { Warranty, WarrantyClaim } from '@/types/warranty';
import WarrantyDetailPage from './page';

// Stable router, as the real hook returns.
const router = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  back: vi.fn(),
  prefetch: vi.fn(),
  refresh: vi.fn(),
}));
// The route segment; a test of a malformed one swaps it and `beforeEach` puts
// it back.
const W_ID = '22222222-2222-4222-8222-222222222222';
const route = vi.hoisted(() => ({ id: '22222222-2222-4222-8222-222222222222' }));
vi.mock('next/navigation', () => ({
  useRouter: () => router,
  useParams: () => ({ id: route.id }),
  usePathname: () => `/warranties/${route.id}`,
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/components/auth/ProtectedRoute', () => ({
  ProtectedRoute: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@/components/layout/PageLayout', () => ({
  PageLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

const WARRANTY_PAYLOAD = { name: 'Laptop Pro', purchaseDate: '2026-10-01', isLifetime: true };
const CLAIM_PAYLOAD = { claimDate: '2026-10-21', status: 'open', description: 'Hinge', resolution: null, resolvedOn: null };
// Both forms are loaded through dynamic(); a stub shows which one the page
// opened and submits a fixed payload.
vi.mock('next/dynamic', () => ({
  default: () =>
    function FormStub(props: any) {
      // The purchase's TransactionForm: shows which transaction it was handed.
      if ('transaction' in props) {
        return (
          <div data-testid="transaction-form">
            <span data-testid="editing-transaction">{props.transaction.id}</span>
            <span data-testid="transaction-hosts">
              {[props.onAddWarranty, props.onOpenWarranty].filter(Boolean).length}
            </span>
            <button type="button" onClick={() => props.onSuccess()}>
              Save transaction stub
            </button>
            {props.onOpenWarranty && (
              <>
                <button type="button" onClick={() => props.onOpenWarranty(W_ID)}>
                  Open this warranty stub
                </button>
                <button
                  type="button"
                  onClick={() => props.onOpenWarranty('33333333-3333-4333-8333-333333333333')}
                >
                  Open other warranty stub
                </button>
              </>
            )}
          </div>
        );
      }
      const isClaim = 'today' in props;
      return (
        <div data-testid={isClaim ? 'claim-form' : 'warranty-form'}>
          {props.warranty && <span data-testid="editing">{props.warranty.name}</span>}
          <button
            type="button"
            onClick={() =>
              Promise.resolve(props.onSubmit(isClaim ? CLAIM_PAYLOAD : WARRANTY_PAYLOAD))
                // The warranty form hands back through onSuccess; the claim form closes in onSubmit.
                .then(() => props.onSuccess?.())
                .catch(() => {})
            }
          >
            {isClaim ? 'Submit claim stub' : 'Submit warranty stub'}
          </button>
        </div>
      );
    },
}));

const mockGetTransaction = vi.fn();
vi.mock('@/lib/transactions', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/transactions')>();
  return {
    ...original,
    transactionsApi: {
      ...original.transactionsApi,
      getById: (...args: unknown[]) => mockGetTransaction(...args),
    },
  };
});
const mockInvalidateCache = vi.fn();
vi.mock('@/lib/apiCache', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/apiCache')>()),
  invalidateCache: (...args: unknown[]) => mockInvalidateCache(...args),
}));

const mockGetById = vi.fn();
const mockUpdate = vi.fn();
const mockDelete = vi.fn();
const mockArchive = vi.fn();
const mockUnarchive = vi.fn();
const mockListClaims = vi.fn();
const mockCreateClaim = vi.fn();
const mockUpdateClaim = vi.fn();
const mockDeleteClaim = vi.fn();
const mockListAll = vi.fn();
vi.mock('@/lib/warranties', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/warranties')>()),
  warrantiesApi: {
    getById: (...args: unknown[]) => mockGetById(...args),
    listAll: (...args: unknown[]) => mockListAll(...args),
    update: (...args: unknown[]) => mockUpdate(...args),
    delete: (...args: unknown[]) => mockDelete(...args),
    archive: (...args: unknown[]) => mockArchive(...args),
    unarchive: (...args: unknown[]) => mockUnarchive(...args),
    listClaims: (...args: unknown[]) => mockListClaims(...args),
    createClaim: (...args: unknown[]) => mockCreateClaim(...args),
    updateClaim: (...args: unknown[]) => mockUpdateClaim(...args),
    deleteClaim: (...args: unknown[]) => mockDeleteClaim(...args),
  },
}));

const mockListAttachments = vi.fn();
vi.mock('@/lib/attachments', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/attachments')>()),
  attachmentsApi: {
    list: (...args: unknown[]) => mockListAttachments(...args),
    upload: vi.fn(),
    delete: vi.fn(),
    fetchBytes: vi.fn(),
    updateDocumentKind: vi.fn(),
  },
}));

// The purchase line names the account it was filed in.
vi.mock('@/lib/accounts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/accounts')>()),
  accountsApi: { getAll: vi.fn().mockResolvedValue([]) },
}));

function warranty(overrides: Partial<Warranty> = {}): Warranty {
  return {
    id: W_ID,
    name: 'Laptop',
    vendorName: 'Best Buy',
    payeeId: null,
    payee: null,
    modelNumber: 'XPS-13',
    serialNumbers: ['SN-1'],
    warrantyKind: 'manufacturer',
    purchaseDate: '2026-10-01',
    expiresOn: '2026-11-10',
    isLifetime: false,
    purchasePrice: null,
    currencyCode: null,
    productUrl: null,
    notes: null,
    today: '2026-10-21',
    status: 'expiring',
    daysLeft: 20,
    documentCount: 1,
    openClaimCount: 1,
    linkedTransactionHidden: false,
    transactionId: 'tx-1',
    linkedTransaction: {
      id: 'tx-1',
      transactionDate: '2026-10-01',
      payeeName: 'Best Buy',
      amount: -1299.99,
      currencyCode: 'USD',
      accountId: 'acc-1',
    },
    archivedAt: null,
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
    ...overrides,
  };
}

const OTHER_ID = '44444444-4444-4444-8444-444444444444';

const CLAIM: WarrantyClaim = {
  id: 'c-1',
  warrantyId: W_ID,
  claimDate: '2026-10-05',
  status: 'open',
  description: 'Screen flickers',
  resolution: null,
  resolvedOn: null,
  createdAt: '2026-10-05T00:00:00Z',
  updatedAt: '2026-10-05T00:00:00Z',
};

const DOCUMENT: Attachment = {
  id: 'a-1',
  transactionId: null,
  warrantyId: W_ID,
  documentKind: 'receipt',
  filename: 'receipt.pdf',
  contentType: 'application/pdf',
  byteSize: 2048,
  sha256: 'abc',
  createdAt: '2026-10-01T00:00:00Z',
  originalAttachmentId: null,
};

async function renderPage() {
  await act(async () => {
    render(<WarrantyDetailPage />);
  });
}

describe('WarrantyDetailPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    route.id = W_ID;
    mockGetById.mockResolvedValue(warranty());
    mockUpdate.mockResolvedValue(warranty());
    mockDelete.mockResolvedValue(undefined);
    mockArchive.mockResolvedValue(warranty({ archivedAt: '2026-10-21T00:00:00Z' }));
    mockUnarchive.mockResolvedValue(warranty());
    mockListClaims.mockResolvedValue([CLAIM]);
    mockCreateClaim.mockResolvedValue(CLAIM);
    mockUpdateClaim.mockResolvedValue(CLAIM);
    mockDeleteClaim.mockResolvedValue(undefined);
    mockListAttachments.mockResolvedValue([DOCUMENT]);
    mockListAll.mockResolvedValue([warranty(), warranty({ id: OTHER_ID, name: 'Phone', vendorName: 'Costco' })]);
  });

  afterEach(() => {
    cleanup();
    useAuthStore.setState({ actingAsUserId: null });
  });

  it('heads the page with the name and status, under a way back to the list', async () => {
    await renderPage();
    expect(mockGetById).toHaveBeenCalledWith(W_ID);
    expect(screen.getByRole('heading', { level: 1, name: 'Laptop' })).toBeInTheDocument();
    expect(screen.getByText('Expiring soon')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to Warranties' })).toHaveAttribute('href', '/warranties');
  });

  it('sizes the title-row actions as a detail header does', async () => {
    // docs/frontend/ui-conventions.md: a detail page's actions sit on the
    // title row at `size="md"`.
    await renderPage();
    // The header comes first; a claim row below carries its own Edit/Delete.
    for (const name of ['Edit', 'Archive', 'Delete']) {
      expect(screen.getAllByRole('button', { name })[0]).toHaveClass('px-4', 'py-2', 'text-base');
    }
  });

  it('renders a malformed route id as not found, without asking the server', async () => {
    route.id = 'foo';
    await renderPage();
    expect(screen.getByRole('alert')).toHaveTextContent('This warranty was not found.');
    expect(screen.getByRole('link', { name: 'Back to Warranties' })).toHaveAttribute('href', '/warranties');
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    expect(mockGetById).not.toHaveBeenCalled();
    expect(mockListClaims).not.toHaveBeenCalled();
    expect(mockListAttachments).not.toHaveBeenCalled();
  });

  it('shows the status card', async () => {
    await renderPage();
    const card = screen.getByRole('region', { name: 'Details' });
    expect(within(card).getByText('Manufacturer')).toBeInTheDocument();
    expect(within(card).getByText('XPS-13')).toBeInTheDocument();
    expect(within(card).getByText('SN-1')).toBeInTheDocument();
  });

  it('leads with the key figures as summary cards, not inside the Details list', async () => {
    await renderPage();
    const expires = screen.getByRole('article', { name: 'Expires' });
    expect(expires).toHaveTextContent('11/10/2026');
    expect(expires).toHaveTextContent('20 days left');
    expect(screen.getByRole('article', { name: 'Purchased' })).toHaveTextContent('10/01/2026');
    expect(screen.getByRole('article', { name: 'Purchase Price' })).toHaveTextContent('None');
    expect(screen.getByRole('article', { name: 'Open Claims' })).toHaveTextContent('1');
    const details = screen.getByRole('region', { name: 'Details' });
    expect(within(details).queryByText('20 days left')).not.toBeInTheDocument();
  });

  it('switches to another current warranty from the caret beside the title', async () => {
    await renderPage();
    expect(mockListAll).toHaveBeenCalledWith({ archived: false, sort: 'name', sortDir: 'asc' });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Switch warranty' }));
    });
    const menu = screen.getByRole('menu', { name: 'Switch warranty' });
    // The warranty on screen is not offered.
    expect(within(menu).queryByRole('menuitem', { name: /Laptop/ })).not.toBeInTheDocument();
    await act(async () => {
      fireEvent.click(within(menu).getByRole('menuitem', { name: /Phone/ }));
    });
    expect(router.push).toHaveBeenCalledWith(`/warranties/${OTHER_ID}`);
  });

  it('offers the archived warranties from an archived one', async () => {
    mockGetById.mockResolvedValue(warranty({ archivedAt: '2026-10-21T00:00:00Z' }));
    await renderPage();
    expect(mockListAll).toHaveBeenCalledWith({ archived: true, sort: 'name', sortDir: 'asc' });
  });

  it("lists the warranty's documents through the shared attachment section", async () => {
    await renderPage();
    expect(mockListAttachments).toHaveBeenCalledWith({ warrantyId: W_ID });
    const documents = screen.getByRole('region', { name: 'Documents' });
    expect(within(documents).getByRole('button', { name: 'Preview receipt.pdf' })).toBeInTheDocument();
    // The owner changes a document's kind on its row; the badge is the reader's.
    expect(within(documents).getByRole('combobox', { name: 'Document type for receipt.pdf' })).toHaveValue('receipt');
    expect(within(documents).queryByTestId('document-kind-a-1')).not.toBeInTheDocument();
    // A new document's kind is set on its row; the upload carries no picker.
    expect(within(documents).queryByLabelText('Document type')).not.toBeInTheDocument();
  });

  it('lists the claims and adds one', async () => {
    await renderPage();
    const claims = screen.getByRole('region', { name: 'Claims' });
    expect(within(claims).getByText('Screen flickers')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(within(claims).getByRole('button', { name: 'Add claim' }));
    });
    expect(screen.getByRole('dialog', { name: 'New claim' })).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Submit claim stub' }));
    });
    expect(mockCreateClaim).toHaveBeenCalledWith(W_ID, CLAIM_PAYLOAD);
    // The warranty is read again, so its counts follow the claim.
    expect(mockGetById).toHaveBeenCalledTimes(2);
  });

  it('edits and deletes a claim', async () => {
    await renderPage();
    const claims = screen.getByRole('region', { name: 'Claims' });
    await act(async () => {
      fireEvent.click(within(claims).getByRole('button', { name: 'Edit' }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Submit claim stub' }));
    });
    expect(mockUpdateClaim).toHaveBeenCalledWith(W_ID, 'c-1', CLAIM_PAYLOAD);

    await act(async () => {
      fireEvent.click(within(claims).getByRole('button', { name: 'Delete' }));
    });
    await act(async () => {
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }));
    });
    expect(mockDeleteClaim).toHaveBeenCalledWith(W_ID, 'c-1');
  });

  describe('the linked purchase', () => {
    const FULL_TRANSACTION = { id: 'tx-1', accountId: 'acc-1', payeeName: 'Best Buy', amount: -1299.99 };

    beforeEach(() => {
      mockGetTransaction.mockResolvedValue(FULL_TRANSACTION);
    });

    it('opens the loaded transaction in the edit window, in place', async () => {
      await renderPage();
      expect(screen.queryByTestId('transaction-form')).not.toBeInTheDocument();
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /Edit the purchase of .*Best Buy/ }));
      });
      expect(mockGetTransaction).toHaveBeenCalledWith('tx-1');
      expect(router.push).not.toHaveBeenCalled();
      const dialog = screen.getByRole('dialog', { name: 'Edit Transaction' });
      expect(within(dialog).getByTestId('editing-transaction')).toHaveTextContent('tx-1');
      // One size and padding for the TransactionForm dialog wherever it
      // opens, as on Transactions: the panel's own p-6, not Modal's md body.
      expect(dialog).toHaveClass('p-6', '!max-w-[69rem]');
      // The form links the purchase's warranties; no Add warranty on a
      // warranty's own page.
      expect(within(dialog).getByTestId('transaction-hosts')).toHaveTextContent('1');
    });

    it("closes the form on this warranty's own link, without navigating", async () => {
      await renderPage();
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /Edit the purchase of .*Best Buy/ }));
      });
      vi.useFakeTimers();
      try {
        await act(async () => {
          fireEvent.click(screen.getByRole('button', { name: 'Open this warranty stub' }));
        });
        expect(screen.queryByTestId('transaction-form')).not.toBeInTheDocument();
        await act(async () => {
          vi.advanceTimersByTime(200);
        });
        expect(router.push).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("opens another warranty only after the form has closed", async () => {
      await renderPage();
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /Edit the purchase of .*Best Buy/ }));
      });
      vi.useFakeTimers();
      try {
        await act(async () => {
          fireEvent.click(screen.getByRole('button', { name: 'Open other warranty stub' }));
        });
        expect(screen.queryByTestId('transaction-form')).not.toBeInTheDocument();
        // After the closing modal's own history step, never before it.
        expect(router.push).not.toHaveBeenCalled();
        await act(async () => {
          vi.advanceTimersByTime(200);
        });
        expect(router.push).toHaveBeenCalledWith('/warranties/33333333-3333-4333-8333-333333333333');
      } finally {
        vi.useRealTimers();
      }
    });
    it('reads the warranty again, past the cache, after the purchase is saved', async () => {
      await renderPage();
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /Edit the purchase of .*Best Buy/ }));
      });
      expect(mockGetById).toHaveBeenCalledTimes(1);
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Save transaction stub' }));
      });
      expect(mockInvalidateCache).toHaveBeenCalledWith('warranties:');
      expect(mockGetById).toHaveBeenCalledTimes(2);
      expect(screen.queryByTestId('transaction-form')).not.toBeInTheDocument();
    });

    it('says so, and opens nothing, when the purchase cannot be loaded', async () => {
      mockGetTransaction.mockRejectedValue(new Error('boom'));
      await renderPage();
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /Edit the purchase of .*Best Buy/ }));
      });
      expect(toast.error).toHaveBeenCalledWith('Failed to load the purchase');
      expect(screen.queryByTestId('transaction-form')).not.toBeInTheDocument();
    });

    it("sends a cash leg an investment owns to Investments, as the register does", async () => {
      mockGetTransaction.mockResolvedValue({ ...FULL_TRANSACTION, linkedInvestmentTransactionId: 'inv-1' });
      await renderPage();
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /Edit the purchase of .*Best Buy/ }));
      });
      expect(router.push).toHaveBeenCalledWith('/investments?edit=inv-1');
      expect(screen.queryByTestId('transaction-form')).not.toBeInTheDocument();
    });

    it('offers the register as its own link', async () => {
      await renderPage();
      expect(screen.getByRole('link', { name: 'View in register' })).toHaveAttribute(
        'href',
        '/transactions?targetTransactionId=tx-1',
      );
    });

    it('shows a delegate the purchase as a card, with the register link and no edit', async () => {
      useAuthStore.setState({ actingAsUserId: 'owner-1' });
      await renderPage();
      expect(screen.queryByRole('button', { name: /Edit the purchase/ })).not.toBeInTheDocument();
      const block = screen.getByTestId('warranty-purchase');
      expect(block.tagName).toBe('DIV');
      expect(block).toHaveTextContent('Best Buy');
      fireEvent.click(block);
      expect(mockGetTransaction).not.toHaveBeenCalled();
      expect(screen.getByRole('link', { name: 'View in register' })).toHaveAttribute(
        'href',
        '/transactions?targetTransactionId=tx-1',
      );
    });

    it('shows no register link without a purchase', async () => {
      mockGetById.mockResolvedValue(warranty({ transactionId: undefined, linkedTransaction: null }));
      await renderPage();
      expect(screen.queryByRole('link', { name: 'View in register' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Edit the purchase/ })).not.toBeInTheDocument();
    });
  });

  it('says there is no linked transaction when there is none', async () => {
    mockGetById.mockResolvedValue(warranty({ transactionId: undefined, linkedTransaction: null }));
    await renderPage();
    expect(screen.getByText('No linked transaction')).toBeInTheDocument();
  });

  it('tells a delegate the purchase is in an account they cannot read', async () => {
    useAuthStore.setState({ actingAsUserId: 'owner-1' });
    mockGetById.mockResolvedValue(
      warranty({ transactionId: undefined, linkedTransaction: null, linkedTransactionHidden: true }),
    );
    await renderPage();
    expect(screen.getByText('The purchase is in an account you cannot read.')).toBeInTheDocument();
    expect(screen.queryByText('No linked transaction')).not.toBeInTheDocument();
  });

  it('tells a delegate there is no linked transaction when the warranty has none', async () => {
    useAuthStore.setState({ actingAsUserId: 'owner-1' });
    mockGetById.mockResolvedValue(warranty({ transactionId: undefined, linkedTransaction: null }));
    await renderPage();
    expect(screen.getByText('No linked transaction')).toBeInTheDocument();
    expect(screen.queryByText(/cannot read/)).not.toBeInTheDocument();
  });

  it('shows a delegate the warranty, its documents and claims without any owner control', async () => {
    useAuthStore.setState({ actingAsUserId: 'owner-1' });
    await renderPage();

    expect(screen.getByRole('heading', { level: 1, name: 'Laptop' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Archive' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();

    const documents = screen.getByRole('region', { name: 'Documents' });
    expect(within(documents).getByRole('button', { name: 'Preview receipt.pdf' })).toBeInTheDocument();
    expect(within(documents).getByTestId('document-kind-a-1')).toHaveTextContent('Receipt');
    expect(within(documents).queryByRole('combobox', { name: /Document type for/ })).not.toBeInTheDocument();
    expect(within(documents).queryByText('Add attachment')).not.toBeInTheDocument();
    expect(within(documents).queryByText('Scan document')).not.toBeInTheDocument();
    expect(within(documents).queryByLabelText('Document type')).not.toBeInTheDocument();

    const claims = screen.getByRole('region', { name: 'Claims' });
    expect(within(claims).getByText('Screen flickers')).toBeInTheDocument();
    expect(within(claims).queryByRole('button', { name: 'Add claim' })).not.toBeInTheDocument();
  });

  it('edits the warranty in a modal', async () => {
    await renderPage();
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[0]);
    });
    expect(screen.getByRole('dialog', { name: 'Edit warranty' })).toBeInTheDocument();
    expect(screen.getByTestId('editing')).toHaveTextContent('Laptop');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Submit warranty stub' }));
    });
    expect(mockUpdate).toHaveBeenCalledWith(W_ID, WARRANTY_PAYLOAD);
    expect(toast.success).toHaveBeenCalledWith('Warranty updated');
    expect(mockGetById).toHaveBeenCalledTimes(2);
  });

  it('archives a current warranty and unarchives an archived one', async () => {
    await renderPage();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    });
    expect(mockArchive).toHaveBeenCalledWith(W_ID);
    expect(toast.success).toHaveBeenCalledWith('Warranty archived');

    cleanup();
    mockGetById.mockResolvedValue(warranty({ archivedAt: '2026-10-21T00:00:00Z' }));
    await renderPage();
    expect(screen.getByText('Archived')).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Unarchive' }));
    });
    expect(mockUnarchive).toHaveBeenCalledWith(W_ID);
  });

  it('deletes the warranty after confirmation and returns to the list', async () => {
    await renderPage();
    // The header's Delete comes first; each claim row carries its own.
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: 'Delete' })[0]);
    });
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('Delete "Laptop"?');
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    });
    expect(mockDelete).toHaveBeenCalledWith(W_ID);
    expect(router.push).toHaveBeenCalledWith('/warranties');
  });

  it('says the warranty could not be loaded and retries', async () => {
    mockGetById.mockRejectedValueOnce(new Error('404'));
    await renderPage();
    expect(screen.getByRole('alert')).toHaveTextContent('This warranty could not be loaded.');
    expect(screen.getByRole('link', { name: 'Back to Warranties' })).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    });
    expect(screen.getByRole('heading', { level: 1, name: 'Laptop' })).toBeInTheDocument();
  });
});
