import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, within, fireEvent } from '@/test/render';
import { UncoveredDomainsSection } from './UncoveredDomainsSection';
import { TOUR_ANCHORS, tourAnchorSelector } from '@/lib/tours/anchors';

const api = vi.hoisted(() => ({ listUncovered: vi.fn() }));
vi.mock('@/lib/email-receipts-api', () => ({ emailReceiptsApi: { receipts: { listUncovered: api.listUncovered } } }));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

const entry = (domain: string, over: Record<string, unknown> = {}) => ({
  domain,
  count: 3,
  draftParserId: null,
  pendingRequestId: null,
  pendingRequestStatus: null,
  ...over,
});

async function renderSection() {
  await act(async () => {
    render(<UncoveredDomainsSection onSelect={vi.fn()} />);
  });
}

describe('UncoveredDomainsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('marks a domain whose request waits in the AI inbox with a "Waiting for AI" badge, and only that one', async () => {
    api.listUncovered.mockResolvedValue([
      entry('allegro.pl', { pendingRequestId: 'req-1', pendingRequestStatus: 'pending' }),
      entry('shop.example.com'),
    ]);
    await renderSection();
    const waiting = screen.getByRole('button', { name: /allegro\.pl/ });
    expect(within(waiting).getByText('Waiting for AI')).toBeInTheDocument();
    expect(within(screen.getByRole('button', { name: /shop\.example\.com/ })).queryByText('Waiting for AI')).not.toBeInTheDocument();
  });

  describe('the linked profiles hint', () => {
    const HINT = /The wizard below drafts a profile for one sender\. One bank transaction described by emails from several senders/;

    it('says the wizard drafts one sender and where linked profiles start, with a link that opens the Emails tab', async () => {
      api.listUncovered.mockResolvedValue([entry('allegro.pl')]);
      const onOpenEmails = vi.fn();
      await act(async () => {
        render(<UncoveredDomainsSection onSelect={vi.fn()} onOpenEmails={onOpenEmails} />);
      });
      expect(screen.getByText(HINT)).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Open the Emails tab' }));
      expect(onOpenEmails).toHaveBeenCalledTimes(1);
    });

    it('is shown while loading and draws no link without a tab switch', async () => {
      api.listUncovered.mockReturnValue(new Promise(() => {}));
      await renderSection();
      expect(screen.getByText(HINT)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Open the Emails tab' })).not.toBeInTheDocument();
    });
  });

  it('shows no badge when no request is waiting', async () => {
    api.listUncovered.mockResolvedValue([entry('allegro.pl')]);
    await renderSection();
    expect(screen.queryByText('Waiting for AI')).not.toBeInTheDocument();
  });

  describe('email receipts tour anchor', () => {
    const anchor = () => document.querySelector(tourAnchorSelector(TOUR_ANCHORS.emailReceiptsUncovered));

    it('is present when the block lists a domain', async () => {
      api.listUncovered.mockResolvedValue([entry('allegro.pl')]);
      await renderSection();
      expect(anchor()).toBeInTheDocument();
    });

    it('is absent while loading', async () => {
      api.listUncovered.mockReturnValue(new Promise(() => {}));
      await renderSection();
      expect(anchor()).not.toBeInTheDocument();
    });

    it('is absent when no domain is uncovered', async () => {
      api.listUncovered.mockResolvedValue([]);
      await renderSection();
      expect(anchor()).not.toBeInTheDocument();
    });

    it('is absent when the read failed', async () => {
      api.listUncovered.mockRejectedValue(new Error('boom'));
      await renderSection();
      expect(anchor()).not.toBeInTheDocument();
    });
  });
});
