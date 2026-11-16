import { describe, it, expect, vi, beforeEach } from 'vitest';
import toast from 'react-hot-toast';
import { render, screen, fireEvent, act, within } from '@/test/render';
import { EmailReceiptsManager } from './EmailReceiptsManager';
import { makeMailbox, makeReceipt } from './email-receipts-fixtures';

const api = vi.hoisted(() => ({
  list: vi.fn(),
  countMatching: vi.fn(),
  getStatusCounts: vi.fn(),
  listDomains: vi.fn(),
  bulk: vi.fn(),
  bulkCount: vi.fn(),
  bulkReprocess: vi.fn(),
  bulkApprovable: vi.fn(),
  approveRequests: vi.fn(),
  mailboxGet: vi.fn(),
}));
const nav = vi.hoisted(() => ({
  params: new URLSearchParams(),
  router: { push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn(), refresh: vi.fn() },
}));

vi.mock('next/navigation', () => ({
  useRouter: () => nav.router,
  usePathname: () => '/email-receipts',
  useSearchParams: () => nav.params,
}));
vi.mock('@/lib/email-receipts-api', () => ({
  emailReceiptsApi: {
    receipts: {
      list: api.list,
      countMatching: api.countMatching,
      getStatusCounts: api.getStatusCounts,
      listDomains: api.listDomains,
      bulk: api.bulk,
      bulkCount: api.bulkCount,
      bulkReprocess: api.bulkReprocess,
      bulkApprovable: api.bulkApprovable,
      approveRequests: api.approveRequests,
    },
    mailbox: { get: api.mailboxGet },
  },
}));
vi.mock('@/lib/assistant-ready', () => ({ assistantCanAnswerNow: vi.fn().mockResolvedValue(false) }));
vi.mock('@/hooks/useReceiptParserLookups', () => ({
  useReceiptParserLookups: () => ({ state: { status: 'loading' }, reload: vi.fn() }),
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

const mail = (n: number, over: Record<string, unknown> = {}) =>
  makeReceipt({
    id: `r-${n}`,
    subject: `Order ${n}`,
    status: 'no_parser',
    fromAddress: 'someone@gmail.com',
    fromDomain: 'gmail.com',
    ...over,
  });

// 1 ignored (August), 2 and 3 proposals (3 is a trade), 4 and 5 unread, 5 from another sender.
const page = [
  mail(1, { status: 'ignored', receivedAt: '2026-08-01T10:00:00.000Z' }),
  mail(2, { status: 'review', displayState: 'proposed', aiReviewRequestId: 'rq-2', receivedAt: '2026-09-02T10:00:00.000Z' }),
  mail(3, {
    status: 'review',
    displayState: 'proposed',
    aiReviewRequestId: 'rq-3',
    isTrade: true,
    receivedAt: '2026-09-03T10:00:00.000Z',
  }),
  mail(4, { receivedAt: '2026-09-20T10:00:00.000Z' }),
  mail(5, { fromAddress: 'a@shop.pl', fromDomain: 'shop.pl', receivedAt: '2026-10-01T10:00:00.000Z' }),
];
const step = (over: Record<string, unknown> = {}) => ({
  processed: 10,
  failed: 0,
  byOutcome: {},
  remaining: 0,
  since: '2026-10-16T10:00:00.000Z',
  ...over,
});

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

const selectAll = () => screen.getByRole('checkbox', { name: 'Select all emails on this list' });
const row = (n: number) => screen.getByRole('checkbox', { name: `Select Order ${n}` });
const bar = () => screen.getByRole('region', { name: 'Selected emails' });
const button = (name: string) => screen.getByRole('button', { name });
const dialog = () => screen.getByRole('dialog');
const deselect = async (item: string) => {
  await click(button('Deselect by'));
  await click(screen.getByRole('menuitem', { name: item }));
};
const selectEveryMatch = async () => {
  await click(selectAll());
  await click(button('Select all 1,234 matching this filter.'));
};

describe('EmailReceiptsManager: every action on a selection, and narrowing it', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    nav.params = new URLSearchParams();
    api.list.mockResolvedValue(page);
    api.countMatching.mockResolvedValue(1234);
    api.getStatusCounts.mockResolvedValue({ ignored: 300, review: 40, no_parser: 11 });
    api.listDomains.mockResolvedValue([
      { domain: 'gmail.com', count: 300 },
      { domain: 'shop.pl', count: 51 },
    ]);
    api.bulk.mockResolvedValue({ affected: 3, skippedLinked: 0, unchanged: 0, notIgnorable: 0 });
    api.bulkCount.mockResolvedValue(900);
    api.bulkReprocess.mockResolvedValue(step());
    api.bulkApprovable.mockResolvedValue({ requestIds: ['rq-a', 'rq-b'], trades: 3 });
    api.approveRequests.mockResolvedValue({ approved: 1, failed: 0 });
    api.mailboxGet.mockResolvedValue(makeMailbox());
  });

  describe('the commands in the bar', () => {
    it('counts Reprocess, Restore ignored and Approve proposals over the ticked rows, leaving trades out', async () => {
      await renderManager();
      await click(selectAll());

      expect(button('Reprocess (5)')).toBeEnabled();
      expect(button('Restore ignored (1)')).toBeEnabled();
      expect(button('Approve proposals (1)')).toBeEnabled();
      expect(button('Delete (5)')).toBeEnabled();
    });

    it('hides Restore ignored and Approve proposals when no ticked row can use them', async () => {
      await renderManager();
      await click(row(4));

      expect(button('Reprocess (1)')).toBeEnabled();
      expect(screen.queryByRole('button', { name: /Restore ignored/ })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Approve proposals/ })).not.toBeInTheDocument();
    });

    it('does not count a trade proposal as approvable', async () => {
      await renderManager();
      await click(row(3));
      expect(screen.queryByRole('button', { name: /Approve proposals/ })).not.toBeInTheDocument();
    });

    it('offers Restore ignored and Approve proposals without a count for every email matching, unless excluded', async () => {
      await renderManager();
      await selectEveryMatch();

      expect(button('Restore ignored')).toBeEnabled();
      expect(button('Approve proposals')).toBeEnabled();
      await deselect('State: Ignored');
      expect(screen.queryByRole('button', { name: /Restore ignored/ })).not.toBeInTheDocument();
    });

    it('offers neither for a state filter that cannot hold them', async () => {
      await renderManager();
      await click(screen.getByRole('button', { name: /^No profile/ }));
      await selectEveryMatch();
      expect(screen.queryByRole('button', { name: /Restore ignored/ })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Approve proposals/ })).not.toBeInTheDocument();
    });
  });

  describe('reprocess', () => {
    it('calls the server until nothing is left, carrying since, then tells, reloads and clears the selection', async () => {
      api.bulkReprocess
        .mockResolvedValueOnce(step({ remaining: 3, since: 'S1' }))
        .mockResolvedValueOnce(step({ processed: 3, remaining: 0, since: 'S1' }));
      await renderManager();
      const listCalls = api.list.mock.calls.length;
      await click(selectAll());
      await click(button('Reprocess (5)'));

      const ids = ['r-1', 'r-2', 'r-3', 'r-4', 'r-5'];
      expect(api.bulkReprocess).toHaveBeenCalledTimes(2);
      expect(api.bulkReprocess).toHaveBeenNthCalledWith(1, { ids });
      expect(api.bulkReprocess).toHaveBeenNthCalledWith(2, { ids, since: 'S1' });
      expect(toast.success).toHaveBeenCalledWith('13 emails reprocessed.');
      expect(api.list.mock.calls.length).toBe(listCalls + 1);
      expect(screen.queryByRole('region', { name: 'Selected emails' })).not.toBeInTheDocument();
    });

    it('shows how far it is and can be stopped between two calls', async () => {
      let release!: (value: unknown) => void;
      api.bulkReprocess
        .mockResolvedValueOnce(step({ remaining: 5, since: 'S1' }))
        .mockReturnValueOnce(new Promise((r) => (release = r)));
      await renderManager();
      await click(selectAll());
      await click(button('Reprocess (5)'));

      expect(bar()).toHaveTextContent('Processed 10, 5 left');
      expect(button('Reprocess (5)')).toBeDisabled();
      await click(button('Stop'));
      expect(button('Stop')).toBeDisabled();
      await act(async () => {
        release(step({ processed: 2, remaining: 3, since: 'S1' }));
      });
      await act(async () => {});

      expect(api.bulkReprocess).toHaveBeenCalledTimes(2);
      expect(toast).toHaveBeenCalledWith('12 emails reprocessed. Stopped. 3 emails were left unprocessed.');
      expect(screen.queryByText(/Processed 12/)).not.toBeInTheDocument();
    });

    it('does not loop forever when a call does nothing and emails remain', async () => {
      api.bulkReprocess.mockResolvedValue(step({ processed: 0, remaining: 4 }));
      await renderManager();
      await click(row(1));
      await click(button('Reprocess (1)'));
      expect(api.bulkReprocess).toHaveBeenCalledTimes(1);
    });

    it('names the failures and keeps the selection when the request fails', async () => {
      api.bulkReprocess.mockRejectedValueOnce({ response: { status: 400, data: { message: 'Narrow the selection.' } } });
      await renderManager();
      await click(selectAll());
      await click(button('Reprocess (5)'));

      expect(toast.error).toHaveBeenCalledWith('Narrow the selection.');
      expect(bar()).toHaveTextContent('5 emails selected');
    });

    it('sends the narrowed filter, not ids, for every email matching', async () => {
      await renderManager();
      await selectEveryMatch();
      await click(button('Reprocess (1,234)'));
      expect(api.bulkReprocess).toHaveBeenCalledWith({ filter: {} });
    });
  });

  describe('restore ignored', () => {
    it('reprocesses only the ignored emails of the selection', async () => {
      await renderManager();
      await click(selectAll());
      await click(button('Restore ignored (1)'));

      expect(api.bulkReprocess).toHaveBeenCalledWith({
        ids: ['r-1', 'r-2', 'r-3', 'r-4', 'r-5'],
        onlyStatuses: ['ignored'],
      });
      expect(toast.success).toHaveBeenCalledWith('10 ignored emails read again.');
    });

    it('sends the filter with onlyStatuses for every email matching', async () => {
      await renderManager();
      await selectEveryMatch();
      await click(button('Restore ignored'));
      expect(api.bulkReprocess).toHaveBeenCalledWith({ filter: {}, onlyStatuses: ['ignored'] });
    });
  });

  describe('approve proposals', () => {
    it('asks first, then approves the non-trade proposals of the ticked rows', async () => {
      await renderManager();
      await click(selectAll());
      await click(button('Approve proposals (1)'));

      expect(dialog()).toHaveTextContent('Approve 1 proposal?');
      expect(dialog()).toHaveTextContent('1 trade email is left out');
      expect(api.approveRequests).not.toHaveBeenCalled();

      await click(within(dialog()).getByRole('button', { name: 'Approve' }));
      expect(api.approveRequests).toHaveBeenCalledWith(['rq-2']);
      expect(toast.success).toHaveBeenCalledWith('1 proposal approved.');
      expect(screen.queryByRole('region', { name: 'Selected emails' })).not.toBeInTheDocument();
    });

    it('sends nothing when the dialog is cancelled', async () => {
      await renderManager();
      await click(selectAll());
      await click(button('Approve proposals (1)'));
      await click(within(dialog()).getByRole('button', { name: 'Cancel' }));
      expect(api.approveRequests).not.toHaveBeenCalled();
      expect(bar()).toHaveTextContent('5 emails selected');
    });

    it('asks the server which proposals every email matching holds, and says how many trades it left out', async () => {
      await renderManager();
      await selectEveryMatch();
      await click(button('Approve proposals'));

      expect(api.bulkApprovable).toHaveBeenCalledWith({ filter: {} });
      expect(dialog()).toHaveTextContent('Approve 2 proposals?');
      expect(dialog()).toHaveTextContent('3 trade emails are left out');
      await click(within(dialog()).getByRole('button', { name: 'Approve' }));
      expect(api.approveRequests).toHaveBeenCalledWith(['rq-a', 'rq-b']);
    });

    it('says so when nothing can be approved', async () => {
      api.bulkApprovable.mockResolvedValue({ requestIds: [], trades: 2 });
      await renderManager();
      await selectEveryMatch();
      await click(button('Approve proposals'));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(toast).toHaveBeenCalledWith('No proposals in this selection can be approved.');
    });

    it('reports the proposals that failed', async () => {
      api.approveRequests.mockResolvedValue({ approved: 1, failed: 2 });
      await renderManager();
      await click(selectAll());
      await click(button('Approve proposals (1)'));
      await click(within(dialog()).getByRole('button', { name: 'Approve' }));
      expect(toast).toHaveBeenCalledWith('1 proposal approved. 2 proposals could not be approved.');
    });
  });

  describe('deselect by, ticked rows', () => {
    it('drops the ticked rows of a state', async () => {
      await renderManager();
      await click(selectAll());
      await deselect('State: Ignored');
      expect(bar()).toHaveTextContent('4 emails selected');
      expect(row(1)).not.toBeChecked();
      expect(row(2)).toBeChecked();
    });

    it('offers only the states and senders the ticked rows hold', async () => {
      await renderManager();
      await click(row(4));
      await click(button('Deselect by'));
      expect(screen.getByRole('menuitem', { name: 'State: No profile' })).toBeInTheDocument();
      expect(screen.getByRole('menuitem', { name: 'Sender: gmail.com' })).toBeInTheDocument();
      expect(screen.queryByRole('menuitem', { name: 'State: Ignored' })).not.toBeInTheDocument();
      expect(screen.queryByRole('menuitem', { name: 'Sender: shop.pl' })).not.toBeInTheDocument();
    });

    it('drops the ticked rows of a sender', async () => {
      await renderManager();
      await click(selectAll());
      await deselect('Sender: shop.pl');
      expect(bar()).toHaveTextContent('4 emails selected');
      expect(row(5)).not.toBeChecked();
    });

    it('drops the ticked rows received before a day', async () => {
      await renderManager();
      await click(selectAll());
      await deselect('Received before a day');
      await act(async () => {
        fireEvent.change(screen.getByLabelText('Deselect emails received before'), { target: { value: '09/03/2026' } });
      });
      await click(button('Deselect'));
      // Order 1 (Aug 1) and Order 2 (Sep 2) are before Sep 3; Order 3 (Sep 3) stays.
      expect(bar()).toHaveTextContent('3 emails selected');
      expect(row(1)).not.toBeChecked();
      expect(row(2)).not.toBeChecked();
      expect(row(3)).toBeChecked();
    });

    it('drops the ticked rows received after a day', async () => {
      await renderManager();
      await click(selectAll());
      await deselect('Received after a day');
      await act(async () => {
        fireEvent.change(screen.getByLabelText('Deselect emails received after'), { target: { value: '09/03/2026' } });
      });
      await click(button('Deselect'));
      expect(bar()).toHaveTextContent('3 emails selected');
      expect(row(3)).toBeChecked();
      expect(row(4)).not.toBeChecked();
      expect(row(5)).not.toBeChecked();
    });
  });

  describe('deselect by, every email matching', () => {
    it('adds the state to the filter, shows the count the server gives and sends the narrowed filter', async () => {
      await renderManager();
      await selectEveryMatch();
      await deselect('State: Ignored');

      expect(api.bulkCount).toHaveBeenCalledWith({ excludeStatuses: ['ignored'] });
      expect(bar()).toHaveTextContent('900 emails selected');
      expect(button('Put back: Not in state Ignored')).toBeInTheDocument();

      await click(button('Delete (900)'));
      expect(dialog()).toHaveTextContent('Delete 900 emails?');
      expect(dialog()).toHaveTextContent('Emails taken out of the selection are not touched.');
      await click(within(dialog()).getByRole('button', { name: 'Delete' }));
      expect(api.bulk).toHaveBeenCalledWith({
        action: 'delete',
        expectedCount: 900,
        filter: { excludeStatuses: ['ignored'] },
      });
    });

    it('adds a sender and the days, and every command carries them', async () => {
      await renderManager();
      await selectEveryMatch();
      await deselect('Sender: shop.pl');
      await deselect('Received before a day');
      await act(async () => {
        fireEvent.change(screen.getByLabelText('Deselect emails received before'), { target: { value: '09/01/2026' } });
      });
      await click(button('Deselect'));
      await deselect('Received after a day');
      await act(async () => {
        fireEvent.change(screen.getByLabelText('Deselect emails received after'), { target: { value: '10/01/2026' } });
      });
      await click(button('Deselect'));

      const narrowed = { excludeDomains: ['shop.pl'], receivedFrom: '2026-09-01', receivedTo: '2026-10-01' };
      expect(api.bulkCount).toHaveBeenLastCalledWith(narrowed);
      await click(button('Reprocess (900)'));
      expect(api.bulkReprocess).toHaveBeenCalledWith({ filter: narrowed });
    });

    it('keeps the state and sender of the list in the filter', async () => {
      nav.params = new URLSearchParams('domain=gmail.com');
      await renderManager();
      await selectEveryMatch();
      await deselect('Received after a day');
      await act(async () => {
        fireEvent.change(screen.getByLabelText('Deselect emails received after'), { target: { value: '10/01/2026' } });
      });
      await click(button('Deselect'));
      expect(api.bulkCount).toHaveBeenCalledWith({ domain: 'gmail.com', receivedTo: '2026-10-01' });
    });

    it('puts a removed chip back and counts again; no chip left is no narrowing', async () => {
      await renderManager();
      await selectEveryMatch();
      await deselect('State: Ignored');
      api.bulkCount.mockClear();
      await click(button('Put back: Not in state Ignored'));

      expect(api.bulkCount).not.toHaveBeenCalled();
      expect(bar()).toHaveTextContent('1,234 emails selected');
      expect(screen.queryByRole('button', { name: /Put back/ })).not.toBeInTheDocument();
    });

    it('undoes the change and says so when the count fails', async () => {
      api.bulkCount.mockRejectedValueOnce(new Error('down'));
      await renderManager();
      await selectEveryMatch();
      await deselect('State: Ignored');

      expect(toast.error).toHaveBeenCalledWith('Could not count the emails. The change was not applied.');
      expect(screen.queryByRole('button', { name: /Put back/ })).not.toBeInTheDocument();
      expect(bar()).toHaveTextContent('1,234 emails selected');
    });

    it('ends the selection when nothing is left', async () => {
      api.bulkCount.mockResolvedValue(0);
      await renderManager();
      await selectEveryMatch();
      await deselect('State: Ignored');
      expect(toast).toHaveBeenCalledWith('No emails match any more. Nothing was changed.');
      expect(screen.queryByRole('region', { name: 'Selected emails' })).not.toBeInTheDocument();
    });

    it('forgets the exclusions when the selection is cleared', async () => {
      await renderManager();
      await selectEveryMatch();
      await deselect('State: Ignored');
      await click(button('Clear selection'));
      await selectEveryMatch();
      expect(screen.queryByRole('button', { name: /Put back/ })).not.toBeInTheDocument();
      await click(button('Delete (1,234)'));
      await click(within(dialog()).getByRole('button', { name: 'Delete' }));
      expect(api.bulk).toHaveBeenCalledWith({ action: 'delete', expectedCount: 1234, filter: {} });
    });
  });
});
