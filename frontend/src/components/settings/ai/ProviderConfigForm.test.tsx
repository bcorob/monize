import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@/test/render';
import { ProviderConfigForm } from './ProviderConfigForm';
import type { AiProviderConfig } from '@/types/ai';
import { AI_QUERY_BUDGETS, AI_QUERY_BUDGET_FIELDS } from '@/lib/ai-query-budgets';

const mockTestDraft = vi.fn();
const mockCreateConfig = vi.fn();
const mockUpdateConfig = vi.fn();

vi.mock('@/lib/ai', () => ({
  aiApi: {
    testDraft: (...args: unknown[]) => mockTestDraft(...args),
    createConfig: (...args: unknown[]) => mockCreateConfig(...args),
    updateConfig: (...args: unknown[]) => mockUpdateConfig(...args),
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
  Modal: ({ children, isOpen }: any) => (isOpen ? <div data-testid="modal">{children}</div> : null),
}));

const existingConfig: AiProviderConfig = {
  id: 'existing-1',
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

describe('ProviderConfigForm — inline Test button', () => {
  const noop = async () => undefined;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders a Test button next to the Model input', () => {
    render(
      <ProviderConfigForm isOpen={true} onClose={noop} onSubmit={noop} />,
    );
    expect(screen.getByRole('button', { name: /test model/i })).toBeInTheDocument();
  });

  it('sends the current form values to testDraft when clicked', async () => {
    mockTestDraft.mockResolvedValueOnce({
      available: true,
      modelAvailable: true,
      model: 'claude-sonnet-4-20250514',
    });

    const { container } = render(
      <ProviderConfigForm isOpen={true} onClose={noop} onSubmit={noop} />,
    );

    // Fill in a model and API key so the draft body mirrors what the
    // user typed (anthropic is the default provider).
    const modelInput = container.querySelector('input[name="model"]') as HTMLInputElement;
    const apiKeyInput = container.querySelector('input[name="apiKey"]') as HTMLInputElement;
    fireEvent.change(modelInput, { target: { value: 'claude-sonnet-4-20250514' } });
    fireEvent.change(apiKeyInput, { target: { value: 'sk-ant-test' } });

    fireEvent.click(screen.getByRole('button', { name: /test model/i }));

    await waitFor(() => {
      expect(mockTestDraft).toHaveBeenCalledWith({
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        apiKey: 'sk-ant-test',
      });
    });
    await waitFor(() => {
      expect(mockToastSuccess).toHaveBeenCalledWith(
        'Model "claude-sonnet-4-20250514" is ready.',
      );
    });
  });

  it('surfaces modelError when the server is reachable but the model is missing', async () => {
    mockTestDraft.mockResolvedValueOnce({
      available: true,
      modelAvailable: false,
      model: 'typo-4o',
      modelError: 'Model "typo-4o" was not found.',
    });

    render(
      <ProviderConfigForm isOpen={true} onClose={noop} onSubmit={noop} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /test model/i }));

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith(
        'Model "typo-4o" was not found.',
        expect.objectContaining({ duration: 7000 }),
      );
    });
  });

  it('surfaces a connection error when the provider itself is unreachable', async () => {
    mockTestDraft.mockResolvedValueOnce({
      available: false,
      error: 'Connection test failed. Check your provider settings.',
    });

    render(
      <ProviderConfigForm isOpen={true} onClose={noop} onSubmit={noop} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /test model/i }));

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith(
        'Connection test failed. Check your provider settings.',
        expect.objectContaining({ duration: 6000 }),
      );
    });
  });

  it('passes configId (not apiKey) when editing without retyping the stored key', async () => {
    mockTestDraft.mockResolvedValueOnce({ available: true, modelAvailable: true, model: existingConfig.model });

    render(
      <ProviderConfigForm
        isOpen={true}
        onClose={noop}
        onSubmit={noop}
        editConfig={existingConfig}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /test model/i }));

    await waitFor(() => {
      expect(mockTestDraft).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'anthropic',
          model: 'claude-sonnet-4-20250514',
          configId: 'existing-1',
        }),
      );
    });
    // The user didn't type a new key, so apiKey must NOT be sent.
    expect(mockTestDraft.mock.calls[0][0]).not.toHaveProperty('apiKey');
  });

  it('prefers a newly-typed apiKey over the configId fallback', async () => {
    mockTestDraft.mockResolvedValueOnce({ available: true, modelAvailable: true, model: existingConfig.model });

    const { container } = render(
      <ProviderConfigForm
        isOpen={true}
        onClose={noop}
        onSubmit={noop}
        editConfig={existingConfig}
      />,
    );
    const apiKeyInput = container.querySelector('input[name="apiKey"]') as HTMLInputElement;
    fireEvent.change(apiKeyInput, { target: { value: 'sk-new-key' } });

    fireEvent.click(screen.getByRole('button', { name: /test model/i }));

    await waitFor(() => {
      expect(mockTestDraft).toHaveBeenCalled();
    });
    const payload = mockTestDraft.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.apiKey).toBe('sk-new-key');
    // When the user has typed a new key the configId fallback is not needed.
    expect(payload.configId).toBeUndefined();
  });

  it('falls back to the generic fetch-failed toast when testDraft throws', async () => {
    mockTestDraft.mockRejectedValueOnce(new Error('Network error'));

    render(
      <ProviderConfigForm isOpen={true} onClose={noop} onSubmit={noop} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /test model/i }));

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith('Model test failed');
    });
  });

  it('disables the Test button while a test is in flight', async () => {
    let resolveTest: (v: unknown) => void;
    mockTestDraft.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveTest = resolve;
      }),
    );

    render(
      <ProviderConfigForm isOpen={true} onClose={noop} onSubmit={noop} />,
    );
    const button = screen.getByRole('button', { name: /test model/i });
    fireEvent.click(button);

    await waitFor(() => {
      expect(button).toBeDisabled();
    });

    resolveTest!({ available: true });
    await waitFor(() => {
      expect(button).not.toBeDisabled();
    });
  });
});

