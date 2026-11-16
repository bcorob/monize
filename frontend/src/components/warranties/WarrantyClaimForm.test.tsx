import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@/test/render';
import type { WarrantyClaim } from '@/types/warranty';
import { WarrantyClaimForm, claimStatusCloses, toClaimPayload } from './WarrantyClaimForm';

function claim(overrides: Partial<WarrantyClaim> = {}): WarrantyClaim {
  return {
    id: 'c-1',
    warrantyId: 'w-1',
    claimDate: '2026-10-05',
    status: 'resolved',
    description: 'Screen flickers',
    resolution: 'Replaced',
    resolvedOn: '2026-10-12',
    createdAt: '2026-10-05T00:00:00Z',
    updatedAt: '2026-10-12T00:00:00Z',
    ...overrides,
  };
}

async function renderForm(props: Partial<React.ComponentProps<typeof WarrantyClaimForm>> = {}) {
  const onSubmit = vi.fn().mockResolvedValue(undefined);
  const onCancel = vi.fn();
  await act(async () => {
    render(<WarrantyClaimForm today="2026-10-21" onSubmit={onSubmit} onCancel={onCancel} {...props} />);
  });
  return { onSubmit, onCancel };
}

const resolvedOnInput = () => screen.getByLabelText('Closed on') as HTMLInputElement;

describe('claimStatusCloses', () => {
  it('is true only for the statuses that may carry a closing date', () => {
    expect(claimStatusCloses('resolved')).toBe(true);
    expect(claimStatusCloses('denied')).toBe(true);
    expect(claimStatusCloses('open')).toBe(false);
    expect(claimStatusCloses('approved')).toBe(false);
  });
});

describe('toClaimPayload', () => {
  it('sends blank text as null and drops a closing date the status cannot carry', () => {
    expect(
      toClaimPayload({
        claimDate: '2026-10-05',
        status: 'open',
        description: '  ',
        resolution: '',
        resolvedOn: '2026-10-12',
      }),
    ).toEqual({ claimDate: '2026-10-05', status: 'open', description: null, resolution: null, resolvedOn: null });
  });

  it('keeps the closing date of a resolved claim', () => {
    expect(
      toClaimPayload({
        claimDate: '2026-10-05',
        status: 'denied',
        description: ' Cracked ',
        resolution: 'Out of scope',
        resolvedOn: '2026-10-12',
      }),
    ).toEqual({
      claimDate: '2026-10-05',
      status: 'denied',
      description: 'Cracked',
      resolution: 'Out of scope',
      resolvedOn: '2026-10-12',
    });
  });
});

describe('WarrantyClaimForm', () => {
  it('starts a new claim open, on the reader’s today, with the closing date off', async () => {
    const { onSubmit } = await renderForm();
    expect((screen.getByLabelText('Status') as HTMLSelectElement).value).toBe('open');
    expect(resolvedOnInput()).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Battery swells' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add claim' }));
    });
    expect(onSubmit).toHaveBeenCalledWith({
      claimDate: '2026-10-21',
      status: 'open',
      description: 'Battery swells',
      resolution: null,
      resolvedOn: null,
    });
  });

  it('offers the closing date once the claim is resolved or denied', async () => {
    await renderForm();
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'denied' } });
    expect(resolvedOnInput()).not.toBeDisabled();
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'approved' } });
    expect(resolvedOnInput()).toBeDisabled();
  });

  it('cannot set the closing date through its calendar while the claim is open', async () => {
    const { onSubmit } = await renderForm();
    // Claim date first, Closed on second.
    const [claimDatePicker, closedOnPicker] = screen.getAllByRole('button', { name: 'Open date picker' });
    expect(claimDatePicker).not.toBeDisabled();
    expect(closedOnPicker).toBeDisabled();
    // An open popover adds its month controls and day cells as buttons.
    const buttonsBefore = screen.getAllByRole('button').length;
    fireEvent.click(closedOnPicker);
    expect(screen.getAllByRole('button')).toHaveLength(buttonsBefore);
    expect(resolvedOnInput().value).toBe('');

    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'resolved' } });
    expect(screen.getAllByRole('button', { name: 'Open date picker' })[1]).not.toBeDisabled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('edits a claim with every field, so a cleared one is cleared', async () => {
    const { onSubmit } = await renderForm({ claim: claim() });
    expect(resolvedOnInput()).not.toBeDisabled();
    fireEvent.change(screen.getByLabelText('Resolution'), { target: { value: '' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    });
    expect(onSubmit).toHaveBeenCalledWith({
      claimDate: '2026-10-05',
      status: 'resolved',
      description: 'Screen flickers',
      resolution: null,
      resolvedOn: '2026-10-12',
    });
  });

  it('reopening a closed claim sends its closing date as null, which the server requires', async () => {
    const { onSubmit } = await renderForm({ claim: claim() });
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'open' } });
    expect(resolvedOnInput()).toBeDisabled();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    });
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ status: 'open', resolvedOn: null }));
  });

  it('refuses a closing date before the claim date at the field', async () => {
    const { onSubmit } = await renderForm({ claim: claim({ resolvedOn: '2026-10-01' }) });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText('A claim cannot close before it was made')).toBeInTheDocument();
  });

  it('cancels without submitting', async () => {
    const { onSubmit, onCancel } = await renderForm();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
