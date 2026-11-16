import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, within } from '@/test/render';
import { InsightsList } from './InsightsList';

const mockGetStatus = vi.fn();
const mockGetInsights = vi.fn();
const mockGenerateInsights = vi.fn();
const mockDismissInsight = vi.fn();
const mockGetRelayStatus = vi.fn();

vi.mock('@/lib/ai', () => ({
  aiApi: {
    getStatus: (...args: unknown[]) => mockGetStatus(...args),
    getInsights: (...args: unknown[]) => mockGetInsights(...args),
    generateInsights: (...args: unknown[]) => mockGenerateInsights(...args),
    dismissInsight: (...args: unknown[]) => mockDismissInsight(...args),
    // Used by the RelayStatusBar tunnel indicator when the relay is active.
    getRelayStatus: (...args: unknown[]) => mockGetRelayStatus(...args),
  },
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Render and flush all pending async state updates (e.g. useEffect API calls)
async function renderInsights() {
  let result: ReturnType<typeof render>;
  await act(async () => {
    result = render(<InsightsList />);
  });
  return result!;
}

describe('InsightsList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    mockGetStatus.mockResolvedValue({
      configured: true,
      relayActive: false,
    });
    mockGetInsights.mockResolvedValue({
      insights: [],
      total: 0,
      lastGeneratedAt: null,
      isGenerating: false,
    });
    mockGetRelayStatus.mockResolvedValue({ state: 'listening', queued: 0 });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  });

  it('shows loading skeleton initially', async () => {
    mockGetInsights.mockReturnValue(new Promise(() => {})); // never resolves
    let container: HTMLElement;
    await act(async () => {
      ({ container } = render(<InsightsList />));
    });
    expect(container!.querySelector('.animate-pulse')).toBeTruthy();
  });

  it('shows empty state when no insights exist', async () => {
    await renderInsights();

    await waitFor(() => {
      expect(
        screen.getByText(/No insights generated yet/),
      ).toBeInTheDocument();
    });
  });

  it('shows generate button in empty state', async () => {
    await renderInsights();

    await waitFor(() => {
      expect(screen.getByText('Generate Insights')).toBeInTheDocument();
    });
  });

  it('renders insights when they exist', async () => {
    mockGetInsights.mockResolvedValue({
      insights: [
        {
          id: 'i1',
          type: 'anomaly',
          title: 'High Dining Spending',
          description: 'Spending is above average',
          severity: 'warning',
          data: {},
          isDismissed: false,
          generatedAt: '2026-02-18T00:00:00.000Z',
          expiresAt: '2026-02-25T00:00:00.000Z',
          createdAt: '2026-02-18T00:00:00.000Z',
        },
      ],
      total: 1,
      lastGeneratedAt: '2026-02-18T00:00:00.000Z',
      isGenerating: false,
    });

    await renderInsights();

    await waitFor(() => {
      expect(screen.getByText('High Dining Spending')).toBeInTheDocument();
    });
  });

  it('counts alerts and warnings in summary cards and on the severity segments', async () => {
    mockGetInsights.mockResolvedValue({
      insights: [
        {
          id: 'i1',
          type: 'anomaly',
          title: 'Alert 1',
          description: 'Desc',
          severity: 'alert',
          data: {},
          isDismissed: false,
          generatedAt: '2026-02-18T00:00:00.000Z',
          expiresAt: '2026-02-25T00:00:00.000Z',
          createdAt: '2026-02-18T00:00:00.000Z',
        },
        {
          id: 'i2',
          type: 'trend',
          title: 'Warning 1',
          description: 'Desc',
          severity: 'warning',
          data: {},
          isDismissed: false,
          generatedAt: '2026-02-18T00:00:00.000Z',
          expiresAt: '2026-02-25T00:00:00.000Z',
          createdAt: '2026-02-18T00:00:00.000Z',
        },
      ],
      total: 2,
      lastGeneratedAt: '2026-02-18T00:00:00.000Z',
      isGenerating: false,
    });

    await renderInsights();

    await waitFor(() => {
      expect(screen.getByText('Active Insights')).toBeInTheDocument();
    });
    const card = (label: string) => screen.getByText(label, { selector: 'dt' }).nextElementSibling;
    expect(card('Active Insights')).toHaveTextContent('2');
    expect(card('Alerts')).toHaveTextContent('1');
    expect(card('Warnings')).toHaveTextContent('1');

    const severity = screen.getByRole('group', { name: 'Severity' });
    expect(within(severity).getByRole('button', { name: 'All (2)' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(severity).getByRole('button', { name: 'Info (0)' })).toBeInTheDocument();

    // A segment filters the list it counts, without another read.
    const reads = mockGetInsights.mock.calls.length;
    fireEvent.click(within(severity).getByRole('button', { name: 'Alerts (1)' }));
    expect(screen.getByText('Alert 1')).toBeInTheDocument();
    expect(screen.queryByText('Warning 1')).not.toBeInTheDocument();

    // The type filter narrows the counts the segments carry.
    fireEvent.change(screen.getByRole('combobox', { name: 'Type' }), { target: { value: 'trend' } });
    expect(within(severity).getByRole('button', { name: 'All (1)' })).toBeInTheDocument();
    expect(within(severity).getByRole('button', { name: 'Alerts (0)' })).toBeInTheDocument();
    await act(async () => {});
    expect(mockGetInsights.mock.calls.length).toBe(reads);
  });

  it('puts Refresh in the page header, with the age of the last generation', async () => {
    mockGetInsights.mockResolvedValue({
      insights: [],
      total: 0,
      lastGeneratedAt: new Date(Date.now() - 3 * 3600 * 1000).toISOString(),
      isGenerating: false,
    });
    await renderInsights();

    expect(screen.getByRole('heading', { name: 'Spending Insights' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Refresh Insights/ })).toHaveTextContent('(3 hours ago)');
  });

  it('calls generateInsights and polls for results when refresh button clicked', async () => {
    vi.useFakeTimers();

    mockGetInsights.mockResolvedValue({
      insights: [
        {
          id: 'i1',
          type: 'anomaly',
          title: 'Test',
          description: 'Desc',
          severity: 'info',
          data: {},
          isDismissed: false,
          generatedAt: '2026-02-18T00:00:00.000Z',
          expiresAt: '2026-02-25T00:00:00.000Z',
          createdAt: '2026-02-18T00:00:00.000Z',
        },
      ],
      total: 1,
      lastGeneratedAt: '2026-02-18T00:00:00.000Z',
      isGenerating: false,
    });
    mockGenerateInsights.mockResolvedValue(undefined);

    render(<InsightsList />);

    // Flush initial async load (useEffect -> loadInsights)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(screen.getByText('Refresh Insights')).toBeInTheDocument();

    // Set up poll response with updated lastGeneratedAt
    mockGetInsights.mockResolvedValue({
      insights: [
        {
          id: 'i2',
          type: 'trend',
          title: 'New Insight',
          description: 'New desc',
          severity: 'info',
          data: {},
          isDismissed: false,
          generatedAt: '2026-02-18T12:00:00.000Z',
          expiresAt: '2026-02-25T12:00:00.000Z',
          createdAt: '2026-02-18T12:00:00.000Z',
        },
      ],
      total: 1,
      lastGeneratedAt: '2026-02-18T12:00:00.000Z',
      isGenerating: false,
    });

    // Click refresh and flush microtasks so generateInsights resolves and polling starts
    await act(async () => {
      fireEvent.click(screen.getByText('Refresh Insights'));
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(mockGenerateInsights).toHaveBeenCalled();

    // Advance past the poll interval (POLL_INTERVAL = 5000ms)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5500);
    });

    expect(screen.getByText('New Insight')).toBeInTheDocument();

    vi.useRealTimers();
  });

  it('shows generating state when server reports isGenerating on load', async () => {
    // Server says generation is in progress — subsequent polls return completed
    mockGetInsights
      .mockResolvedValueOnce({
        insights: [],
        total: 0,
        lastGeneratedAt: null,
        isGenerating: true,
      })
      .mockResolvedValue({
        insights: [],
        total: 0,
        lastGeneratedAt: '2026-02-18T12:00:00.000Z',
        isGenerating: false,
      });

    await renderInsights();

    // The buttons show their progress after the initial load detects isGenerating
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Refresh Insights/ })).toBeDisabled();
    });
  });

  it('calls dismiss when dismiss button clicked', async () => {
    mockGetInsights.mockResolvedValue({
      insights: [
        {
          id: 'i1',
          type: 'anomaly',
          title: 'Test Insight',
          description: 'Desc',
          severity: 'info',
          data: {},
          isDismissed: false,
          generatedAt: '2026-02-18T00:00:00.000Z',
          expiresAt: '2026-02-25T00:00:00.000Z',
          createdAt: '2026-02-18T00:00:00.000Z',
        },
      ],
      total: 1,
      lastGeneratedAt: '2026-02-18T00:00:00.000Z',
      isGenerating: false,
    });
    mockDismissInsight.mockResolvedValue(undefined);

    await renderInsights();

    await waitFor(() => {
      expect(screen.getByText('Test Insight')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Dismiss'));

    await waitFor(() => {
      expect(mockDismissInsight).toHaveBeenCalledWith('i1');
    });
  });

  it('shows an error and keeps the insight when dismiss fails', async () => {
    mockGetInsights.mockResolvedValue({
      insights: [
        {
          id: 'i1',
          type: 'anomaly',
          title: 'Test Insight',
          description: 'Desc',
          severity: 'info',
          data: {},
          isDismissed: false,
          generatedAt: '2026-02-18T00:00:00.000Z',
          expiresAt: '2026-02-25T00:00:00.000Z',
          createdAt: '2026-02-18T00:00:00.000Z',
        },
      ],
      total: 1,
      lastGeneratedAt: '2026-02-18T00:00:00.000Z',
      isGenerating: false,
    });
    mockDismissInsight.mockRejectedValue(new Error('Request failed with status code 502'));

    await renderInsights();

    await waitFor(() => {
      expect(screen.getByText('Test Insight')).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByText('Dismiss'));
    });

    expect(
      screen.getByText('Failed to dismiss the insight. Please try again.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Test Insight')).toBeInTheDocument();
    expect(screen.getByText('Dismiss')).toBeInTheDocument();
  });

  it('shows error message on load failure', async () => {
    mockGetInsights.mockRejectedValue(new Error('Network error'));

    await renderInsights();

    await waitFor(() => {
      expect(
        screen.getByText('Failed to load insights. Please try again.'),
      ).toBeInTheDocument();
    });
  });

  it('shows error message on generate failure', async () => {
    mockGetInsights.mockResolvedValue({
      insights: [
        {
          id: 'i1',
          type: 'anomaly',
          title: 'Test',
          description: 'Desc',
          severity: 'info',
          data: {},
          isDismissed: false,
          generatedAt: '2026-02-18T00:00:00.000Z',
          expiresAt: '2026-02-25T00:00:00.000Z',
          createdAt: '2026-02-18T00:00:00.000Z',
        },
      ],
      total: 1,
      lastGeneratedAt: '2026-02-18T00:00:00.000Z',
      isGenerating: false,
    });
    mockGenerateInsights.mockRejectedValue(new Error('Provider error'));

    await renderInsights();

    await waitFor(() => {
      expect(screen.getByText('Refresh Insights')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Refresh Insights'));

    await waitFor(() => {
      expect(
        screen.getByText(
          'Failed to generate insights. Make sure you have an AI provider configured.',
        ),
      ).toBeInTheDocument();
    });
  });

  it('shows the relay connection status without blocking generation when the relay is active', async () => {
    mockGetStatus.mockResolvedValue({
      configured: true,
      relayActive: true,
    });

    await renderInsights();

    // Live tunnel status from the shared RelayStatusBar, polled via getRelayStatus.
    await waitFor(() => {
      expect(screen.getByText('MCP Agent listening')).toBeInTheDocument();
    });
    expect(mockGetRelayStatus).toHaveBeenCalled();
    // Generation stays available: it is served by the connected relay agent
    expect(screen.getByText('Refresh Insights')).not.toBeDisabled();
    expect(screen.getByText('Generate Insights')).toBeInTheDocument();
  });

  it('reveals the same connect help as the AI Assistant when the relay is active', async () => {
    mockGetStatus.mockResolvedValue({
      configured: true,
      relayActive: true,
    });

    await renderInsights();

    await waitFor(() => {
      expect(screen.getByText('How to connect')).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByText('How to connect'));
    });

    expect(
      screen.getByText(/claude mcp add --transport http monize/),
    ).toBeInTheDocument();
  });

  it('does not show the relay status bar for a native provider', async () => {
    await renderInsights();

    await waitFor(() => {
      expect(screen.getByText('Generate Insights')).toBeInTheDocument();
    });
    expect(screen.queryByText('How to connect')).not.toBeInTheDocument();
    expect(mockGetRelayStatus).not.toHaveBeenCalled();
  });

  it('passes filter parameters to API', async () => {
    await renderInsights();

    await waitFor(() => {
      // Type and severity filter on the client, so the segments can count.
      expect(mockGetInsights).toHaveBeenCalledWith({ includeDismissed: false });
    });
  });
});
