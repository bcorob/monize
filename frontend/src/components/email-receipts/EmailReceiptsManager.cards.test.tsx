import { describe, it, expect, vi, beforeEach } from 'vitest';
import toast from 'react-hot-toast';
import { render, screen, fireEvent, act, within } from '@/test/render';
import { EmailReceiptsManager } from './EmailReceiptsManager';
import { makeMailbox, makeReceipt } from './email-receipts-fixtures';

const api = vi.hoisted(() => ({
  list: vi.fn(),
  listDomains: vi.fn(),
  getStatusCounts: vi.fn(),
  overview: vi.fn(),
  approveProposal: vi.fn(),
  mailboxGet: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/email-receipts',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/lib/email-receipts-api', () => ({
  emailReceiptsApi: {
    receipts: {
      list: api.list,
      listDomains: api.listDomains,
      getStatusCounts: api.getStatusCounts,
      overview: api.overview,
      approveProposal: api.approveProposal,
    },
    mailbox: { get: api.mailboxGet },
    parsers: {},
  },
}));
vi.mock('@/hooks/useReceiptParserLookups', () => ({
  useReceiptParserLookups: () => ({ state: { status: 'loading' }, reload: vi.fn() }),
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

const tx = { id: 'tx-1', date: '2026-08-30', amount: -25, currencyCode: 'USD', payeeName: 'Allegro' };
const shop = (n: number, over: Record<string, unknown> = {}) =>
  makeReceipt({ id: `r-${n}`, subject: `Order ${n}`, status: 'no_parser', fromAddress: 'o@shop.example', fromDomain: 'shop.example', ...over });
const seven = [1, 2, 3, 4, 5, 6, 7].map((n) => shop(n));
const proposed = makeReceipt({ id: 'r-p', aiReviewRequestId: 'rq-1', subject: 'Order proposed', status: 'review', displayState: 'proposed', transaction: tx });
const applied = makeReceipt({ id: 'r-a', subject: 'Order applied', status: 'review', displayState: 'applied', transaction: tx });
const unmatched = makeReceipt({ id: 'r-u', subject: 'Order unmatched', status: 'unmatched' });

async function renderManager() {
  await act(async () => {
    render(<EmailReceiptsManager />);
  });
  await act(async () => {});
}
async function click(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element);
  });
  await act(async () => {});
}
const rowOf = (subject: string) => screen.getByRole('row', { name: new RegExp(subject) });
const inlineActions = (subject: string) =>
  within(rowOf(subject))
    .getAllByRole('button')
    .map((b) => b.getAttribute('aria-label') ?? b.textContent ?? '')
    .filter((name) => name !== 'More actions');
const selectAll = () => screen.getByRole('checkbox', { name: 'Select all emails on this list' }) as HTMLInputElement;

describe('EmailReceiptsManager: the cards', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.list.mockResolvedValue(seven);
    api.listDomains.mockResolvedValue([{ domain: 'shop.example', count: 7, processable: 7 }]);
    api.getStatusCounts.mockResolvedValue({ no_parser: 7, review: 2, unmatched: 1 });
    api.overview.mockResolvedValue({ processable: 7 });
    api.mailboxGet.mockResolvedValue(makeMailbox());
  });

  describe('the counts beside the states', () => {
    it('prints how many emails are in each state, and the total on "All"; a state with none reads 0', async () => {
      await renderManager();
      const group = screen.getByRole('group', { name: 'Filter by state' });
      expect(within(group).getAllByRole('button').map((b) => b.textContent)).toEqual([
        'All (10)',
        'Waiting to be read (0)',
        'Skipped (0)',
        'No profile (7)',
        'Could not be read (0)',
        'No transaction found (1)',
        'Several transactions fit (0)',
        'Another request is open (0)',
        'In review (2)',
        'Ignored (0)',
        'Waiting for repayment (0)',
      ]);
    });

    it('prints no number at all when the counts could not be read, never a zero', async () => {
      api.getStatusCounts.mockRejectedValue(new Error('down'));
      await renderManager();
      const group = screen.getByRole('group', { name: 'Filter by state' });
      expect(within(group).getByRole('button', { name: 'All' })).toBeInTheDocument();
      expect(within(group).getByRole('button', { name: 'In review' })).toBeInTheDocument();
    });

    it('reads the counts again after a command', async () => {
      api.list.mockResolvedValue([proposed]);
      api.approveProposal.mockResolvedValue(undefined);
      await renderManager();
      expect(api.getStatusCounts).toHaveBeenCalledTimes(1);
      await click(within(rowOf('Order proposed')).getByRole('button', { name: 'Approve' }));
      expect(api.getStatusCounts).toHaveBeenCalledTimes(2);
    });
  });

  describe('the select-all checkbox in the header', () => {
    it('has an accessible name, and ticks every email on the page, not only the first five', async () => {
      await renderManager();
      expect(selectAll()).not.toBeChecked();
      await click(selectAll());
      for (const n of [1, 2, 3, 4, 5, 6, 7]) expect(screen.getByRole('checkbox', { name: `Select Order ${n}` })).toBeChecked();
      expect(selectAll()).toBeChecked();
      expect(selectAll().indeterminate).toBe(false);
      expect(screen.getByRole('region', { name: 'Selected emails' })).toHaveTextContent('7 emails selected');
    });

    it('clears the selection when everything it covers is already ticked', async () => {
      await renderManager();
      await click(selectAll());
      await click(selectAll());
      expect(screen.queryByRole('region', { name: 'Selected emails' })).not.toBeInTheDocument();
      expect(selectAll()).not.toBeChecked();
    });

    it('is in the mixed state when only some are ticked', async () => {
      await renderManager();
      await click(screen.getByRole('checkbox', { name: 'Select Order 2' }));
      expect(selectAll().indeterminate).toBe(true);
      expect(selectAll()).toHaveAttribute('aria-checked', 'mixed');
      expect(selectAll()).not.toBeChecked();
      await click(selectAll());
      expect(selectAll().indeterminate).toBe(false);
      expect(selectAll()).toBeChecked();
    });

    it('ticks a skipped email too: it can be deleted, and ignoring it is reported as not possible', async () => {
      api.list.mockResolvedValue([shop(1), shop(2, { status: 'skipped' })]);
      await renderManager();
      await click(selectAll());
      expect(screen.getByRole('checkbox', { name: 'Select Order 1' })).toBeChecked();
      expect(screen.getByRole('checkbox', { name: 'Select Order 2' })).toBeChecked();
      expect(selectAll()).toBeChecked();
    });

    it('is on for a list of unreadable emails alone', async () => {
      api.list.mockResolvedValue([shop(1, { status: 'skipped' })]);
      await renderManager();
      expect(selectAll()).toBeEnabled();
    });
  });

  describe('the action that leads on each card', () => {
    it('leads with Approve for a proposal in review, which approves that email\'s proposal', async () => {
      api.list.mockResolvedValue([proposed]);
      api.approveProposal.mockResolvedValue(undefined);
      await renderManager();
      await click(screen.getByRole('button', { name: /^In review/ }));
      expect(inlineActions('Order proposed')[0]).toBe('Approve');
      await click(within(rowOf('Order proposed')).getByRole('button', { name: 'Approve' }));
      expect(api.approveProposal).toHaveBeenCalledWith('rq-1');
      expect(toast.success).toHaveBeenCalledWith('Proposal approved');
    });

    it('offers no Approve for a request that was applied, or for an email with nothing proposed', async () => {
      api.list.mockResolvedValue([applied, unmatched]);
      await renderManager();
      expect(within(rowOf('Order applied')).queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
      expect(within(rowOf('Order unmatched')).queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    });

    it('says so, and keeps the list, when the approval fails', async () => {
      api.list.mockResolvedValue([proposed]);
      api.approveProposal.mockRejectedValue(new Error('refused'));
      await renderManager();
      await click(within(rowOf('Order proposed')).getByRole('button', { name: 'Approve' }));
      expect(screen.getByRole('alert')).toHaveTextContent('refused');
      expect(rowOf('Order proposed')).toBeInTheDocument();
    });

    it('leads with the choice of a transaction on "No transaction found", and the AI profile on "No profile"', async () => {
      api.list.mockResolvedValue([unmatched]);
      await renderManager();
      await click(screen.getByRole('button', { name: /^No transaction found/ }));
      expect(inlineActions('Order unmatched')[0]).toBe('Choose transaction');
      api.list.mockResolvedValue([shop(1)]);
      await click(screen.getByRole('button', { name: /^No profile/ }));
      expect(inlineActions('Order 1')[0]).toBe('Prepare a profile with AI');
    });
  });
});