describe('ProviderConfigForm — provider-specific field rendering', () => {
  const noop = async () => undefined;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows the Provider select only when creating (no editConfig)', () => {
    render(<ProviderConfigForm isOpen={true} onClose={noop} onSubmit={noop} />);
    expect(screen.getByRole('combobox', { name: /provider/i })).toBeInTheDocument();
  });

  it('hides the Provider select when editing an existing config', () => {
    render(
      <ProviderConfigForm
        isOpen={true}
        onClose={noop}
        onSubmit={noop}
        editConfig={existingConfig}
      />,
    );
    expect(screen.queryByRole('combobox', { name: /provider/i })).not.toBeInTheDocument();
  });

  it('shows "Edit Provider" title when editConfig is present', () => {
    render(
      <ProviderConfigForm
        isOpen={true}
        onClose={noop}
        onSubmit={noop}
        editConfig={existingConfig}
      />,
    );
    expect(screen.getByText('Edit Provider')).toBeInTheDocument();
  });

  it('shows "Add AI Provider" title when creating', () => {
    render(<ProviderConfigForm isOpen={true} onClose={noop} onSubmit={noop} />);
    expect(screen.getByText('Add AI Provider')).toBeInTheDocument();
  });

  it('shows API Key field for anthropic (needs key)', () => {
    render(<ProviderConfigForm isOpen={true} onClose={noop} onSubmit={noop} />);
    expect(screen.getByLabelText(/api key/i)).toBeInTheDocument();
  });

  it('shows API Key field for openai provider', async () => {
    const { container } = render(<ProviderConfigForm isOpen={true} onClose={noop} onSubmit={noop} />);
    const providerSelect = container.querySelector('select[name="provider"]') as HTMLSelectElement;
    fireEvent.change(providerSelect, { target: { value: 'openai' } });
    expect(screen.getByLabelText(/api key/i)).toBeInTheDocument();
  });

  it('hides API Key field for ollama provider (no key needed)', async () => {
    const { container } = render(<ProviderConfigForm isOpen={true} onClose={noop} onSubmit={noop} />);
    const providerSelect = container.querySelector('select[name="provider"]') as HTMLSelectElement;
    fireEvent.change(providerSelect, { target: { value: 'ollama' } });
    expect(screen.queryByLabelText(/api key/i)).not.toBeInTheDocument();
  });

  it('shows Base URL field for ollama provider', async () => {
    const { container } = render(<ProviderConfigForm isOpen={true} onClose={noop} onSubmit={noop} />);
    const providerSelect = container.querySelector('select[name="provider"]') as HTMLSelectElement;
    fireEvent.change(providerSelect, { target: { value: 'ollama' } });
    expect(screen.getByLabelText(/base url/i)).toBeInTheDocument();
  });

  it('shows Base URL field for openai-compatible provider', async () => {
    const { container } = render(<ProviderConfigForm isOpen={true} onClose={noop} onSubmit={noop} />);
    const providerSelect = container.querySelector('select[name="provider"]') as HTMLSelectElement;
    fireEvent.change(providerSelect, { target: { value: 'openai-compatible' } });
    expect(screen.getByLabelText(/base url/i)).toBeInTheDocument();
  });

  it.each(['ollama', 'openai-compatible'])(
    'says under the %s Base URL who may use a private address',
    (value) => {
      const { container } = render(<ProviderConfigForm isOpen={true} onClose={noop} onSubmit={noop} />);
      const providerSelect = container.querySelector('select[name="provider"]') as HTMLSelectElement;
      fireEvent.change(providerSelect, { target: { value } });
      expect(
        screen.getByText(/private or local address .* works only for an administrator/i),
      ).toBeInTheDocument();
    },
  );

  it('does not show the private-address note where there is no Base URL', () => {
    render(<ProviderConfigForm isOpen={true} onClose={noop} onSubmit={noop} />);
    expect(screen.queryByText(/works only for an administrator/i)).not.toBeInTheDocument();
  });

  it('hides Base URL field for anthropic provider', () => {
    render(<ProviderConfigForm isOpen={true} onClose={noop} onSubmit={noop} />);
    expect(screen.queryByLabelText(/base url/i)).not.toBeInTheDocument();
  });

  it('hides Base URL field for ollama-cloud provider', async () => {
    const { container } = render(<ProviderConfigForm isOpen={true} onClose={noop} onSubmit={noop} />);
    const providerSelect = container.querySelector('select[name="provider"]') as HTMLSelectElement;
    fireEvent.change(providerSelect, { target: { value: 'ollama-cloud' } });
    expect(screen.queryByLabelText(/base url/i)).not.toBeInTheDocument();
  });

  it('shows the ollama-cloud model suffix hint', async () => {
    const { container } = render(<ProviderConfigForm isOpen={true} onClose={noop} onSubmit={noop} />);
    const providerSelect = container.querySelector('select[name="provider"]') as HTMLSelectElement;
    fireEvent.change(providerSelect, { target: { value: 'ollama-cloud' } });
    // The hint paragraph contains the text about the -cloud suffix
    expect(screen.getByText(/Model names must include the/)).toBeInTheDocument();
  });

  it('hides the ollama-cloud hint for other providers', () => {
    render(<ProviderConfigForm isOpen={true} onClose={noop} onSubmit={noop} />);
    expect(screen.queryByText(/Model names must include the/)).not.toBeInTheDocument();
  });

  it('shows model suggestion chips for anthropic', () => {
    render(<ProviderConfigForm isOpen={true} onClose={noop} onSubmit={noop} />);
    // anthropic has suggestions like claude-sonnet-4-20250514
    expect(screen.getByText('claude-sonnet-4-20250514')).toBeInTheDocument();
  });

  it('shows no model suggestion chips for openai-compatible (empty suggestions array)', async () => {
    const { container } = render(<ProviderConfigForm isOpen={true} onClose={noop} onSubmit={noop} />);
    const providerSelect = container.querySelector('select[name="provider"]') as HTMLSelectElement;
    fireEvent.change(providerSelect, { target: { value: 'openai-compatible' } });
    // openai-compatible has no default models, so no chip buttons should appear
    expect(screen.queryByText('gpt-4o')).not.toBeInTheDocument();
  });

  it('clicking a model chip sets the model input value', async () => {
    const { container } = render(<ProviderConfigForm isOpen={true} onClose={noop} onSubmit={noop} />);
    const modelInput = container.querySelector('input[name="model"]') as HTMLInputElement;
    fireEvent.click(screen.getByText('claude-sonnet-4-20250514'));
    expect(modelInput.value).toBe('claude-sonnet-4-20250514');
  });

  it('uses the masked API key as placeholder when editing', () => {
    render(
      <ProviderConfigForm
        isOpen={true}
        onClose={noop}
        onSubmit={noop}
        editConfig={existingConfig}
      />,
    );
    const apiKeyInput = screen.getByLabelText(/api key/i) as HTMLInputElement;
    expect(apiKeyInput.placeholder).toBe('****abcd');
  });

  it('uses ollama placeholder URL for ollama provider', async () => {
    const { container } = render(<ProviderConfigForm isOpen={true} onClose={noop} onSubmit={noop} />);
    const providerSelect = container.querySelector('select[name="provider"]') as HTMLSelectElement;
    fireEvent.change(providerSelect, { target: { value: 'ollama' } });
    const baseUrlInput = screen.getByLabelText(/base url/i) as HTMLInputElement;
    expect(baseUrlInput.placeholder).toBe('http://localhost:11434');
  });

  it('uses generic placeholder URL for openai-compatible provider', async () => {
    const { container } = render(<ProviderConfigForm isOpen={true} onClose={noop} onSubmit={noop} />);
    const providerSelect = container.querySelector('select[name="provider"]') as HTMLSelectElement;
    fireEvent.change(providerSelect, { target: { value: 'openai-compatible' } });
    const baseUrlInput = screen.getByLabelText(/base url/i) as HTMLInputElement;
    expect(baseUrlInput.placeholder).toBe('https://api.example.com/v1');
  });

  it('renders the modal as null when isOpen is false', () => {
    render(<ProviderConfigForm isOpen={false} onClose={noop} onSubmit={noop} />);
    expect(screen.queryByTestId('modal')).not.toBeInTheDocument();
  });

  it('calls onClose when Cancel is clicked', () => {
    const onClose = vi.fn();
    render(<ProviderConfigForm isOpen={true} onClose={onClose} onSubmit={noop} />);
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onClose).toHaveBeenCalled();
  });
});

