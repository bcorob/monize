import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, waitFor, fireEvent, cleanup } from '@/test/render';
import { TransactionList } from './TransactionList';
import { Transaction, TransactionStatus } from '@/types/transaction';
import { useDensityStore } from '@/store/densityStore';
import { usePreferencesStore } from '@/store/preferencesStore';

/**
 * Model B: on a phone the density toggle picks the LAYOUT, not only the row
 * height. At Normal density each register row is a wrapped two-line card in a
 * single `<td>` (more of the register visible, no horizontal scroll); Compact
 * and Dense keep the tier table, and so does every non-phone width.
 *
 * These are the three combinations that decide it. The rest of the register's
 * suite runs under the harness's default `matchMedia` (`matches: false`), so
 * it exercises the desktop tier table exactly as before -- which is the point
 * of choosing the branch in JS rather than with CSS variants.
 */

vi.mock('@/lib/transactions', () => ({
  transactionsApi: {
    delete: vi.fn(),
    deleteTransfer: vi.fn(),
    updateStatus: vi.fn(),
  },
}));

vi.mock('@/hooks/useDateFormat', () => ({
  useDateFormat: () => ({
    dateFormat: 'browser',
    datePattern: 'YYYY-MM-DD',
    formatDate: (d: string) => d,
    formatDateWithoutYear: (d: Date | string) => String(d).slice(5),
  }),
}));

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({
      ...numberFormatMockDefaults(),
      formatCurrency: (n: number) => `$${n.toFixed(2)}`,
    }),
  };
});

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

const PHONE_QUERY = '(max-width: 639px)';

const originalMatchMedia = window.matchMedia;

/** Answer `true` only for the phone query `useIsMobile` asks. */
function setPhoneViewport(isPhone: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: isPhone && query === PHONE_QUERY,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

function createTransaction(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: '123e4567-e89b-12d3-a456-426614174000',
    userId: 'user-1',
    accountId: 'acc-1',
    account: { id: 'acc-1', name: 'Chequing', accountType: 'CHEQUING' } as any,
    transactionDate: '2024-01-15',
    payeeId: 'payee-1',
    payeeName: 'Grocery Store',
    payee: null,
    categoryId: 'cat-1',
    category: { id: 'cat-1', name: 'Groceries', color: '#22c55e' } as any,
    amount: -50.0,
    currencyCode: 'CAD',
    exchangeRate: 1,
    originalAmount: null,
    originalCurrencyCode: null,
    description: 'Weekly groceries',
    referenceNumber: null,
    status: TransactionStatus.UNRECONCILED,
    isCleared: false,
    isReconciled: false,
    isVoid: false,
    reconciledDate: null,
    isSplit: false,
    parentTransactionId: null,
    isTransfer: false,
    linkedTransactionId: null,
    createdAt: '2024-01-15T00:00:00Z',
    updatedAt: '2024-01-15T00:00:00Z',
    ...overrides,
  };
}

function bodyRows(container: HTMLElement): HTMLTableRowElement[] {
  return Array.from(container.querySelectorAll('tbody tr'));
}

