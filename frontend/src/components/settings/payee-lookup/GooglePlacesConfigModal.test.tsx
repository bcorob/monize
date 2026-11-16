import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { render } from '@/test/render';
import { GooglePlacesConfigModal } from './GooglePlacesConfigModal';
import type { PayeeLookupSettings } from '@/types/payee-lookup';

const settings = (over: Partial<PayeeLookupSettings> = {}): PayeeLookupSettings => ({
  mode: 'user',
  configured: false,
  enabled: true,
  aiEnabled: true,
  capEnabled: true,
  monthlyCap: 1000,
  apiKeyMasked: null,
  apiKeyReadable: true,
  usedThisMonth: 0,
  preferredSource: 'google-places',
  aiProviderConfigId: null,
  encryptionAvailable: true,
  ...over,
});

function renderModal(over: Partial<PayeeLookupSettings> = {}) {
  const onSave = vi.fn().mockResolvedValue(undefined);
  const onTest = vi.fn().mockResolvedValue({ available: true });
  const onClose = vi.fn();
  render(
    <GooglePlacesConfigModal
      isOpen
      settings={settings(over)}
      onClose={onClose}
      onSave={onSave}
      onTest={onTest}
    />,
  );
  return { onSave, onTest, onClose };
}

const keyField = () => screen.getByLabelText('API key');
const submit = async () => {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  });
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GooglePlacesConfigModal', () => {
  it('never renders the stored key, only a mask as the placeholder', async () => {
    renderModal({ configured: true, apiKeyMasked: '****' });

    expect(keyField()).toHaveValue('');
    expect(keyField()).toHaveAttribute('placeholder', '****');
  });

  it('declares the key field as not this site\'s credential', async () => {
    // A password manager filling the account password here would be saved as
    // the Google key.
    renderModal();

    expect(keyField()).toHaveAttribute('type', 'password');
    expect(keyField()).toHaveAttribute('autocomplete', 'off');
  });

  it('omits the key entirely when the field was left alone', async () => {
    // Sending "" would clear a key the user cannot see to retype.
    const { onSave } = renderModal({ configured: true, apiKeyMasked: '****' });

    await submit();

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][0]).not.toHaveProperty('apiKey');
  });

  it('sends a typed key with the cap', async () => {
    const { onSave } = renderModal();

    await act(async () => {
      fireEvent.change(keyField(), { target: { value: 'AIza-secret' } });
    });
    await submit();

    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith({
        apiKey: 'AIza-secret',
        capEnabled: true,
        monthlyCap: 1000,
      }),
    );
  });

  it('hides the cap field when the limit is switched off', async () => {
    renderModal();

    expect(screen.getByLabelText('Requests per month')).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(
        screen.getByRole('switch', { name: 'Limit requests each month' }),
      );
    });

    expect(
      screen.queryByLabelText('Requests per month'),
    ).not.toBeInTheDocument();
  });

  it('tests the typed key rather than the stored one', async () => {
    const { onTest } = renderModal({ configured: true, apiKeyMasked: '****' });

    await act(async () => {
      fireEvent.change(keyField(), { target: { value: 'draft-key' } });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Test' }));
    });

    await waitFor(() => expect(onTest).toHaveBeenCalledWith('draft-key'));
    expect(await screen.findByText('Google accepted the key.')).toBeInTheDocument();
  });

  it('tests the stored key when nothing was typed', async () => {
    const { onTest } = renderModal({ configured: true, apiKeyMasked: '****' });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Test' }));
    });

    await waitFor(() => expect(onTest).toHaveBeenCalledWith(undefined));
  });

  it("shows Google's own refusal, which is the point of a test button", async () => {
    const onSave = vi.fn();
    const onTest = vi.fn().mockResolvedValue({
      available: false,
      error: 'Google Places returned HTTP 403: API key not valid',
    });
    render(
      <GooglePlacesConfigModal
        isOpen
        settings={settings()}
        onClose={vi.fn()}
        onSave={onSave}
        onTest={onTest}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Test' }));
    });

    expect(await screen.findByText(/API key not valid/)).toBeInTheDocument();
  });

  it('refuses a cap outside the accepted range instead of saving it', async () => {
    const { onSave } = renderModal();

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Requests per month'), {
        target: { value: '0' },
      });
    });
    await submit();

    await waitFor(() =>
      expect(screen.getByText(/Enter a number between/)).toBeInTheDocument(),
    );
    expect(onSave).not.toHaveBeenCalled();
  });
});
