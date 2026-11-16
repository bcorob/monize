import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within, cleanup, act } from '@/test/render';
import { useDensityStore } from '@/store/densityStore';
import type { Warranty } from '@/types/warranty';
import { WarrantyList, type WarrantyListProps } from './WarrantyList';

let mockIsMobile = false;
vi.mock('@/hooks/useIsMobile', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useIsMobile')>()),
  useIsMobile: () => mockIsMobile,
}));

vi.mock('@/hooks/useDateFormat', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useDateFormat')>()),
  useDateFormat: () => ({ formatDate: (date: string) => `on ${date}` }),
}));

function warranty(overrides: Partial<Warranty> = {}): Warranty {
  return {
    id: 'w-1',
    name: 'Laptop',
    vendorName: 'Best Buy',
    payeeId: null,
    payee: null,
    modelNumber: null,
    serialNumbers: [],
    warrantyKind: 'manufacturer',
    purchaseDate: '2026-10-01',
    expiresOn: '2028-10-01',
    isLifetime: false,
    purchasePrice: 1299.99,
    currencyCode: 'CAD',
    productUrl: null,
    notes: null,
    today: '2026-10-21',
    status: 'active',
    daysLeft: 711,
    documentCount: 2,
    openClaimCount: 0,
    linkedTransactionHidden: false,
    linkedTransaction: null,
    archivedAt: null,
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
    ...overrides,
  };
}

function renderList(props: Partial<WarrantyListProps> = {}) {
  const handlers = {
    onSort: vi.fn(),
    onOpen: vi.fn(),
    onEdit: vi.fn(),
    onArchive: vi.fn(),
    onUnarchive: vi.fn(),
    onDelete: vi.fn(),
  };
  const utils = render(
    <WarrantyList
      warranties={[warranty()]}
      sort="expiresOn"
      sortDir="asc"
      empty={{ title: 'Nothing here', description: 'Add one' }}
      {...handlers}
      {...props}
    />,
  );
  return { ...utils, ...handlers, ...props };
}