describe('the register on a phone', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
  });

  it('renders each row as a wrapped card at Normal density', async () => {
    setPhoneViewport(true);
    useDensityStore.setState({ densities: { transactions: 'normal' } });

    const { container } = render(
      <TransactionList
        transactions={[createTransaction()]}
        onEdit={vi.fn()}
        onRefresh={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('Grocery Store')).toBeInTheDocument();
    });

    const rows = bodyRows(container);
    expect(rows).toHaveLength(1);
    // The whole card lives in one cell -- that is what makes it a card
    // rather than a table row with the columns squeezed.
    expect(rows[0].querySelectorAll('td')).toHaveLength(1);

    // The full column header is replaced by a slim control header: one cell,
    // none of the column labels, but the day/month date toggle still reachable.
    const head = container.querySelector('thead');
    expect(head).toBeTruthy();
    expect(head!.querySelectorAll('th')).toHaveLength(1);
    expect(head!.textContent).not.toContain('Category');
    expect(head!.querySelector('button')).toBeTruthy();

    // More of the register than a phone-width tier table shows, all in the
    // one row: payee, amount, category and status.
    const text = rows[0].textContent ?? '';
    expect(text).toContain('Grocery Store');
    expect(text).toContain('-$50.00');
    expect(text).toContain('Groceries');
    expect(text).toContain('Pending');

    // The row actions stay in the long-press action sheet on phones.
    expect(text).not.toContain('Edit');
    expect(text).not.toContain('Delete');
  });

  it('puts the tags on a line of their own under the category, and only when there are any', async () => {
    setPhoneViewport(true);
    useDensityStore.setState({ densities: { transactions: 'normal' } });

    const tags = [
      { id: 'tag-1', name: 'Reimbursable', color: '#f59e0b' },
      { id: 'tag-2', name: 'Vacation', color: '#3b82f6' },
    ] as Transaction['tags'];
    const { container } = render(
      <TransactionList
        transactions={[
          createTransaction({ id: 'tx-tagged', tags }),
          createTransaction({ id: 'tx-plain' }),
        ]}
        onEdit={vi.fn()}
        onRefresh={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('Vacation')).toBeInTheDocument();
    });

    const [tagged, plain] = bodyRows(container);
    // Inline after the category, a single tag pushed the status and balance
    // onto a line of their own; the tags now take that line themselves,
    // under the category, and the second line keeps its shape.
    const taggedLines = Array.from(tagged.querySelectorAll('.col-span-3'));
    expect(taggedLines).toHaveLength(2);
    const [line2, tagLine] = taggedLines;
    expect(line2.textContent).toContain('Groceries');
    expect(line2.textContent).toContain('Pending');
    expect(line2.textContent).not.toContain('Reimbursable');
    expect(tagLine.textContent).toContain('Reimbursable');
    expect(tagLine.textContent).toContain('Vacation');
    expect(tagLine.textContent).not.toContain('Pending');

    // A row with no tags does not grow an empty third line.
    expect(plain.querySelectorAll('.col-span-3')).toHaveLength(1);
  });

  it('shows the attachment count left of the category, and nothing at all for a row without one', async () => {
    setPhoneViewport(true);
    useDensityStore.setState({ densities: { transactions: 'normal' } });

    const { container } = render(
      <TransactionList
        transactions={[
          createTransaction({ id: 'tx-attached', attachmentCount: 2 }),
          createTransaction({ id: 'tx-plain', attachmentCount: 0 }),
        ]}
        onEdit={vi.fn()}
        onRefresh={vi.fn()}
        isSingleAccountView
      />,
    );

    await waitFor(() => {
      expect(screen.getAllByText('Grocery Store')).toHaveLength(2);
    });

    const [attached, plain] = bodyRows(container);

    // The same badge the tier table's Attachments column shows, in the
    // category line and before the category pill.
    const line2 = attached.querySelector('.col-span-3')!;
    const badge = line2.querySelector('[data-testid="attachment-badge"]');
    expect(badge).toBeTruthy();
    expect(badge!.getAttribute('aria-label')).toBe('2 attachments');
    expect(badge!.textContent).toContain('2');
    const category = screen.getAllByText('Groceries')[0];
    expect(
      badge!.compareDocumentPosition(category) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    // A row with no attachments renders neither the badge nor the tier
    // cell's dash: the category is the line's first element, flush left.
    const plainLine2 = plain.querySelector('.col-span-3')!;
    expect(plainLine2.querySelector('[data-testid="attachment-badge"]')).toBeNull();
    const text = plainLine2.textContent ?? '';
    // Nothing precedes the category -- the trailing dash further along the
    // line is the running-balance placeholder, not an attachment cell.
    expect(text.slice(0, text.indexOf('Groceries'))).toBe('');
    expect(plainLine2.firstElementChild?.textContent).toContain('Groceries');
  });

  it('keeps the tier table at Compact density', async () => {
    setPhoneViewport(true);
    useDensityStore.setState({ densities: { transactions: 'compact' } });

    const { container } = render(
      <TransactionList
        transactions={[createTransaction()]}
        onEdit={vi.fn()}
        onRefresh={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('Grocery Store')).toBeInTheDocument();
    });

    const rows = bodyRows(container);
    expect(rows).toHaveLength(1);
    expect(rows[0].querySelectorAll('td').length).toBeGreaterThan(1);
    expect(container.querySelector('thead')!.className).not.toContain('hidden');
  });

  it('keeps the tier table on a desktop width at Normal density', async () => {
    setPhoneViewport(false);
    useDensityStore.setState({ densities: { transactions: 'normal' } });

    const { container } = render(
      <TransactionList
        transactions={[createTransaction()]}
        onEdit={vi.fn()}
        onRefresh={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('Grocery Store')).toBeInTheDocument();
    });

    const rows = bodyRows(container);
    expect(rows).toHaveLength(1);
    expect(rows[0].querySelectorAll('td').length).toBeGreaterThan(1);
    expect(container.querySelector('thead')!.querySelectorAll('th').length).toBeGreaterThan(1);
  });

  it('keeps the tier table on a foreign-currency fee surface at Normal density', async () => {
    // showFxColumns is the FX fees report/section, whose subject is the
    // paid-currency / amount / fee columns the card does not carry -- so it
    // stays a table even on a phone at Normal density.
    setPhoneViewport(true);
    useDensityStore.setState({ densities: { transactions: 'normal' } });

    const { container } = render(
      <TransactionList
        transactions={[createTransaction()]}
        onEdit={vi.fn()}
        onRefresh={vi.fn()}
        showFxColumns
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('Grocery Store')).toBeInTheDocument();
    });

    const rows = bodyRows(container);
    expect(rows[0].querySelectorAll('td').length).toBeGreaterThan(1);
    expect(container.querySelector('thead')!.querySelectorAll('th').length).toBeGreaterThan(1);
  });

  it('keeps the select-all-on-page box in the slim header in selection mode', async () => {
    // Hiding the header outright would have taken the select-all control with
    // it; the slim control header keeps it reachable on a phone.
    setPhoneViewport(true);
    useDensityStore.setState({ densities: { transactions: 'normal' } });

    const { container } = render(
      <TransactionList
        transactions={[createTransaction()]}
        onEdit={vi.fn()}
        onRefresh={vi.fn()}
        selectionMode
        isAllOnPageSelected={false}
        onToggleAllOnPage={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('Grocery Store')).toBeInTheDocument();
    });

    const head = container.querySelector('thead');
    expect(head!.querySelector('input[type="checkbox"]')).toBeTruthy();
  });
});