describe('ProviderConfigForm — form submission', () => {
  const noop = async () => undefined;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls onSubmit with create payload and then onClose on success', async () => {
    const onSubmit = vi.fn().mockResolvedValueOnce(undefined);
    const onClose = vi.fn();
    const { container } = render(
      <ProviderConfigForm isOpen={true} onClose={onClose} onSubmit={onSubmit} />,
    );

    const modelInput = container.querySelector('input[name="model"]') as HTMLInputElement;
    const apiKeyInput = container.querySelector('input[name="apiKey"]') as HTMLInputElement;
    fireEvent.change(modelInput, { target: { value: 'claude-sonnet-4-20250514' } });
    fireEvent.change(apiKeyInput, { target: { value: 'sk-ant-123' } });

    fireEvent.click(screen.getByRole('button', { name: /add provider/i }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'anthropic',
          model: 'claude-sonnet-4-20250514',
          apiKey: 'sk-ant-123',
        }),
      );
    });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('shows error message when onSubmit rejects', async () => {
    const onSubmit = vi.fn().mockRejectedValueOnce(new Error('Server error'));
    render(
      <ProviderConfigForm isOpen={true} onClose={noop} onSubmit={onSubmit} />,
    );

    fireEvent.click(screen.getByRole('button', { name: /add provider/i }));

    await waitFor(() => {
      expect(screen.getByText('Server error')).toBeInTheDocument();
    });
  });

  it('shows fallback error message when onSubmit rejects with non-Error', async () => {
    const onSubmit = vi.fn().mockRejectedValueOnce('plain string error');
    render(
      <ProviderConfigForm isOpen={true} onClose={noop} onSubmit={onSubmit} />,
    );

    fireEvent.click(screen.getByRole('button', { name: /add provider/i }));

    await waitFor(() => {
      expect(screen.getByText('Failed to save configuration')).toBeInTheDocument();
    });
  });

  it('submits update payload when editing and only sends changed fields', async () => {
    const onSubmit = vi.fn().mockResolvedValueOnce(undefined);
    const onClose = vi.fn();
    const { container } = render(
      <ProviderConfigForm
        isOpen={true}
        onClose={onClose}
        onSubmit={onSubmit}
        editConfig={existingConfig}
      />,
    );

    // Change display name only
    const displayNameInput = container.querySelector('input[name="displayName"]') as HTMLInputElement;
    fireEvent.change(displayNameInput, { target: { value: 'Updated Name' } });

    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({ displayName: 'Updated Name' }),
      );
    });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('sends apiKey in update payload when a new key is typed', async () => {
    const onSubmit = vi.fn().mockResolvedValueOnce(undefined);
    const { container } = render(
      <ProviderConfigForm
        isOpen={true}
        onClose={noop}
        onSubmit={onSubmit}
        editConfig={existingConfig}
      />,
    );

    const apiKeyInput = container.querySelector('input[name="apiKey"]') as HTMLInputElement;
    fireEvent.change(apiKeyInput, { target: { value: 'sk-new-key' } });

    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({ apiKey: 'sk-new-key' }),
      );
    });
  });

  it('sends priority as integer in update payload when changed', async () => {
    const onSubmit = vi.fn().mockResolvedValueOnce(undefined);
    const { container } = render(
      <ProviderConfigForm
        isOpen={true}
        onClose={noop}
        onSubmit={onSubmit}
        editConfig={existingConfig}
      />,
    );

    const priorityInput = container.querySelector('input[name="priority"]') as HTMLInputElement;
    fireEvent.change(priorityInput, { target: { value: '5' } });

    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({ priority: 5 }),
      );
    });
  });

  it('includes cost fields in create payload when filled in', async () => {
    const onSubmit = vi.fn().mockResolvedValueOnce(undefined);
    const { container } = render(
      <ProviderConfigForm isOpen={true} onClose={noop} onSubmit={onSubmit} />,
    );

    const inputCostInput = container.querySelector('input[name="inputCostPer1M"]') as HTMLInputElement;
    const outputCostInput = container.querySelector('input[name="outputCostPer1M"]') as HTMLInputElement;
    fireEvent.change(inputCostInput, { target: { value: '3.00' } });
    fireEvent.change(outputCostInput, { target: { value: '15.00' } });

    fireEvent.click(screen.getByRole('button', { name: /add provider/i }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({ inputCostPer1M: 3, outputCostPer1M: 15 }),
      );
    });
  });

  it('omits cost fields from create payload when left blank', async () => {
    const onSubmit = vi.fn().mockResolvedValueOnce(undefined);
    render(<ProviderConfigForm isOpen={true} onClose={noop} onSubmit={onSubmit} />);

    fireEvent.click(screen.getByRole('button', { name: /add provider/i }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalled();
      const payload = onSubmit.mock.calls[0][0] as Record<string, unknown>;
      expect(payload).not.toHaveProperty('inputCostPer1M');
      expect(payload).not.toHaveProperty('outputCostPer1M');
    });
  });

  it('sends costCurrency in update payload when changed', async () => {
    const onSubmit = vi.fn().mockResolvedValueOnce(undefined);
    const { container } = render(
      <ProviderConfigForm
        isOpen={true}
        onClose={noop}
        onSubmit={onSubmit}
        editConfig={existingConfig}
      />,
    );

    const currencySelect = container.querySelector('select[name="costCurrency"]') as HTMLSelectElement;
    fireEvent.change(currencySelect, { target: { value: 'EUR' } });

    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({ costCurrency: 'EUR' }),
      );
    });
  });

  it('pre-populates cost fields from editConfig when they are non-null', async () => {
    const configWithCosts: typeof existingConfig = {
      ...existingConfig,
      inputCostPer1M: 3,
      outputCostPer1M: 15,
      costCurrency: 'USD',
      queryMaxIterations: null,
      queryMaxToolCalls: null,
      queryTimeoutMinutes: null,
      queryMaxInputTokens: null,
      queryMaxToolResultChars: null,
    };
    const onSubmit = vi.fn().mockResolvedValueOnce(undefined);
    const { container } = render(
      <ProviderConfigForm
        isOpen={true}
        onClose={noop}
        onSubmit={onSubmit}
        editConfig={configWithCosts}
      />,
    );

    const inputCostInput = container.querySelector('input[name="inputCostPer1M"]') as HTMLInputElement;
    const outputCostInput = container.querySelector('input[name="outputCostPer1M"]') as HTMLInputElement;
    expect(inputCostInput.value).toBe('3.0000');
    expect(outputCostInput.value).toBe('15.0000');
  });

  it('does not send displayName in update when it matches the existing value', async () => {
    const onSubmit = vi.fn().mockResolvedValueOnce(undefined);
    render(
      <ProviderConfigForm
        isOpen={true}
        onClose={noop}
        onSubmit={onSubmit}
        editConfig={existingConfig}
      />,
    );

    // Don't change anything, just submit
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalled();
      const payload = onSubmit.mock.calls[0][0] as Record<string, unknown>;
      // displayName unchanged — should not appear in diff
      expect(payload).not.toHaveProperty('displayName');
    });
  });

  it('test status resets to idle after a successful test', async () => {
    mockTestDraft.mockResolvedValueOnce({
      available: true,
      modelAvailable: undefined,
    });

    render(<ProviderConfigForm isOpen={true} onClose={noop} onSubmit={noop} />);
    const testBtn = screen.getByRole('button', { name: /test model/i });
    fireEvent.click(testBtn);

    await waitFor(() => {
      // After success with no modelAvailable, toast.success called with 'Connection successful.'
      expect(mockToastSuccess).toHaveBeenCalledWith('Connection successful.');
    });
  });

  it('shows "Save Changes" button label when editing', () => {
    render(
      <ProviderConfigForm
        isOpen={true}
        onClose={noop}
        onSubmit={noop}
        editConfig={existingConfig}
      />,
    );
    expect(screen.getByRole('button', { name: /save changes/i })).toBeInTheDocument();
  });
});

