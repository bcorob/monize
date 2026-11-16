import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AxiosError, AxiosHeaders } from 'axios';
import { render, screen, fireEvent, act, within } from '@/test/render';
import toast from 'react-hot-toast';
import type { WarrantyImportResult, WarrantyImportRow } from '@/types/warranty';
import { WarrantyImportDialog } from './WarrantyImportDialog';

const mockImport = vi.fn();
vi.mock('@/lib/warranties', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/warranties')>()),
  warrantiesApi: { import: (...args: unknown[]) => mockImport(...args) },
}));

vi.mock('@/hooks/useDateFormat', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useDateFormat')>()),
  useDateFormat: () => ({ formatDate: (date: string) => `on ${date}` }),
}));

function row(overrides: Partial<WarrantyImportRow> = {}): WarrantyImportRow {
  return {
    line: 2,
    outcome: 'valid',
    name: 'Laptop',
    expiresOn: '2028-01-31',
    errors: [],
    warnings: [],
    warranty: { name: 'Laptop', purchaseDate: '2026-01-31', expiresOn: '2028-01-31' },
    ...overrides,
  };
}

const INVALID = row({
  line: 3,
  outcome: 'invalid',
  name: 'Phone',
  expiresOn: null,
  errors: ['Fill ExpirationDate, a WarrantyDuration column or IsLifetime'],
  warranty: null,
});

const LIFETIME = row({
  line: 4,
  name: 'Knife',
  expiresOn: null,
  warnings: ['WarrantyType "lifetime" is not manufacturer, extended, store or other; imported as other'],
  warranty: { name: 'Knife', purchaseDate: '2026-01-31', isLifetime: true, warrantyKind: 'other' },
});

function result(rows: WarrantyImportRow[], overrides: Partial<WarrantyImportResult> = {}): WarrantyImportResult {
  return { rows, created: 0, skippedColumns: [], dryRun: true, ...overrides };
}

function committed(rows: WarrantyImportRow[]): WarrantyImportResult {
  const out = rows.map((r) =>
    r.outcome === 'valid' ? { ...r, outcome: 'created' as const, warrantyId: `w-${r.line}` } : r,
  );
  return { rows: out, created: out.filter((r) => r.outcome === 'created').length, skippedColumns: [], dryRun: false };
}

const FILE = new File(['ProductName,PurchaseDate\nLaptop,2026-01-31'], 'warranties.csv', { type: 'text/csv' });

const onClose = vi.fn();
const onImported = vi.fn();

async function renderDialog() {
  await act(async () => {
    render(<WarrantyImportDialog isOpen onClose={onClose} onImported={onImported} />);
  });
}

async function choose(file: File = FILE) {
  await act(async () => {
    fireEvent.change(screen.getByLabelText('CSV file'), { target: { files: [file] } });
  });
}

function importButton() {
  return screen.getByRole('button', { name: /^Import/ });
}

async function clickImport() {
  await act(async () => {
    fireEvent.click(importButton());
  });
}