describe('the sort strip on a phone', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
  });

  const renderPhone = (
    props: Partial<React.ComponentProps<typeof TransactionList>> = {},
  ) => {
    setPhoneViewport(true);
    useDensityStore.setState({ densities: { transactions: 'normal' } });
    const onSortChange = vi.fn();
    const utils = render(
      <TransactionList
        transactions={[createTransaction()]}
        onEdit={vi.fn()}
        onRefresh={vi.fn()}
        sort={{ field: 'date', direction: 'desc' }}
        onSortChange={onSortChange}
        {...props}
      />,
    );
    return { ...utils, onSortChange };
  };

  it('brings every sort control back as a chip, since the card has no headers', async () => {
    const { container } = renderPhone();

    await waitFor(() => {
      expect(screen.getByText('Grocery Store')).toBeInTheDocument();
    });

    const strip = container.querySelector('thead tr[aria-label="Sort by"]');
    expect(strip).toBeTruthy();
    // A field with no chip would strand a remembered sort: the register would
    // stay in that order with no control on this screen to change it.
    for (const label of ['Date', 'Account', 'Payee', 'Category', 'Amount', 'Status']) {
      expect(strip!.textContent).toContain(label);
    }
  });

  it('offers no Description or Ref # chip, since the card shows neither', async () => {
    // The page resolves a remembered sort on either to the date sort while the
    // card is drawn, so dropping the chips strands nothing.
    const { container } = renderPhone();

    await waitFor(() => {
      expect(screen.getByText('Grocery Store')).toBeInTheDocument();
    });

    const strip = container.querySelector('thead tr[aria-label="Sort by"]')!;
    expect(strip.textContent).not.toContain('Description');
    expect(strip.textContent).not.toContain('Ref #');
  });

  it('leads the strip with the date toggle and select-all, on one header row', async () => {
    const { container } = renderPhone({ selectionMode: true, onToggleAllOnPage: vi.fn() });

    await waitFor(() => {
      expect(screen.getByText('Grocery Store')).toBeInTheDocument();
    });

    // A slim control row above the strip spent a second line of a phone
    // screen on one small button.
    const head = container.querySelector('thead')!;
    expect(head.querySelectorAll('tr')).toHaveLength(1);
    const strip = head.querySelector('tr[aria-label="Sort by"]')!;
    expect(strip.querySelector('input[type="checkbox"]')).toBeTruthy();
    const toggle = screen.getByRole('button', { name: /hide the year/i });
    expect(strip.contains(toggle)).toBe(true);
  });

  it('sorts from a chip', async () => {
    const { container, onSortChange } = renderPhone();

    await waitFor(() => {
      expect(screen.getByText('Grocery Store')).toBeInTheDocument();
    });

    const strip = container.querySelector('thead tr[aria-label="Sort by"]')!;
    const amountChip = Array.from(strip.querySelectorAll('[role="columnheader"]')).find(
      (chip) => chip.textContent?.includes('Amount'),
    )!;
    fireEvent.click(amountChip);
    expect(onSortChange).toHaveBeenCalledWith('amount');
  });

  it('offers no Account chip where there is no Account column', async () => {
    const { container } = renderPhone({ isSingleAccountView: true, startingBalance: 10 });

    await waitFor(() => {
      expect(screen.getByText('Grocery Store')).toBeInTheDocument();
    });

    const strip = container.querySelector('thead tr[aria-label="Sort by"]')!;
    expect(strip.textContent).not.toContain('Account');
  });

  it('draws no strip where the surface offers no sorting', async () => {
    setPhoneViewport(true);
    useDensityStore.setState({ densities: { transactions: 'normal' } });
    const { container } = render(
      <TransactionList
        transactions={[createTransaction()]}
        onEdit={vi.fn()}
        onRefresh={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('Grocery Store')).toBeInTheDocument();
    });
    expect(container.querySelector('thead tr[aria-label="Sort by"]')).toBeNull();
  });
});