/**
 * Per-query budgets belong to the provider the user configured, so the form is
 * where they are set. The AI_QUERY_* environment variables size the centrally
 * managed provider only, and there is nothing in this form for them to reach.
 */
describe('ProviderConfigForm — per-query budgets', () => {
  const noop = async () => undefined;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  const budgetInput = (container: HTMLElement, name: string) =>
    container.querySelector(`input[name="${name}"]`) as HTMLInputElement;

  it('renders a field for every budget', () => {
    const { container } = render(
      <ProviderConfigForm isOpen={true} onClose={noop} onSubmit={noop} />,
    );

    for (const field of AI_QUERY_BUDGET_FIELDS) {
      expect(budgetInput(container, field.name)).toBeInTheDocument();
    }
  });

  it('shows each default as the placeholder, so blank is readable as "default"', () => {
    const { container } = render(
      <ProviderConfigForm isOpen={true} onClose={noop} onSubmit={noop} />,
    );

    for (const field of AI_QUERY_BUDGET_FIELDS) {
      expect(budgetInput(container, field.name).placeholder).toBe(
        `Default: ${field.default}`,
      );
    }
  });

  it('leaves the fields blank when the provider carries no overrides', () => {
    const { container } = render(
      <ProviderConfigForm
        isOpen={true}
        onClose={noop}
        onSubmit={noop}
        editConfig={existingConfig}
      />,
    );

    for (const field of AI_QUERY_BUDGET_FIELDS) {
      expect(budgetInput(container, field.name).value).toBe('');
    }
  });

  it('shows the stored value when the provider has one', () => {
    const { container } = render(
      <ProviderConfigForm
        isOpen={true}
        onClose={noop}
        onSubmit={noop}
        editConfig={{ ...existingConfig, queryMaxIterations: 12 }}
      />,
    );

    expect(budgetInput(container, 'queryMaxIterations').value).toBe('12');
  });

  it('sends a typed budget on create and omits the ones left blank', async () => {
    const onSubmit = vi.fn().mockResolvedValueOnce(undefined);
    const { container } = render(
      <ProviderConfigForm isOpen={true} onClose={noop} onSubmit={onSubmit} />,
    );

    fireEvent.change(budgetInput(container, 'queryMaxIterations'), {
      target: { value: '12' },
    });
    fireEvent.click(screen.getByRole('button', { name: /add provider/i }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const payload = onSubmit.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.queryMaxIterations).toBe(12);
    expect(payload).not.toHaveProperty('queryMaxToolCalls');
  });

  it('sends a changed budget on update', async () => {
    const onSubmit = vi.fn().mockResolvedValueOnce(undefined);
    const { container } = render(
      <ProviderConfigForm
        isOpen={true}
        onClose={noop}
        onSubmit={onSubmit}
        editConfig={{ ...existingConfig, queryMaxToolCalls: 20 }}
      />,
    );

    fireEvent.change(budgetInput(container, 'queryMaxToolCalls'), {
      target: { value: '40' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(
      (onSubmit.mock.calls[0][0] as Record<string, unknown>).queryMaxToolCalls,
    ).toBe(40);
  });

  it('sends null when a stored budget is cleared, not an omitted field', async () => {
    // Omitting it would leave the old ceiling in place, so the field would
    // look cleared and behave exactly as before.
    const onSubmit = vi.fn().mockResolvedValueOnce(undefined);
    const { container } = render(
      <ProviderConfigForm
        isOpen={true}
        onClose={noop}
        onSubmit={onSubmit}
        editConfig={{ ...existingConfig, queryTimeoutMinutes: 45 }}
      />,
    );

    fireEvent.change(budgetInput(container, 'queryTimeoutMinutes'), {
      target: { value: '' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const payload = onSubmit.mock.calls[0][0] as Record<string, unknown>;
    expect(payload).toHaveProperty('queryTimeoutMinutes', null);
  });

  it('leaves an untouched budget out of the update payload', async () => {
    const onSubmit = vi.fn().mockResolvedValueOnce(undefined);
    render(
      <ProviderConfigForm
        isOpen={true}
        onClose={noop}
        onSubmit={onSubmit}
        editConfig={{ ...existingConfig, queryMaxIterations: 12 }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0][0]).not.toHaveProperty('queryMaxIterations');
  });

  it('refuses a value below the budget minimum rather than sending it', async () => {
    const onSubmit = vi.fn();
    const { container } = render(
      <ProviderConfigForm isOpen={true} onClose={noop} onSubmit={onSubmit} />,
    );

    fireEvent.change(budgetInput(container, 'queryMaxInputTokens'), {
      target: { value: '10' },
    });
    fireEvent.click(screen.getByRole('button', { name: /add provider/i }));

    await waitFor(() => {
      expect(
        screen.getByText(
          `Must be between ${AI_QUERY_BUDGETS.queryMaxInputTokens.min} and ${AI_QUERY_BUDGETS.queryMaxInputTokens.max}`,
        ),
      ).toBeInTheDocument();
    });
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
