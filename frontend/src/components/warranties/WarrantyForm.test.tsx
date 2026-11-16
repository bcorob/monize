import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@/test/render';
import toast from 'react-hot-toast';
import type { Warranty } from '@/types/warranty';
import { WarrantyForm, toWarrantyPayload, type WarrantyFormData } from './WarrantyForm';

const mockGetPayees = vi.fn();
vi.mock('@/lib/payees', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/payees')>()),
  payeesApi: { getAll: (...args: unknown[]) => mockGetPayees(...args) },
}));

const mockUpload = vi.fn();
vi.mock('@/lib/attachments', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/attachments')>();
  return {
    ...actual,
    attachmentsApi: { ...actual.attachmentsApi, upload: (...args: unknown[]) => mockUpload(...args) },
  };
});

vi.mock('@/hooks/useDateFormat', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useDateFormat')>()),
  useDateFormat: () => ({
    formatDate: (date: string) => date,
    dateFormat: 'browser',
    datePattern: 'MM/DD/YYYY',
  }),
}));

const warranty: Warranty = {
  id: 'w-1',
  name: 'Fridge',
  vendorName: 'Home Depot',
  payeeId: null,
  payee: null,
  modelNumber: 'RF-200',
  serialNumbers: ['SN1'],
  warrantyKind: 'extended',
  purchaseDate: '2025-05-01',
  expiresOn: null,
  isLifetime: true,
  purchasePrice: 999,
  currencyCode: 'USD',
  productUrl: 'https://example.com/fridge',
  notes: 'Kitchen',
  today: '2026-10-21',
  status: 'lifetime',
  daysLeft: null,
  documentCount: 0,
  openClaimCount: 0,
  linkedTransactionHidden: false,
  linkedTransaction: null,
  archivedAt: null,
  createdAt: '2025-05-01T00:00:00Z',
  updatedAt: '2025-05-01T00:00:00Z',
};

async function renderForm(props: Partial<Parameters<typeof WarrantyForm>[0]> = {}) {
  const onSubmit = vi.fn().mockResolvedValue({ ...warranty, id: 'w-new' });
  const onSuccess = vi.fn();
  const onCancel = vi.fn();
  const onDirtyChange = vi.fn();
  await act(async () => {
    render(
      <WarrantyForm
        onSubmit={onSubmit}
        onSuccess={onSuccess}
        onCancel={onCancel}
        onDirtyChange={onDirtyChange}
        {...props}
      />,
    );
  });
  return { onSubmit, onSuccess, onCancel, onDirtyChange };
}

/** Stage a document the way a reader does: through the Add attachment picker. */
async function stageDocument(name: string): Promise<File> {
  const file = new File(['%PDF'], name, { type: 'application/pdf' });
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Add attachment'), { target: { files: [file] } });
  });
  return file;
}

async function submit(label = 'Add warranty') {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: label }));
  });
}

/** Type a date the way a reader does: the text, then leaving the field. */
async function typeDate(label: string, text: string) {
  const input = screen.getByLabelText(label);
  await act(async () => {
    fireEvent.change(input, { target: { value: text } });
    fireEvent.blur(input);
  });
}

const PREFILL = {
  name: 'Laptop',
  vendorName: 'Best Buy',
  payeeId: 'p-1',
  transactionId: 'tx-1',
  purchaseDate: '2026-10-01',
  purchasePrice: 1299.99,
  currencyCode: 'CAD',
};

