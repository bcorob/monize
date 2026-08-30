import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@/test/render';
import { ProviderList } from './ProviderList';
import type { AiProviderConfig } from '@/types/ai';

const mockDeleteConfig = vi.fn();
const mockUpdateConfig = vi.fn();
const mockCreateConfig = vi.fn();
const mockTestConnection = vi.fn();

vi.mock('@/lib/ai', () => ({
  aiApi: {
    deleteConfig: (...args: unknown[]) => mockDeleteConfig(...args),
    updateConfig: (...args: unknown[]) => mockUpdateConfig(...args),
    createConfig: (...args: unknown[]) => mockCreateConfig(...args),
    testConnection: (...args: unknown[]) => mockTestConnection(...args),
  },
}));

const mockToastSuccess = vi.fn();
const mockToastError = vi.fn();

vi.mock('react-hot-toast', () => ({
  __esModule: true,
  default: {
    success: (...args: unknown[]) => mockToastSuccess(...args),
    error: (...args: unknown[]) => mockToastError(...args),
  },
  toast: {
    success: (...args: unknown[]) => mockToastSuccess(...args),
    error: (...args: unknown[]) => mockToastError(...args),
  },
}));

vi.mock('@/lib/errors', () => ({
  getErrorMessage: (_e: unknown, fallback: string) => fallback,
}));

vi.mock('@/components/ui/Modal', () => ({
  Modal: ({ children, isOpen }: any) => isOpen ? <div data-testid="modal">{children}</div> : null,
}));

const mockConfig: AiProviderConfig = {
  id: 'config-1',
  provider: 'anthropic',
  displayName: 'My Claude',
  isActive: true,
  priority: 0,
  model: 'claude-sonnet-4-20250514',
  apiKeyMasked: '****abcd',
  baseUrl: null,
  config: {},
  inputCostPer1M: null,
  outputCostPer1M: null,
  costCurrency: 'USD',
  queryMaxIterations: null,
  queryMaxToolCalls: null,
  queryTimeoutMinutes: null,
  queryMaxInputTokens: null,
  queryMaxToolResultChars: null,
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
};