describe('the phone card with a hidden column', () => {
  // Hidden is absent at every width, the card included: the status pill,
  // the attachment badge and the tags line each follow the stored set, and
  // the sort strip omits a hidden column's chip the way it omits Account's.
  const tags = [{ id: 'tag-1', name: 'Reimbursable', color: '#f59e0b' }] as Transaction['tags'];

  const seed = (transactions: string[]) =>
    usePreferencesStore.setState({
      preferences: { hiddenTableColumns: { transactions } } as any,
    });

  beforeEach(() => {
    vi.clearAllMocks();
    setPhoneViewport(true);
    useDensityStore.setState({ densities: { transactions: 'normal' } });
  });

  afterEach(() => {
    // `cleanup()` first: a store write with the tree still mounted re-renders
    // it outside act (`src/test/test-hygiene.test.ts`).
    cleanup();
    window.matchMedia = originalMatchMedia;
    usePreferencesStore.setState({ preferences: null });
  });

  it('drops the status pill from the card and the Status chip from the strip', async () => {
    seed(['status']);
    const { container } = render(
      <TransactionList
        transactions={[createTransaction()]}
        onEdit={vi.fn()}
        onRefresh={vi.fn()}
        sort={{ field: 'date', direction: 'desc' }}
        onSortChange={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText('Grocery Store')).toBeInTheDocument();
    });
    const [row] = bodyRows(container);
    expect(row.textContent).not.toContain('Pending');
    expect(screen.queryByTitle('Click to cycle status')).not.toBeInTheDocument();
    const strip = container.querySelector('thead tr[aria-label="Sort by"]')!;
    expect(strip.textContent).not.toContain('Status');
    expect(strip.textContent).toContain('Date');
  });

  it('drops the tags line from the card', async () => {
    seed(['tags']);
    const { container } = render(
      <TransactionList
        transactions={[createTransaction({ tags })]}
        onEdit={vi.fn()}
        onRefresh={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText('Grocery Store')).toBeInTheDocument();
    });
    const [row] = bodyRows(container);
    expect(row.textContent).not.toContain('Reimbursable');
    // Back to two lines: only the category line carries `col-span-3`.
    expect(row.querySelectorAll('.col-span-3')).toHaveLength(1);
    // The pill is not hidden, so line 2 keeps it.
    expect(row.textContent).toContain('Pending');
  });

  it('drops the attachment badge from the card', async () => {
    seed(['attachments']);
    const { container } = render(
      <TransactionList
        transactions={[createTransaction({ attachmentCount: 2 })]}
        onEdit={vi.fn()}
        onRefresh={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText('Grocery Store')).toBeInTheDocument();
    });
    const [row] = bodyRows(container);
    expect(row.querySelector('[data-testid="attachment-badge"]')).toBeNull();
    // The category line is otherwise as it was.
    expect(row.querySelector('.col-span-3')!.textContent).toContain('Groceries');
  });
});