describe('WarrantyForm', () => {
  beforeEach(() => {
    mockGetPayees.mockReset();
    mockGetPayees.mockResolvedValue([{ id: 'p-1', name: 'Best Buy' }, { id: 'p-2', name: 'Costco' }]);
    mockUpload.mockReset();
    mockUpload.mockResolvedValue({ id: 'a-1' });
  });

  it('refuses a warranty with no name and no purchase date', async () => {
    const { onSubmit } = await renderForm();
    await submit();
    expect(await screen.findByText('Enter a name')).toBeInTheDocument();
    expect(screen.getByText('Enter the purchase date')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('works out the end date from the duration and submits the date, never the term', async () => {
    const { onSubmit } = await renderForm({ prefill: PREFILL });
    // A new warranty starts on the duration helper at one year.
    expect(screen.getByRole('button', { name: 'After a duration', pressed: true })).toBeInTheDocument();
    expect(screen.getByText('Expires on 2027-10-01')).toBeInTheDocument();
    await submit();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    const payload = onSubmit.mock.calls[0][0];
    expect(payload).toMatchObject({
      name: 'Laptop',
      vendorName: 'Best Buy',
      payeeId: 'p-1',
      transactionId: 'tx-1',
      purchaseDate: '2026-10-01',
      expiresOn: '2027-10-01',
      purchasePrice: 1299.99,
      currencyCode: 'CAD',
      warrantyKind: 'manufacturer',
      serialNumbers: [],
    });
    expect(payload).not.toHaveProperty('term');
    expect(payload).not.toHaveProperty('isLifetime');
  });

  it('clamps a month-based duration to the month end', async () => {
    const { onSubmit } = await renderForm({ prefill: { ...PREFILL, purchaseDate: '2026-01-31' } });
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Years'), { target: { value: '' } });
      fireEvent.change(screen.getByLabelText('Months'), { target: { value: '18' } });
    });
    expect(screen.getByText('Expires on 2027-07-31')).toBeInTheDocument();
    await submit();
    expect(onSubmit.mock.calls[0][0].expiresOn).toBe('2027-07-31');
  });

  it('refuses a duration of zero', async () => {
    const { onSubmit } = await renderForm({ prefill: PREFILL });
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Years'), { target: { value: '0' } });
    });
    await submit();
    expect(await screen.findByText('Enter a duration longer than zero')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('sends lifetime alone, with no date', async () => {
    const { onSubmit } = await renderForm({ prefill: PREFILL });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Never' }));
    });
    expect(screen.getByText('A lifetime warranty has no end date and no reminder')).toBeInTheDocument();
    await submit();
    const payload = onSubmit.mock.calls[0][0];
    expect(payload.isLifetime).toBe(true);
    expect(payload).not.toHaveProperty('expiresOn');
  });

  it('carries the duration answer into the date field and refuses an end before the purchase', async () => {
    const { onSubmit } = await renderForm({ prefill: PREFILL });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'On a date' }));
    });
    expect(screen.getByLabelText('Expires on')).toHaveValue('10/01/2027');
    await typeDate('Expires on', '09/30/2026');
    await submit();
    expect(await screen.findByText('The warranty cannot end before the purchase date')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();

    await typeDate('Expires on', '12/31/2028');
    await submit();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][0].expiresOn).toBe('2028-12-31');
  });

  it('asks for an end date when the date mode has none', async () => {
    const { onSubmit } = await renderForm({ prefill: { ...PREFILL, purchaseDate: undefined } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'On a date' }));
    });
    await typeDate('Purchase date', '10/01/2026');
    await submit();
    expect(await screen.findByText('Enter the date the warranty ends')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('sends no price and no currency when the price is blank', async () => {
    const { onSubmit } = await renderForm({ prefill: { ...PREFILL, purchasePrice: undefined } });
    await submit();
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ purchasePrice: null, currencyCode: null });
  });

  it('edits a list of serial numbers, capped at ten', async () => {
    const { onSubmit } = await renderForm({ prefill: PREFILL });
    const add = screen.getByRole('button', { name: 'Add serial number' });
    await act(async () => {
      fireEvent.click(add);
      fireEvent.click(add);
    });
    fireEvent.change(screen.getByLabelText('Serial number 1'), { target: { value: 'AAA' } });
    fireEvent.change(screen.getByLabelText('Serial number 2'), { target: { value: 'BBB' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Remove serial number 1' }));
    });
    await submit();
    expect(onSubmit.mock.calls[0][0].serialNumbers).toEqual(['BBB']);

    await act(async () => {
      for (let i = 0; i < 9; i++) fireEvent.click(add);
    });
    expect(screen.getAllByLabelText(/^Serial number \d+$/)).toHaveLength(10);
    expect(add).toBeDisabled();
  });

  it('refuses a serial number over 100 characters', async () => {
    const { onSubmit } = await renderForm({ prefill: PREFILL });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add serial number' }));
    });
    // The input caps typing at 100; a pasted value set programmatically is
    // still checked by the schema.
    fireEvent.change(screen.getByLabelText('Serial number 1'), { target: { value: 'x'.repeat(101) } });
    await submit();
    expect(await screen.findByText('Use 100 characters or fewer for each serial number')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('accepts only an http or https product page', async () => {
    const { onSubmit } = await renderForm({ prefill: PREFILL });
    fireEvent.change(screen.getByLabelText('Product page'), { target: { value: 'ftp://example.com' } });
    await submit();
    expect(await screen.findByText('Enter a web address starting with http:// or https://')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('sets the vendor and its payee from the picker, and a typed vendor clears the payee', async () => {
    const { onSubmit } = await renderForm({ prefill: { ...PREFILL, vendorName: undefined, payeeId: undefined } });
    // The shared Combobox does not associate its label with its input.
    const vendor = screen.getByPlaceholderText('Select or type a vendor');
    await act(async () => {
      fireEvent.focus(vendor);
      fireEvent.change(vendor, { target: { value: 'Cost' } });
    });
    await act(async () => {
      fireEvent.click(await screen.findByText('Costco'));
    });
    await submit();
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ vendorName: 'Costco', payeeId: 'p-2' });
  });

  it('opens an existing lifetime warranty on Never and keeps its fields', async () => {
    const { onSubmit } = await renderForm({ warranty });
    expect(screen.getByRole('button', { name: 'Never', pressed: true })).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveValue('Fridge');
    expect(screen.getByLabelText('Serial number 1')).toHaveValue('SN1');
    await submit('Save changes');
    const payload = onSubmit.mock.calls[0][0];
    expect(payload).toMatchObject({
      name: 'Fridge',
      vendorName: 'Home Depot',
      payeeId: null,
      modelNumber: 'RF-200',
      serialNumbers: ['SN1'],
      warrantyKind: 'extended',
      isLifetime: true,
      purchasePrice: 999,
      currencyCode: 'USD',
      productUrl: 'https://example.com/fridge',
      notes: 'Kitchen',
    });
    // An edit never re-links the purchase.
    expect(payload).not.toHaveProperty('transactionId');
  });

  it('still offers a typed vendor when the payee list fails to load', async () => {
    mockGetPayees.mockRejectedValue(new Error('500'));
    const { onSubmit } = await renderForm({ prefill: { ...PREFILL, vendorName: undefined, payeeId: undefined } });
    // The shared Combobox does not associate its label with its input.
    const vendor = screen.getByPlaceholderText('Select or type a vendor');
    await act(async () => {
      // Typing without the focus that opens the list (the shared Combobox
      // ignores input for 100ms after opening).
      fireEvent.change(vendor, { target: { value: 'Corner shop' } });
      fireEvent.keyDown(vendor, { key: 'Tab' });
    });
    await submit();
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ vendorName: 'Corner shop', payeeId: null });
  });

  it('uploads a staged document to the new warranty once it has been created', async () => {
    const { onSubmit, onSuccess, onDirtyChange } = await renderForm({ prefill: PREFILL });
    expect(screen.getByText('Documents')).toBeInTheDocument();
    const file = await stageDocument('receipt.pdf');
    expect(screen.getByText('receipt.pdf')).toBeInTheDocument();
    // A staged document is an unsaved change the close guard must ask about.
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);

    await submit();
    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
    expect(mockUpload).toHaveBeenCalledTimes(1);
    expect(mockUpload).toHaveBeenCalledWith({ warrantyId: 'w-new' }, file, undefined);
    // Saved first, then uploaded, then handed back to the host.
    expect(onSubmit.mock.invocationCallOrder[0]).toBeLessThan(mockUpload.mock.invocationCallOrder[0]);
    expect(mockUpload.mock.invocationCallOrder[0]).toBeLessThan(onSuccess.mock.invocationCallOrder[0]);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('keeps the new warranty and names the document when its upload fails', async () => {
    mockUpload.mockRejectedValueOnce(new Error('503')).mockResolvedValueOnce({ id: 'a-2' });
    const { onSuccess } = await renderForm({ prefill: PREFILL });
    await stageDocument('receipt.pdf');
    await stageDocument('manual.pdf');

    await submit();
    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
    // Both were tried: one failure does not stop the rest.
    expect(mockUpload).toHaveBeenCalledTimes(2);
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledWith(
      "Warranty added, but this document could not be uploaded: receipt.pdf. Add it from the warranty's Documents section.",
    );
  });

  it('uploads nothing and calls no success when the save itself fails', async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error('400'));
    // Submitted through the ref the modal's Save uses, whose promise carries
    // the host's rejection where the test can hold it.
    const submitRef: { current: (() => void) | null } = { current: null };
    const { onSuccess } = await renderForm({ prefill: PREFILL, onSubmit, submitRef });
    await stageDocument('receipt.pdf');
    await act(async () => {
      await (submitRef.current as unknown as () => Promise<void>)().catch(() => undefined);
    });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(mockUpload).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('offers no staged documents when editing: they live on the detail page', async () => {
    const { onSuccess } = await renderForm({ warranty });
    expect(screen.queryByText('Documents')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Add attachment')).not.toBeInTheDocument();
    await submit('Save changes');
    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it('calls onCancel', async () => {
    const { onCancel } = await renderForm();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalled();
  });
});

describe('toWarrantyPayload', () => {
  const base: WarrantyFormData = {
    name: '  Laptop  ',
    vendorName: '  ',
    payeeId: '',
    modelNumber: '',
    serialNumbers: [{ value: ' A ' }, { value: '' }],
    warrantyKind: 'store',
    purchaseDate: '2026-10-01',
    expiryMode: 'duration',
    expiresOn: '',
    termYears: 2,
    termMonths: undefined,
    termDays: undefined,
    purchasePrice: undefined,
    currencyCode: 'USD',
    productUrl: ' ',
    notes: '',
  };

  it('turns blanks into nulls and trims text', () => {
    expect(toWarrantyPayload(base)).toEqual({
      name: 'Laptop',
      vendorName: null,
      payeeId: null,
      modelNumber: null,
      serialNumbers: ['A'],
      warrantyKind: 'store',
      purchaseDate: '2026-10-01',
      expiresOn: '2028-10-01',
      purchasePrice: null,
      currencyCode: null,
      productUrl: null,
      notes: null,
    });
  });

  it('sends exactly one expiry source', () => {
    expect(toWarrantyPayload({ ...base, expiryMode: 'date', expiresOn: '2027-01-01' })).toMatchObject({
      expiresOn: '2027-01-01',
    });
    const lifetime = toWarrantyPayload({ ...base, expiryMode: 'lifetime' });
    expect(lifetime.isLifetime).toBe(true);
    expect(lifetime).not.toHaveProperty('expiresOn');
  });

  it('includes a transaction link only when one is given', () => {
    expect(toWarrantyPayload(base, 'tx-1').transactionId).toBe('tx-1');
    expect(toWarrantyPayload(base)).not.toHaveProperty('transactionId');
  });
});
