import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within } from '@/test/render';
import { useDensityStore } from '@/store/densityStore';
import type { RowAction } from '@/components/ui/row-actions';
import { ReceiptListTable } from './ReceiptListTable';
import { makeReceipt } from './email-receipts-fixtures';

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

const linked = makeReceipt({
  id: 'r-1',
  subject: 'Order 1',
  status: 'review',
  transaction: { id: 'tx-1', date: '2026-08-30', amount: -25, currencyCode: 'USD', payeeName: 'Allegro' },
});
const view = vi.fn();
const actionsFor = (): RowAction[] => [{ key: 'view', label: 'View', icon: 'view', tone: 'view', onClick: view }];

function renderTable() {
  return render(
    <ReceiptListTable
      items={[linked]}
      isChecked={() => false}
      allSelected={false}
      someSelected={false}
      selectionDisabled={false}
      onToggle={vi.fn()}
      onToggleAll={vi.fn()}
      actionsFor={actionsFor}
    />,
  );
}

const bodyRows = (container: HTMLElement) => Array.from(container.querySelectorAll('tbody tr'));

describe('ReceiptListTable', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    useDensityStore.setState({ densities: {} });
  });
  afterEach(() => {
    window.matchMedia = originalMatchMedia;
  });

  it('offers the density toggle above the table and remembers the level for this list', () => {
    renderTable();
    fireEvent.click(screen.getByTitle('Toggle row density'));
    expect(useDensityStore.getState().densities.emailReceipts).toBe('compact');
    // Compact draws the row actions as icons.
    expect(screen.getByRole('button', { name: 'View' })).not.toHaveTextContent('View');
  });

  it('draws the table with its columns on a wide screen', () => {
    setPhoneViewport(false);
    const { container } = renderTable();
    expect(screen.getByRole('columnheader', { name: 'Date' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Transaction' })).toBeInTheDocument();
    expect(bodyRows(container)[0].querySelectorAll('td')).toHaveLength(6);
  });

  it('renders each email as one card cell on a phone at Normal density, the transaction and actions included', () => {
    setPhoneViewport(true);
    const { container } = renderTable();
    const rows = bodyRows(container);
    // The checkbox cell and the card.
    expect(rows[0].querySelectorAll('td')).toHaveLength(2);
    expect(screen.queryByRole('columnheader', { name: 'Date' })).not.toBeInTheDocument();
    const card = rows[0].querySelectorAll('td')[1] as HTMLElement;
    expect(card).toHaveTextContent('Order 1');
    expect(within(card).getByRole('link', { name: /Allegro/ })).toHaveAttribute('href', '/transactions?targetTransactionId=tx-1');
    fireEvent.click(within(card).getByRole('button', { name: 'View' }));
    expect(view).toHaveBeenCalledTimes(1);
  });

  it('keeps the table on a phone at Compact density', () => {
    setPhoneViewport(true);
    useDensityStore.setState({ densities: { emailReceipts: 'compact' } });
    const { container } = renderTable();
    expect(bodyRows(container)[0].querySelectorAll('td')).toHaveLength(6);
  });
});
