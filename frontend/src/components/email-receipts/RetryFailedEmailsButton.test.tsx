import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@/test/render';
import { RetryFailedEmailsButton } from './RetryFailedEmailsButton';

const api = vi.hoisted(() => ({ processBatch: vi.fn() }));
vi.mock('@/lib/email-receipts-api', () => ({ emailReceiptsApi: { receipts: api } }));
vi.mock('@/lib/apiCache', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/apiCache')>()),
  clearAllCache: vi.fn(),
}));
vi.mock('@/lib/aiActionSignal', () => ({ notifyAiAction: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

async function click(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element);
  });
  await act(async () => {});
}

const answer = (over: Record<string, unknown> = {}) => ({
  processed: 3,
  byOutcome: { review: 2, unmatched: 1 },
  failed: 0,
  remaining: 0,
  since: 'T',
  ...over,
});

describe('RetryFailedEmailsButton', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('names how many emails could not be read', () => {
    render(<RetryFailedEmailsButton count={4} />);
    expect(screen.getByRole('button', { name: 'Retry failed emails (4)' })).toBeEnabled();
  });

  it('processes only the failed emails of the chosen sender, reports where they ended and tells the page', async () => {
    api.processBatch.mockResolvedValue(answer());
    const onFinished = vi.fn();
    render(<RetryFailedEmailsButton count={3} domain="shop.example.com" onFinished={onFinished} />);
    await click(screen.getByRole('button', { name: 'Retry failed emails (3)' }));
    expect(api.processBatch).toHaveBeenCalledWith({ domain: 'shop.example.com', statuses: ['parse_failed'] });
    expect(onFinished).toHaveBeenCalledTimes(1);
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('3 emails processed.');
    expect(status).toHaveTextContent('2 In review');
  });

  it('runs for every sender without a domain', async () => {
    api.processBatch.mockResolvedValue(answer());
    render(<RetryFailedEmailsButton count={3} />);
    await click(screen.getByRole('button', { name: 'Retry failed emails (3)' }));
    expect(api.processBatch).toHaveBeenCalledWith({ statuses: ['parse_failed'] });
  });

  it('shows progress with Cancel while it runs, and the button waits', async () => {
    let release!: (value: unknown) => void;
    api.processBatch.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
    render(<RetryFailedEmailsButton count={3} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry failed emails (3)' }));
    });
    expect(screen.getByRole('status')).toHaveTextContent('Starting...');
    expect(screen.getByRole('button', { name: /Retry failed emails/ })).toBeDisabled();
    await click(screen.getByRole('button', { name: 'Cancel' }));
    await act(async () => {
      release(answer({ remaining: 8 }));
    });
    expect(screen.getByRole('status')).toHaveTextContent('Cancelled after 3 emails.');
  });

  it('names the reason when a call fails and keeps what was done', async () => {
    api.processBatch.mockRejectedValue(Object.assign(new Error('x'), { response: { data: { message: 'Mailbox is busy' } } }));
    render(<RetryFailedEmailsButton count={3} />);
    await click(screen.getByRole('button', { name: 'Retry failed emails (3)' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Processing stopped: Mailbox is busy');
    await click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