describe('WarrantyImportDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('accepts a CSV file and offers nothing to import before one is chosen', async () => {
    await renderDialog();
    expect(screen.getByRole('dialog', { name: 'Import warranties from CSV' })).toBeInTheDocument();
    expect(screen.getByLabelText('CSV file')).toHaveAttribute('accept', '.csv,text/csv');
    expect(screen.getByText('No file chosen')).toBeInTheDocument();
    expect(importButton()).toBeDisabled();
    expect(mockImport).not.toHaveBeenCalled();
  });

  it('previews a valid file and imports it, naming the count created', async () => {
    const rows = [row(), LIFETIME];
    mockImport.mockResolvedValueOnce(result(rows, { skippedColumns: ['Tags'] }));
    mockImport.mockResolvedValueOnce(committed(rows));
    await renderDialog();
    await choose();

    expect(mockImport).toHaveBeenCalledWith(FILE, { dryRun: true });
    expect(screen.getByText('warranties.csv')).toBeInTheDocument();
    expect(screen.getByText('2 of 2 rows can be imported.')).toBeInTheDocument();
    expect(screen.getByText('Columns not imported:')).toBeInTheDocument();
    expect(screen.getByText('Tags')).toBeInTheDocument();
    const table = screen.getByRole('table');
    const laptop = within(table).getByText('Laptop').closest('tr')!;
    expect(within(laptop).getByText('on 2028-01-31')).toBeInTheDocument();
    expect(within(laptop).getByText('Ready')).toBeInTheDocument();
    const knife = within(table).getByText('Knife').closest('tr')!;
    expect(within(knife).getByText('Lifetime')).toBeInTheDocument();
    expect(within(knife).getByText(/^Note: WarrantyType "lifetime"/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Skip the invalid rows and import the rest')).not.toBeInTheDocument();

    expect(importButton()).toHaveTextContent('Import 2 warranties');
    await clickImport();
    expect(mockImport).toHaveBeenLastCalledWith(FILE, { dryRun: false, skipInvalid: false });
    expect(toast.success).toHaveBeenCalledWith('2 warranties imported');
    expect(onImported).toHaveBeenCalledWith(committed(rows));
  });

  it('shows why every row of an invalid file is invalid and imports nothing', async () => {
    mockImport.mockResolvedValueOnce(result([INVALID]));
    await renderDialog();
    await choose();

    expect(screen.getByText('0 of 1 row can be imported.')).toBeInTheDocument();
    expect(screen.getByText('1 row is invalid and cannot be imported as written.')).toBeInTheDocument();
    expect(screen.getByText('Fix the file and choose it again.')).toBeInTheDocument();
    const invalid = screen.getByText('Phone').closest('tr')!;
    expect(within(invalid).getByText('Invalid')).toBeInTheDocument();
    expect(within(invalid).getByText('Not set')).toBeInTheDocument();
    expect(
      within(invalid).getByText('Error: Fill ExpirationDate, a WarrantyDuration column or IsLifetime'),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Skip the invalid rows and import the rest')).not.toBeInTheDocument();
    expect(importButton()).toBeDisabled();
  });

  it('imports a mixed file only once the invalid rows are skipped', async () => {
    const rows = [row(), INVALID];
    mockImport.mockResolvedValueOnce(result(rows));
    mockImport.mockResolvedValueOnce(committed(rows));
    await renderDialog();
    await choose();

    expect(screen.getByText('1 of 2 rows can be imported.')).toBeInTheDocument();
    expect(importButton()).toBeDisabled();
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Skip the invalid rows and import the rest'));
    });
    expect(importButton()).toHaveTextContent('Import 1 warranty');
    await clickImport();
    expect(mockImport).toHaveBeenLastCalledWith(FILE, { dryRun: false, skipInvalid: true });
    expect(toast.success).toHaveBeenCalledWith('1 warranty imported');
    expect(onImported).toHaveBeenCalledTimes(1);
  });

  it("says a refused file was refused, in the server's words", async () => {
    mockImport.mockRejectedValueOnce(
      new AxiosError('400', '400', undefined, undefined, {
        status: 400,
        statusText: 'Bad Request',
        headers: {},
        config: { headers: new AxiosHeaders() },
        data: { message: "The file's header row has no PurchaseDate column" },
      }),
    );
    await renderDialog();
    await choose();
    expect(screen.getByRole('alert')).toHaveTextContent("The file's header row has no PurchaseDate column");
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(importButton()).toBeDisabled();
  });

  it('keeps the preview and says so when the commit fails', async () => {
    mockImport.mockResolvedValueOnce(result([row()]));
    mockImport.mockRejectedValueOnce(new AxiosError('Network Error'));
    await renderDialog();
    await choose();
    await clickImport();
    expect(toast.error).toHaveBeenCalledWith('The warranties could not be imported');
    expect(onImported).not.toHaveBeenCalled();
    expect(screen.getByRole('table')).toBeInTheDocument();
  });

  it('shows the newest file when an older preview answers last', async () => {
    let answerFirst: (value: WarrantyImportResult) => void = () => {};
    mockImport.mockReturnValueOnce(new Promise((resolve) => (answerFirst = resolve)));
    mockImport.mockResolvedValueOnce(result([row({ name: 'Second' })]));
    await renderDialog();
    await choose(new File(['a'], 'first.csv'));
    expect(screen.getByText('Checking the file...')).toBeInTheDocument();
    await choose(new File(['b'], 'second.csv'));
    await act(async () => {
      answerFirst(result([row({ name: 'First' })]));
    });
    expect(screen.getByText('Second')).toBeInTheDocument();
    expect(screen.queryByText('First')).not.toBeInTheDocument();
    expect(screen.getByText('second.csv')).toBeInTheDocument();
  });

  it('cancels without importing and starts empty next time', async () => {
    mockImport.mockResolvedValueOnce(result([row()]));
    await renderDialog();
    await choose();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mockImport).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.getByText('No file chosen')).toBeInTheDocument();
  });
});
