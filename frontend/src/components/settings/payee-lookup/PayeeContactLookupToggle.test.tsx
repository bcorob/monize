import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@/test/render';
import { PayeeContactLookupToggle } from './PayeeContactLookupToggle';

vi.mock('@/lib/user-settings', () => ({
  userSettingsApi: {
    updatePreferences: vi.fn(),
  },
}));

const updatePreferencesStore = vi.fn();
let mockPreferences: { payeeContactLookupEnabled: boolean } | null;

vi.mock('@/store/preferencesStore', () => ({
  usePreferencesStore: vi.fn(),
}));

vi.mock('@/lib/errors', () => ({
  getErrorMessage: vi.fn((_error: unknown, fallback: string) => fallback),
}));

import { userSettingsApi } from '@/lib/user-settings';
import { usePreferencesStore } from '@/store/preferencesStore';
import toast from 'react-hot-toast';

beforeEach(() => {
  vi.clearAllMocks();
  mockPreferences = { payeeContactLookupEnabled: false };
  (usePreferencesStore as unknown as Mock).mockImplementation((selector: any) =>
    selector({
      preferences: mockPreferences,
      updatePreferences: updatePreferencesStore,
    }),
  );
});

describe('PayeeContactLookupToggle', () => {
  it('is shown off and disabled when no source can answer', () => {
    // Deliberately NOT hidden. The sources are configured immediately above
    // this switch, so vanishing on the last one being switched off reads as a
    // bug; an inert switch shows exactly what an automatic lookup would now do.
    render(<PayeeContactLookupToggle lookupAvailable={false} />);

    const toggle = screen.getByRole('switch');
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(toggle).toBeDisabled();
    expect(screen.getByText(/Switch on a source above/)).toBeInTheDocument();
  });

  it('shows off even when the stored preference is on, without rewriting it', () => {
    // The preference survives: switching a source back on must restore the
    // setting the user chose, not silently leave it off.
    mockPreferences = { payeeContactLookupEnabled: true };
    render(<PayeeContactLookupToggle lookupAvailable={false} />);

    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
    expect(userSettingsApi.updatePreferences).not.toHaveBeenCalled();
  });

  it('names no repair while it does not know whether a source can answer', () => {
    // Three states hide behind one false: still asking, could not ask, and
    // asked and nothing can answer. Only the last has earned the copy that
    // tells the reader to switch a source on -- and the first happens on every
    // load of this screen, under a Google Places row that is fully configured.
    mockPreferences = { payeeContactLookupEnabled: true };
    render(<PayeeContactLookupToggle />);

    const toggle = screen.getByRole('switch');
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(toggle).toBeEnabled();
    expect(screen.queryByText(/Switch on a source above/)).toBeNull();
  });

  it('renders the heading and an off switch by default', () => {
    render(<PayeeContactLookupToggle lookupAvailable />);
    expect(screen.getByText('Automatic payee contact lookup')).toBeInTheDocument();
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
  });

  it('names the details it looks up and what is sent', () => {
    render(<PayeeContactLookupToggle lookupAvailable />);
    // A switch whose subtitle does not say what it fetches, or what it sends,
    // is asking for consent to something unnamed. It deliberately no longer
    // names the AI provider: Google Places answers the same lookup, and copy
    // naming one source would be wrong for whichever is actually configured.
    const subtitle = screen.getByText(/Automatically look up a new payee/);
    expect(subtitle).toHaveTextContent(
      /website, address, email and phone number/,
    );
    // A switch that ships the payee's stored notes to a third-party model has
    // to say so: this is the only surface where the user consents, and the
    // lookup sends more than the name (buildLookupContext on the server).
    expect(subtitle).toHaveTextContent(/is sent/);
    expect(subtitle).toHaveTextContent(/notes/);
  });

  it('enables the lookup optimistically and shows the success toast', async () => {
    (userSettingsApi.updatePreferences as Mock).mockResolvedValue({
      payeeContactLookupEnabled: true,
    });

    render(<PayeeContactLookupToggle lookupAvailable />);
    fireEvent.click(screen.getByRole('switch'));

    expect(updatePreferencesStore).toHaveBeenCalledWith({ payeeContactLookupEnabled: true });
    await waitFor(() => {
      expect(userSettingsApi.updatePreferences).toHaveBeenCalledWith({
        payeeContactLookupEnabled: true,
      });
      expect(toast.success).toHaveBeenCalledWith('Automatic payee contact lookup enabled');
    });
  });

  it('reverts the optimistic change and shows an error when the save fails', async () => {
    (userSettingsApi.updatePreferences as Mock).mockRejectedValue(new Error('nope'));

    render(<PayeeContactLookupToggle lookupAvailable />);
    fireEvent.click(screen.getByRole('switch'));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        'Could not update the payee contact lookup setting',
      );
    });
    expect(updatePreferencesStore).toHaveBeenLastCalledWith({
      payeeContactLookupEnabled: false,
    });
  });

  it('renders on and disables the switch when asked', () => {
    mockPreferences = { payeeContactLookupEnabled: true };
    render(<PayeeContactLookupToggle lookupAvailable disabled />);
    const toggle = screen.getByRole('switch');
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(toggle).toBeDisabled();
  });
});