describe('WarrantyList', () => {
  beforeEach(() => {
    mockIsMobile = false;
    useDensityStore.setState({ densities: {} });
  });

  afterEach(() => {
    cleanup();
    useDensityStore.setState({ densities: {} });
  });

  it('draws a row from the server view', () => {
    renderList();
    const row = screen.getByText('Laptop').closest('tr')!;
    expect(within(row).getByText('Best Buy')).toBeInTheDocument();
    expect(within(row).getByText('Active')).toBeInTheDocument();
    expect(within(row).getByText('1 year, 346 days left')).toBeInTheDocument();
    expect(within(row).getByText('on 2028-10-01')).toBeInTheDocument();
    expect(within(row).getByText('on 2026-10-01')).toBeInTheDocument();
    // Not the reader's currency, so the code says whose dollars these are.
    expect(within(row).getByText('$1,299.99 CAD')).toBeInTheDocument();
    expect(within(row).getByText('2')).toBeInTheDocument();
    expect(within(row).getByText('0')).toBeInTheDocument();
  });

  describe("the vendor's logo", () => {
    const PAYEE = { id: 'p-1', name: 'Best Buy', hasLogo: true };

    it("draws the payee's cached logo before the vendor, from the view alone", () => {
      renderList({ warranties: [warranty({ payeeId: 'p-1', payee: PAYEE })] });
      const vendor = within(screen.getByText('Laptop').closest('tr')!).getByText('Best Buy');
      const logo = vendor.parentElement!.querySelector('img');
      expect(logo).toHaveAttribute('src', '/api/v1/payees/p-1/logo');
      expect(logo).toHaveStyle({ width: '20px', height: '20px' });
      expect(vendor.parentElement!.firstElementChild).toBe(logo);
    });

    it("draws the vendor's initial for a payee without a logo and for a typed vendor", () => {
      renderList({
        warranties: [
          warranty({ payeeId: 'p-1', payee: { ...PAYEE, hasLogo: false } }),
          warranty({ id: 'w-2', name: 'Fridge', vendorName: 'Corner shop' }),
        ],
      });
      expect(screen.queryByRole('img')).not.toBeInTheDocument();
      const payeeLine = within(screen.getByText('Laptop').closest('tr')!).getByText('Best Buy').parentElement!;
      expect(payeeLine).toHaveTextContent('BBest Buy');
      const typedLine = within(screen.getByText('Fridge').closest('tr')!).getByText('Corner shop').parentElement!;
      expect(typedLine).toHaveTextContent('CCorner shop');
    });

    it('draws no logo when there is no vendor', () => {
      renderList({ warranties: [warranty({ vendorName: null })] });
      const cell = screen.getByText('Laptop').parentElement!;
      expect(cell.children).toHaveLength(1);
    });

    it('draws the logo on the phone card too', () => {
      mockIsMobile = true;
      renderList({ warranties: [warranty({ payeeId: 'p-1', payee: PAYEE })] });
      const vendor = within(screen.getByText('Laptop').closest('tr')!).getByText('Best Buy');
      expect(vendor.parentElement!.querySelector('img')).toHaveAttribute('src', '/api/v1/payees/p-1/logo');
    });
  });

  it('says Lifetime where a lifetime warranty has no end date', () => {
    renderList({
      warranties: [warranty({ isLifetime: true, expiresOn: null, status: 'lifetime', daysLeft: null })],
    });
    const row = screen.getAllByText('Lifetime')[0].closest('tr')!;
    // The pill and the Expires cell both say it; no days-left line.
    expect(within(row).getAllByText('Lifetime')).toHaveLength(2);
    expect(within(row).queryByText(/days left/)).not.toBeInTheDocument();
  });

  it('shows no price as None, never a zero', () => {
    renderList({ warranties: [warranty({ purchasePrice: null, currencyCode: null })] });
    expect(screen.getByText('None')).toBeInTheDocument();
    expect(screen.queryByText(/\$0\.00/)).not.toBeInTheDocument();
  });

  it('draws the empty state the page chose', () => {
    renderList({ warranties: [] });
    expect(screen.getByText('Nothing here')).toBeInTheDocument();
    expect(screen.getByText('Add one')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('keeps the toolbar buttons on an empty page', () => {
    renderList({ warranties: [], toolbarActions: <button type="button">Add warranty</button> });
    expect(screen.getByRole('button', { name: 'Add warranty' })).toBeInTheDocument();
  });

  it('asks the server for a sort field from the header', () => {
    const { onSort } = renderList();
    fireEvent.click(screen.getByRole('columnheader', { name: /Name/ }));
    expect(onSort).toHaveBeenCalledWith('name');
    fireEvent.click(screen.getByRole('columnheader', { name: /Purchased/ }));
    expect(onSort).toHaveBeenCalledWith('purchaseDate');
  });

  it('marks the active sort column with the direction the server sorts it in', () => {
    renderList({ sort: 'purchaseDate', sortDir: 'desc' });
    expect(screen.getByRole('columnheader', { name: /Purchased/ })).toHaveAttribute('aria-sort', 'descending');
    expect(screen.getByRole('columnheader', { name: /Expires/ })).toHaveAttribute('aria-sort', 'none');
  });

  it('opens the warranty on a row click and from the keyboard, and leaves Edit to its action', () => {
    const { onOpen, onEdit } = renderList();
    const row = screen.getByText('Laptop').closest('tr')!;
    fireEvent.click(row);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 'w-1' }));
    fireEvent.keyDown(row, { key: 'Enter' });
    expect(onOpen).toHaveBeenCalledTimes(2);
    expect(onEdit).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({ id: 'w-1' }));
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it('offers Archive on a current warranty and Unarchive on an archived one', () => {
    const { onArchive, onUnarchive, rerender } = renderList();
    expect(screen.queryByRole('button', { name: 'Unarchive' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    expect(onArchive).toHaveBeenCalledWith(expect.objectContaining({ id: 'w-1' }));

    rerender(
      <WarrantyList
        warranties={[warranty({ archivedAt: '2026-10-20T00:00:00Z' })]}
        sort="expiresOn"
        sortDir="asc"
        empty={{ title: 'Nothing here' }}
        onSort={vi.fn()}
        onOpen={vi.fn()}
        onEdit={vi.fn()}
        onArchive={onArchive}
        onUnarchive={onUnarchive}
        onDelete={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Archive' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Unarchive' }));
    expect(onUnarchive).toHaveBeenCalledWith(expect.objectContaining({ id: 'w-1' }));
  });

  it('asks the page to delete, without opening the row', () => {
    const { onDelete, onOpen } = renderList();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onDelete).toHaveBeenCalledWith(expect.objectContaining({ id: 'w-1' }));
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('offers the same actions from the long-press sheet', () => {
    const { onDelete } = renderList();
    const row = screen.getByText('Laptop').closest('tr')!;
    fireEvent.contextMenu(row);
    const sheet = screen.getByRole('dialog');
    expect(within(sheet).getByRole('button', { name: /Archive/ })).toBeInTheDocument();
    fireEvent.click(within(sheet).getByRole('button', { name: /Delete/ }));
    expect(onDelete).toHaveBeenCalled();
  });

  it('draws read-only rows with no actions column and no long-press sheet', () => {
    const { onOpen } = renderList({ readOnly: true });
    expect(screen.queryByText('Actions')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Delete/ })).not.toBeInTheDocument();
    const row = screen.getByText('Laptop').closest('tr')!;
    fireEvent.click(row);
    expect(onOpen).toHaveBeenCalled();
    fireEvent.contextMenu(row);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('keeps stale rows on screen but makes nothing on them act', () => {
    const { onOpen, onDelete, container } = renderList({ stale: true });
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    fireEvent.click(screen.getByText('Laptop').closest('tr')!);
    expect(onOpen).not.toHaveBeenCalled();
    const del = screen.getByRole('button', { name: 'Delete' });
    expect(del).toBeDisabled();
    fireEvent.click(del);
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('wraps each warranty into a captioned card on a phone at Normal density', () => {
    mockIsMobile = true;
    const { onSort } = renderList();
    const row = screen.getByText('Laptop').closest('tr')!;
    expect(within(row).getByText('Expires')).toBeInTheDocument();
    expect(within(row).getByText('Purchased')).toBeInTheDocument();
    expect(within(row).getByText('Open claims')).toBeInTheDocument();
    expect(within(row).getByText('1 year, 346 days left')).toBeInTheDocument();
    // The header becomes the sort chips, covering every sort field.
    const chips = screen.getAllByRole('button', { pressed: false });
    expect(chips.map((c) => c.textContent)).toEqual(expect.arrayContaining([expect.stringContaining('Name')]));
    fireEvent.click(screen.getByRole('button', { name: /Purchased/ }));
    expect(onSort).toHaveBeenCalledWith('purchaseDate');
    expect(screen.getByRole('button', { name: /Expires/, pressed: true })).toBeInTheDocument();
  });

  it('keeps the table on a phone at Compact density', async () => {
    mockIsMobile = true;
    useDensityStore.setState({ densities: { warranties: 'compact' } });
    renderList();
    expect(screen.getByRole('columnheader', { name: /Name/ })).toBeInTheDocument();
    await act(async () => {});
  });
});
