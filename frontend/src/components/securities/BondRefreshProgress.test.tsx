import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@/test/render';
import { BondRefreshProgress } from './BondRefreshProgress';

const mockGetProgress = vi.fn();

vi.mock('@/lib/investments', () => ({
  investmentsApi: {
    getBondRefreshProgress: (...args: unknown[]) => mockGetProgress(...args),
  },
}));

const NOW = new Date('2026-10-11T12:00:00.000Z');

const progress = (over: Record<string, unknown>) => ({
  startedAt: NOW.toISOString(),
  phase: 'series',
  done: 0,
  total: 0,
  seriesCode: null,
  finishedAt: null,
  ...over,
});

describe('BondRefreshProgress', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    mockGetProgress.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const show = async (payload: unknown | null) => {
    if (payload) mockGetProgress.mockResolvedValue(payload);
    render(<BondRefreshProgress programId="prog-1" active />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
  };

  it('renders nothing when inactive', () => {
    render(<BondRefreshProgress programId="prog-1" active={false} />);
    expect(screen.queryByText('Starting…')).not.toBeInTheDocument();
  });

  it('shows an indeterminate bar and "Starting…" before anything is received', async () => {
    await show(null);
    expect(screen.getByText('Starting…')).toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(screen.getByText('Starting…').parentElement).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByText('Starting…')).toHaveAttribute('aria-live', 'polite');
  });

  it('shows an indeterminate bar while the offer is checked', async () => {
    await show(progress({ phase: 'offer' }));
    expect(screen.getByText('Checking the current offer…')).toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('shows done of total and the series code in the series phase', async () => {
    await show(progress({ done: 3, total: 8, seriesCode: 'EDO0136' }));
    expect(screen.getByText('Fetching series 3 of 8: EDO0136')).toBeInTheDocument();
    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '3');
    expect(bar).toHaveAttribute('aria-valuemin', '0');
    expect(bar).toHaveAttribute('aria-valuemax', '8');
  });

  it('says the history is complete when the series phase has nothing to fetch', async () => {
    await show(progress({ done: 0, total: 0 }));
    expect(screen.getByText('History is complete')).toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });
});