describe('ProviderList', () => {
  const onConfigsChanged = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockTestConnection.mockResolvedValue({ available: true });
  });

  it('renders empty state when no configs', () => {
    render(<ProviderList configs={[]} encryptionAvailable={true} onConfigsChanged={onConfigsChanged} />);
    expect(screen.getByText(/no ai providers configured/i)).toBeInTheDocument();
  });

  it('renders provider cards with details', () => {
    render(<ProviderList configs={[mockConfig]} encryptionAvailable={true} onConfigsChanged={onConfigsChanged} />);
    expect(screen.getByText('My Claude')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText(/claude-sonnet/)).toBeInTheDocument();
    expect(screen.getByText(/\*\*\*\*abcd/)).toBeInTheDocument();
  });

  it('shows encryption warning when not available', () => {
    render(<ProviderList configs={[]} encryptionAvailable={false} onConfigsChanged={onConfigsChanged} />);
    expect(screen.getByText(/ENCRYPTION_KEY is not configured/)).toBeInTheDocument();
  });

  it('renders Add Provider button', () => {
    render(<ProviderList configs={[]} encryptionAvailable={true} onConfigsChanged={onConfigsChanged} />);
    expect(screen.getByRole('button', { name: /add provider/i })).toBeInTheDocument();
  });

  it('calls delete and refreshes on Delete click', async () => {
    mockDeleteConfig.mockResolvedValueOnce(undefined);

    render(<ProviderList configs={[mockConfig]} encryptionAvailable={true} onConfigsChanged={onConfigsChanged} />);
    fireEvent.click(screen.getByRole('button', { name: /delete/i }));

    await waitFor(() => {
      expect(mockDeleteConfig).toHaveBeenCalledWith('config-1');
      expect(onConfigsChanged).toHaveBeenCalled();
    });
  });

  it('toggles active state on Disable click', async () => {
    mockUpdateConfig.mockResolvedValueOnce(undefined);

    render(<ProviderList configs={[mockConfig]} encryptionAvailable={true} onConfigsChanged={onConfigsChanged} />);
    fireEvent.click(screen.getByRole('button', { name: /disable/i }));

    await waitFor(() => {
      expect(mockUpdateConfig).toHaveBeenCalledWith('config-1', { isActive: false });
      expect(onConfigsChanged).toHaveBeenCalled();
    });
  });

  it('shows Edit form when Edit is clicked', async () => {
    render(<ProviderList configs={[mockConfig]} encryptionAvailable={true} onConfigsChanged={onConfigsChanged} />);
    fireEvent.click(screen.getByRole('button', { name: /edit/i }));

    await waitFor(() => {
      expect(screen.getByText('Edit Provider')).toBeInTheDocument();
    });
  });

  it('shows system default banner with provider and model when hasSystemDefault is true', () => {
    render(
      <ProviderList
        configs={[]}
        encryptionAvailable={true}
        onConfigsChanged={onConfigsChanged}
        hasSystemDefault={true}
        systemDefaultProvider="anthropic"
        systemDefaultModel="claude-sonnet-4-20250514"
      />,
    );

    expect(screen.getByText(/system default ai provider available/i)).toBeInTheDocument();
    // Provider label and model should appear in the banner
    expect(screen.getByText(/anthropic \(claude\)/i)).toBeInTheDocument();
    expect(screen.getByText(/claude-sonnet-4-20250514/i)).toBeInTheDocument();
  });

  it('shows system default banner with provider but no model when systemDefaultModel is null', () => {
    render(
      <ProviderList
        configs={[]}
        encryptionAvailable={true}
        onConfigsChanged={onConfigsChanged}
        hasSystemDefault={true}
        systemDefaultProvider="openai"
        systemDefaultModel={null}
      />,
    );

    expect(screen.getByText(/system default ai provider available/i)).toBeInTheDocument();
    expect(screen.getByText(/openai \(gpt\)/i)).toBeInTheDocument();
  });

  it('shows system default banner without provider details when systemDefaultProvider is null', () => {
    render(
      <ProviderList
        configs={[]}
        encryptionAvailable={true}
        onConfigsChanged={onConfigsChanged}
        hasSystemDefault={true}
        systemDefaultProvider={null}
        systemDefaultModel={null}
      />,
    );

    expect(screen.getByText(/system default ai provider available/i)).toBeInTheDocument();
  });

  it('shows empty state with system default message when hasSystemDefault and no configs', () => {
    render(
      <ProviderList
        configs={[]}
        encryptionAvailable={true}
        onConfigsChanged={onConfigsChanged}
        hasSystemDefault={true}
      />,
    );

    expect(screen.getByText(/system default provider will be used/i)).toBeInTheDocument();
  });

  it('shows "personal providers take priority" message when hasSystemDefault and configs exist', () => {
    render(
      <ProviderList
        configs={[mockConfig]}
        encryptionAvailable={true}
        onConfigsChanged={onConfigsChanged}
        hasSystemDefault={true}
        systemDefaultProvider="openai"
        systemDefaultModel={null}
      />,
    );

    expect(screen.getByText(/your personal providers take priority/i)).toBeInTheDocument();
  });

  it('renders provider fallback name from AI_PROVIDER_LABELS when displayName is null', () => {
    const configWithoutDisplayName: AiProviderConfig = {
      ...mockConfig,
      displayName: null,
    };

    render(
      <ProviderList
        configs={[configWithoutDisplayName]}
        encryptionAvailable={true}
        onConfigsChanged={onConfigsChanged}
      />,
    );

    expect(screen.getByText('Anthropic (Claude)')).toBeInTheDocument();
  });

  it('renders provider with baseUrl displayed', () => {
    const configWithUrl: AiProviderConfig = {
      ...mockConfig,
      provider: 'ollama',
      displayName: 'Local Ollama',
      apiKeyMasked: null,
      baseUrl: 'http://localhost:11434',
    };

    render(
      <ProviderList configs={[configWithUrl]} encryptionAvailable={true} onConfigsChanged={onConfigsChanged} />,
    );

    expect(screen.getByText(/localhost:11434/)).toBeInTheDocument();
  });

  it('renders cost info when inputCostPer1M or outputCostPer1M is set', () => {
    const configWithCost: AiProviderConfig = {
      ...mockConfig,
      inputCostPer1M: 3.0,
      outputCostPer1M: 15.0,
      costCurrency: 'USD',
      queryMaxIterations: null,
      queryMaxToolCalls: null,
      queryTimeoutMinutes: null,
      queryMaxInputTokens: null,
      queryMaxToolResultChars: null,
    };

    render(
      <ProviderList configs={[configWithCost]} encryptionAvailable={true} onConfigsChanged={onConfigsChanged} />,
    );

    expect(screen.getByText(/cost\/1m/i)).toBeInTheDocument();
    expect(screen.getByText(/3.*15/)).toBeInTheDocument();
  });

  it('renders inactive provider with Inactive badge and Enable button', () => {
    const inactiveConfig: AiProviderConfig = {
      ...mockConfig,
      isActive: false,
    };

    render(
      <ProviderList configs={[inactiveConfig]} encryptionAvailable={true} onConfigsChanged={onConfigsChanged} />,
    );

    expect(screen.getByText('Inactive')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /enable/i })).toBeInTheDocument();
  });

  it('toggles inactive provider to active on Enable click', async () => {
    const inactiveConfig: AiProviderConfig = {
      ...mockConfig,
      isActive: false,
    };
    mockUpdateConfig.mockResolvedValueOnce(undefined);

    render(
      <ProviderList configs={[inactiveConfig]} encryptionAvailable={true} onConfigsChanged={onConfigsChanged} />,
    );

    fireEvent.click(screen.getByRole('button', { name: /enable/i }));

    await waitFor(() => {
      expect(mockUpdateConfig).toHaveBeenCalledWith('config-1', { isActive: true });
      expect(onConfigsChanged).toHaveBeenCalled();
    });
  });

  it('shows error toast when toggleActive fails', async () => {
    mockUpdateConfig.mockRejectedValueOnce(new Error('network error'));

    render(
      <ProviderList configs={[mockConfig]} encryptionAvailable={true} onConfigsChanged={onConfigsChanged} />,
    );

    fireEvent.click(screen.getByRole('button', { name: /disable/i }));

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith('Failed to update provider');
    });
  });

  it('shows error toast when delete fails', async () => {
    mockDeleteConfig.mockRejectedValueOnce(new Error('server error'));

    render(
      <ProviderList configs={[mockConfig]} encryptionAvailable={true} onConfigsChanged={onConfigsChanged} />,
    );

    fireEvent.click(screen.getByRole('button', { name: /delete/i }));

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith('Failed to delete provider');
    });
  });

  it('disables all action buttons when disabled prop is true', () => {
    render(
      <ProviderList
        configs={[mockConfig]}
        encryptionAvailable={true}
        onConfigsChanged={onConfigsChanged}
        disabled={true}
      />,
    );

    const buttons = screen.getAllByRole('button');
    // Add Provider, Disable, Edit, Delete should all be disabled
    buttons.forEach((btn) => {
      expect(btn).toBeDisabled();
    });
  });

  it('does not render model or apiKeyMasked spans when both are null', () => {
    const bareConfig: AiProviderConfig = {
      ...mockConfig,
      model: null,
      apiKeyMasked: null,
      baseUrl: null,
      inputCostPer1M: null,
      outputCostPer1M: null,
    };

    render(
      <ProviderList configs={[bareConfig]} encryptionAvailable={true} onConfigsChanged={onConfigsChanged} />,
    );

    expect(screen.queryByText(/model:/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/key:/i)).not.toBeInTheDocument();
  });

  it('closes edit form when close callback is invoked', async () => {
    render(
      <ProviderList configs={[mockConfig]} encryptionAvailable={true} onConfigsChanged={onConfigsChanged} />,
    );

    fireEvent.click(screen.getByRole('button', { name: /edit/i }));

    await waitFor(() => {
      expect(screen.getByText('Edit Provider')).toBeInTheDocument();
    });

    // Close the modal using the Cancel button inside the form
    const cancelBtn = screen.getAllByRole('button').find((b) => b.textContent?.match(/cancel/i));
    if (cancelBtn) {
      fireEvent.click(cancelBtn);
      await waitFor(() => {
        expect(screen.queryByText('Edit Provider')).not.toBeInTheDocument();
      });
    }
  });

  it('shows Add Provider form when Add Provider is clicked', async () => {
    render(
      <ProviderList configs={[]} encryptionAvailable={true} onConfigsChanged={onConfigsChanged} />,
    );

    fireEvent.click(screen.getByRole('button', { name: /add provider/i }));

    await waitFor(() => {
      // The form modal renders a Provider select and Display Name field
      expect(screen.getByLabelText(/display name/i)).toBeInTheDocument();
    });
  });

  describe('auto-test after save', () => {
    it('runs testConnection against the newly-created provider id', async () => {
      mockCreateConfig.mockResolvedValueOnce({ ...mockConfig, id: 'new-id' });
      mockTestConnection.mockResolvedValueOnce({
        available: true,
        modelAvailable: true,
        model: 'claude-sonnet-4-20250514',
      });

      const { container } = render(
        <ProviderList
          configs={[]}
          encryptionAvailable={true}
          onConfigsChanged={onConfigsChanged}
        />,
      );
      // Invoke the create handler directly via an internal form submission
      // is fiddly; reach into the component by clicking "Add Provider"
      // then trigger the form's submit path via the hidden Modal.
      fireEvent.click(screen.getByRole('button', { name: /add provider/i }));
      const form = container.querySelector('form');
      expect(form).not.toBeNull();
      fireEvent.submit(form!);

      await waitFor(() => {
        expect(mockTestConnection).toHaveBeenCalledWith('new-id');
      });
      await waitFor(() => {
        expect(mockToastSuccess).toHaveBeenCalledWith(
          'Model "claude-sonnet-4-20250514" is ready.',
        );
      });
    });

    it('surfaces a warning toast when the saved config reaches the provider but the model is missing', async () => {
      mockUpdateConfig.mockResolvedValueOnce({ ...mockConfig });
      mockTestConnection.mockResolvedValueOnce({
        available: true,
        modelAvailable: false,
        model: 'typo-4o',
        modelError: 'Model "typo-4o" was not found.',
      });

      const { container } = render(
        <ProviderList
          configs={[mockConfig]}
          encryptionAvailable={true}
          onConfigsChanged={onConfigsChanged}
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: /edit/i }));
      const form = container.querySelector('form');
      expect(form).not.toBeNull();
      fireEvent.submit(form!);

      await waitFor(() => {
        expect(mockToastError).toHaveBeenCalledWith(
          'Model "typo-4o" was not found.',
          expect.objectContaining({ duration: 7000 }),
        );
      });
    });

    it('surfaces a warning toast when the saved provider is unreachable', async () => {
      mockCreateConfig.mockResolvedValueOnce({ ...mockConfig, id: 'new-id' });
      mockTestConnection.mockResolvedValueOnce({
        available: false,
        error: 'Connection test failed. Check your provider settings.',
      });

      const { container } = render(
        <ProviderList
          configs={[]}
          encryptionAvailable={true}
          onConfigsChanged={onConfigsChanged}
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: /add provider/i }));
      const form = container.querySelector('form');
      fireEvent.submit(form!);

      await waitFor(() => {
        expect(mockToastError).toHaveBeenCalledWith(
          'Connection test failed. Check your provider settings.',
          expect.objectContaining({ duration: 7000 }),
        );
      });
    });

    it('shows fallback error toast when provider is unreachable and error message is absent', async () => {
      mockCreateConfig.mockResolvedValueOnce({ ...mockConfig, id: 'new-id' });
      mockTestConnection.mockResolvedValueOnce({ available: false });

      const { container } = render(
        <ProviderList
          configs={[]}
          encryptionAvailable={true}
          onConfigsChanged={onConfigsChanged}
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: /add provider/i }));
      const form = container.querySelector('form');
      fireEvent.submit(form!);

      await waitFor(() => {
        expect(mockToastError).toHaveBeenCalledWith(
          expect.stringMatching(/saved, but the provider could not be reached/i),
          expect.objectContaining({ duration: 7000 }),
        );
      });
    });

    it('shows fallback model error toast when model is unavailable and modelError is absent', async () => {
      mockUpdateConfig.mockResolvedValueOnce({ ...mockConfig });
      mockTestConnection.mockResolvedValueOnce({
        available: true,
        modelAvailable: false,
        model: 'bad-model',
        // no modelError field
      });

      const { container } = render(
        <ProviderList
          configs={[mockConfig]}
          encryptionAvailable={true}
          onConfigsChanged={onConfigsChanged}
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: /edit/i }));
      const form = container.querySelector('form');
      fireEvent.submit(form!);

      await waitFor(() => {
        expect(mockToastError).toHaveBeenCalledWith(
          expect.stringMatching(/bad-model.*is not available/i),
          expect.objectContaining({ duration: 7000 }),
        );
      });
    });

    it('does not show model-ready toast when available is true but modelAvailable is not set', async () => {
      mockCreateConfig.mockResolvedValueOnce({ ...mockConfig, id: 'new-id' });
      // available true, modelAvailable undefined — none of the conditional toast branches fire
      mockTestConnection.mockResolvedValueOnce({ available: true });

      const { container } = render(
        <ProviderList
          configs={[]}
          encryptionAvailable={true}
          onConfigsChanged={onConfigsChanged}
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: /add provider/i }));
      const form = container.querySelector('form');
      fireEvent.submit(form!);

      await waitFor(() => {
        expect(mockTestConnection).toHaveBeenCalled();
      });
      // The "Provider added" success toast fires from handleCreate but no model-ready toast
      const successMessages = mockToastSuccess.mock.calls.map((c) => c[0]);
      expect(successMessages).not.toContain(expect.stringMatching(/is ready/i));
      expect(mockToastError).not.toHaveBeenCalled();
    });

    it('stays silent when the post-save test itself throws (non-fatal)', async () => {
      mockCreateConfig.mockResolvedValueOnce({ ...mockConfig, id: 'new-id' });
      mockTestConnection.mockRejectedValueOnce(new Error('network down'));

      const { container } = render(
        <ProviderList
          configs={[]}
          encryptionAvailable={true}
          onConfigsChanged={onConfigsChanged}
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: /add provider/i }));
      const form = container.querySelector('form');
      fireEvent.submit(form!);

      await waitFor(() => {
        expect(mockTestConnection).toHaveBeenCalled();
      });
      // Save already succeeded; we swallow post-save test errors so the
      // user isn't spammed with a scary-looking toast for a non-fatal probe.
      const errorToasts = mockToastError.mock.calls as unknown[][];
      expect(
        errorToasts.some(
          (args) => typeof args[0] === 'string' && args[0].includes('network down'),
        ),
      ).toBe(false);
    });
  });
});

describe('ProviderList — the centrally managed provider', () => {
  it('says its limits are the administrator\'s, so the per-provider ones do not read as missing', () => {
    render(
      <ProviderList
        configs={[]}
        encryptionAvailable={true}
        onConfigsChanged={vi.fn()}
        hasSystemDefault={true}
        systemDefaultProvider="anthropic"
        systemDefaultModel="claude-sonnet-4-20250514"
      />,
    );

    expect(
      screen.getByText(/managed by your administrator/i),
    ).toBeInTheDocument();
  });

  it('says nothing about administrator-managed limits when there is no system default', () => {
    render(
      <ProviderList
        configs={[]}
        encryptionAvailable={true}
        onConfigsChanged={vi.fn()}
        hasSystemDefault={false}
      />,
    );

    expect(
      screen.queryByText(/managed by your administrator/i),
    ).not.toBeInTheDocument();
  });
});
