import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { render } from '@/test/render';
import { ContactLookupDialog } from './ContactLookupDialog';
import type { Payee, PayeeContactSuggestion } from '@/types/payee';

const payee = (overrides: Partial<Payee> = {}): Payee =>
  ({
    id: 'payee-1',
    userId: 'user-1',
    name: 'Hydro One',
    defaultCategoryId: null,
    defaultCategory: null,
    notes: null,
    website: null,
    address: null,
    email: null,
    phone: null,
    hasLogo: false,
    logoFetchedAt: null,
    contactLookupAt: null,
    contactLookupSource: null,
    isActive: true,
    createdAt: '2024-01-15T00:00:00.000Z',
    ...overrides,
  }) as Payee;

const candidate = (
  overrides: Partial<PayeeContactSuggestion> = {},
): PayeeContactSuggestion => ({
  label: null,
  website: null,
  address: null,
  email: null,
  phone: null,
  source: 'ai-web-search',
  confidence: 'high',
  notes: null,
  refined: [],
  ...overrides,
});

function renderDialog(
  props: Partial<Parameters<typeof ContactLookupDialog>[0]> = {},
) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(
    <ContactLookupDialog
      isOpen
      payee={payee()}
      suggestions={[candidate({ phone: '+1 416 555 0100' })]}
      saving={false}
      onCancel={onCancel}
      onConfirm={onConfirm}
      {...props}
    />,
  );
  return { onConfirm, onCancel };
}

describe('ContactLookupDialog', () => {
  it('names an empty field being filled as an add', () => {
    renderDialog();
    expect(screen.getByText('Add')).toBeInTheDocument();
    expect(screen.queryByText('Replace')).not.toBeInTheDocument();
  });

  it('names a stored value being replaced, and shows what it replaces', () => {
    renderDialog({
      payee: payee({ address: 'Toronto' }),
      suggestions: [candidate({ address: '483 Bay St\nToronto' })],
    });

    expect(screen.getByText('Replace')).toBeInTheDocument();
    // The old value is on screen beside the new one: that is what makes
    // confirming it the user's own edit rather than the lookup's write.
    expect(screen.getByText('Toronto')).toBeInTheDocument();
    expect(screen.getByText('483 Bay St Toronto', { collapseWhitespace: true })).toBeInTheDocument();
  });

  it('confirms only the rows left ticked', () => {
    const { onConfirm } = renderDialog({
      suggestions: [
        candidate({ phone: '+1 416 555 0100', email: 'hi@acme.example' }),
      ],
    });

    fireEvent.click(screen.getByLabelText(/Email/));
    fireEvent.click(screen.getByRole('button', { name: 'Save 1 change' }));

    expect(onConfirm).toHaveBeenCalledWith({ phone: '+1 416 555 0100' });
  });

  it('cannot be confirmed with everything unticked', () => {
    renderDialog();

    fireEvent.click(screen.getByLabelText(/Phone/));
    expect(screen.getByRole('button', { name: 'Save 0 changes' })).toBeDisabled();
  });

  it('draws no picker for a single candidate', () => {
    renderDialog();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
  });

  it('offers each candidate and confirms the picked one', () => {
    const { onConfirm } = renderDialog({
      suggestions: [
        candidate({ label: 'Hydro One, Toronto', phone: '+1 416 555 0100' }),
        candidate({ label: 'Hydro One, Barrie', phone: '+1 705 555 0100' }),
      ],
    });

    expect(screen.getAllByRole('radio')).toHaveLength(2);
    fireEvent.click(screen.getByLabelText(/Hydro One, Barrie/));
    fireEvent.click(screen.getByRole('button', { name: 'Save 1 change' }));

    expect(onConfirm).toHaveBeenCalledWith({ phone: '+1 705 555 0100' });
  });

  it('keeps each candidate its own ticks, so switching back does not re-tick what was turned off', () => {
    const { onConfirm } = renderDialog({
      suggestions: [
        candidate({
          label: 'Hydro One, Toronto',
          phone: '+1 416 555 0100',
          email: 'toronto@acme.example',
        }),
        candidate({ label: 'Hydro One, Barrie', phone: '+1 705 555 0100' }),
      ],
    });

    fireEvent.click(screen.getByLabelText(/Email/));
    fireEvent.click(screen.getByLabelText(/Hydro One, Barrie/));
    fireEvent.click(screen.getByLabelText(/Hydro One, Toronto/));

    fireEvent.click(screen.getByRole('button', { name: 'Save 1 change' }));
    expect(onConfirm).toHaveBeenCalledWith({ phone: '+1 416 555 0100' });
  });

  it('cancels without confirming anything', () => {
    const { onCancel, onConfirm } = renderDialog();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onCancel).toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('locks both actions while the confirmation is in flight', () => {
    renderDialog({ saving: true });

    expect(screen.getByRole('button', { name: 'Save 1 change' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  });
});
