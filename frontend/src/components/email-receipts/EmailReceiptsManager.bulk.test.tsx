import { describe, it, expect, vi, beforeEach } from 'vitest';
import toast from 'react-hot-toast';
import { render, screen, fireEvent, act, within } from '@/test/render';
import { EmailReceiptsManager } from './EmailReceiptsManager';
import { makeMailbox, makeReceipt } from './email-receipts-fixtures';

const api = vi.hoisted(() => ({
  list: vi.fn(),
  countMatching: vi.fn(),
  bulk: vi.fn(),
  mailboxGet: vi.fn(),
  draftWithAi: vi.fn(),
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
    receipts: { list: api.list, countMatching: api.countMatching, bulk: api.bulk },
    mailbox: { get: api.mailboxGet },
    parsers: { draftWithAi: api.draftWithAi },
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

const page = [1, 2, 3].map((n) => mail(n));
const RESULT = { affected: 3, skippedLinked: 0, unchanged: 0, notIgnorable: 0 };

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
const bar = () => screen.queryByRole('region', { name: 'Selected emails' });
const button = (name: string) => screen.getByRole('button', { name });
const dialog = () => screen.getByRole('dialog');
const conflict = (currentCount: number) => ({
  response: { status: 409, data: { message: 'changed', errorCode: 'EMAIL_RECEIPTS_BULK_COUNT_CHANGED', currentCount } },
});

describe('EmailReceiptsManager: bulk delete and ignore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    nav.params = new URLSearchParams('domain=gmail.com');
    api.list.mockResolvedValue(page);
    api.countMatching.mockResolvedValue(1234);
    api.bulk.mockResolvedValue(RESULT);
    api.mailboxGet.mockResolvedValue(makeMailbox());
  });

  describe('selecting emails', () => {
    it('reads the number matching the filter from the server for the filter on screen', async () => {
      await renderManager();
      expect(api.countMatching).toHaveBeenCalledWith(undefined, 'gmail.com');
    });

    it('selects any number of rows, and offers Delete, Ignore and the draft button', async () => {
      api.list.mockResolvedValue([1, 2, 3, 4, 5, 6, 7, 8].map((n) => mail(n)));
      await renderManager();
      await click(selectAll());

      expect(bar()).toHaveTextContent('8 emails selected');
      expect(button('Delete (8)')).toBeEnabled();
      expect(button('Ignore (8)')).toBeEnabled();
      expect(button('Prepare a profile with AI (8)')).toBeDisabled();
    });

    it('enables the draft button for one to five emails of one sender', async () => {
      await renderManager();
      await click(row(1));
      expect(button('Prepare a profile with AI (1)')).toBeEnabled();
      await click(row(2));
      await click(row(3));
      expect(button('Prepare a profile with AI (3)')).toBeEnabled();
    });
  });

  describe('select all matching the filter', () => {
    it('offers it when the page is fully selected and more emails match', async () => {
      await renderManager();
      await click(row(1));
      expect(screen.queryByText(/Select all 1,234 matching/)).not.toBeInTheDocument();
      await click(selectAll());

      expect(bar()).toHaveTextContent('All 3 on this page are selected.');
      expect(button('Select all 1,234 matching this filter.')).toBeInTheDocument();
    });

    it('does not offer it when the page already holds every matching email', async () => {
      api.countMatching.mockResolvedValue(3);
      await renderManager();
      await click(selectAll());
      expect(screen.queryByText(/matching this filter/)).not.toBeInTheDocument();
    });

    it('does not offer it when the number could not be read, and never invents one', async () => {
      api.countMatching.mockRejectedValue(new Error('down'));
      await renderManager();
      await click(selectAll());
      expect(bar()).toBeInTheDocument();
      expect(screen.queryByText(/matching this filter/)).not.toBeInTheDocument();
    });

    it('selects them all, says so and keeps the Clear selection button', async () => {
      await renderManager();
      await click(selectAll());
      await click(button('Select all 1,234 matching this filter.'));

      expect(bar()).toHaveTextContent('1,234 emails selected');
      expect(bar()).toHaveTextContent('All 1,234 emails matching this filter are selected.');
      expect(screen.queryByText(/Select all 1,234 matching/)).not.toBeInTheDocument();
      expect(button('Delete (1,234)')).toBeEnabled();
      // A profile is drafted from emails ticked one by one, never from a filter.
      expect(button('Prepare a profile with AI (1,234)')).toBeDisabled();
      expect(within(bar() as HTMLElement).getByText(/at most 5/)).toBeInTheDocument();
      await click(button('Clear selection'));
      expect(bar()).not.toBeInTheDocument();
      expect(row(1)).not.toBeChecked();
    });

    it('goes back to the ticked rows when one row is unticked', async () => {
      await renderManager();
      await click(selectAll());
      await click(button('Select all 1,234 matching this filter.'));
      await click(row(2));

      expect(bar()).toHaveTextContent('2 emails selected');
      expect(bar()).not.toHaveTextContent('matching this filter are selected');
      await click(button('Delete (2)'));
      expect(dialog()).toHaveTextContent('Delete 2 emails?');
    });

    it('is cleared when the state filter changes', async () => {
      await renderManager();
      await click(selectAll());
      await click(button('Select all 1,234 matching this filter.'));
      await click(button('No profile'));
      expect(bar()).not.toBeInTheDocument();
    });

    it('sends the filter, not ids, with the count it was told', async () => {
      await renderManager();
      await click(selectAll());
      await click(button('Select all 1,234 matching this filter.'));
      await click(button('Delete (1,234)'));
      await click(within(dialog()).getByRole('button', { name: 'Delete' }));

      expect(api.bulk).toHaveBeenCalledTimes(1);
      expect(api.bulk).toHaveBeenCalledWith({
        action: 'delete',
        expectedCount: 1234,
        filter: { domain: 'gmail.com' },
      });
    });

    it('sends the state as well when a state is chosen', async () => {
      await renderManager();
      await click(button('No profile'));
      await click(selectAll());
      await click(button('Select all 1,234 matching this filter.'));
      await click(button('Ignore (1,234)'));
      await click(within(dialog()).getByRole('button', { name: 'Ignore' }));

      expect(api.countMatching).toHaveBeenCalledWith('no_parser', 'gmail.com');
      expect(api.bulk).toHaveBeenCalledWith({
        action: 'ignore',
        expectedCount: 1234,
        filter: { status: 'no_parser', domain: 'gmail.com' },
      });
    });
  });

  describe('the confirmation', () => {
    it('states the count and the filter, says a delete cannot be undone and points to Ignore', async () => {
      await renderManager();
      await click(selectAll());
      await click(button('Select all 1,234 matching this filter.'));
      await click(button('Delete (1,234)'));

      expect(dialog()).toHaveTextContent('Delete 1,234 emails from gmail.com?');
      expect(dialog()).toHaveTextContent('This cannot be undone.');
      expect(dialog()).toHaveTextContent('choose Ignore instead');
      expect(dialog()).toHaveTextContent('linked to a transaction are kept');
      expect(api.bulk).not.toHaveBeenCalled();
    });

    it('has an ignore variant', async () => {
      await renderManager();
      await click(selectAll());
      await click(button('Select all 1,234 matching this filter.'));
      await click(button('Ignore (1,234)'));

      expect(dialog()).toHaveTextContent('Ignore 1,234 emails from gmail.com?');
      expect(dialog()).not.toHaveTextContent('cannot be undone');
    });

    it('names no domain for emails ticked one by one when no filter is on', async () => {
      nav.params = new URLSearchParams();
      await renderManager();
      await click(row(1));
      await click(button('Delete (1)'));
      expect(dialog()).toHaveTextContent('Delete 1 email?');
    });

    it('sends nothing when it is cancelled, and keeps the selection', async () => {
      await renderManager();
      await click(selectAll());
      await click(button('Delete (3)'));
      await click(within(dialog()).getByRole('button', { name: 'Cancel' }));

      expect(api.bulk).not.toHaveBeenCalled();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(bar()).toHaveTextContent('3 emails selected');
    });

    it('sends the ticked ids with their count', async () => {
      await renderManager();
      await click(row(1));
      await click(row(3));
      await click(button('Delete (2)'));
      await click(within(dialog()).getByRole('button', { name: 'Delete' }));

      expect(api.bulk).toHaveBeenCalledWith({ action: 'delete', expectedCount: 2, ids: ['r-1', 'r-3'] });
    });
  });

  describe('after the server answers', () => {
    it('clears the selection, reads the list and the counts again and tells what was deleted', async () => {
      await renderManager();
      const listCalls = api.list.mock.calls.length;
      const countCalls = api.countMatching.mock.calls.length;
      await click(selectAll());
      await click(button('Delete (3)'));
      await click(within(dialog()).getByRole('button', { name: 'Delete' }));

      expect(bar()).not.toBeInTheDocument();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(api.list.mock.calls.length).toBe(listCalls + 1);
      expect(api.countMatching.mock.calls.length).toBe(countCalls + 1);
      expect(toast.success).toHaveBeenCalledWith('3 emails deleted.');
    });

    it('reports the emails it left alone', async () => {
      api.bulk.mockResolvedValue({ affected: 2, skippedLinked: 4, unchanged: 1, notIgnorable: 3 });
      await renderManager();
      await click(selectAll());
      await click(button('Ignore (3)'));
      await click(within(dialog()).getByRole('button', { name: 'Ignore' }));

      expect(toast.success).toHaveBeenCalledWith(
        '2 emails ignored. 1 email was already ignored. 3 emails could not be ignored: they could not be read, or their proposals were already applied. 4 emails linked to a transaction were kept.',
      );
    });

    it('is not a success when nothing changed', async () => {
      api.bulk.mockResolvedValue({ affected: 0, skippedLinked: 3, unchanged: 0, notIgnorable: 0 });
      await renderManager();
      await click(selectAll());
      await click(button('Delete (3)'));
      await click(within(dialog()).getByRole('button', { name: 'Delete' }));

      expect(toast.success).not.toHaveBeenCalled();
      expect(toast).toHaveBeenCalledWith('0 emails deleted. 3 emails linked to a transaction were kept.');
    });

    it('waits while the request runs: the dialog cannot be pressed twice', async () => {
      let resolve!: (value: unknown) => void;
      api.bulk.mockReturnValueOnce(new Promise((r) => (resolve = r)));
      await renderManager();
      await click(selectAll());
      await click(button('Delete (3)'));
      await act(async () => {
        fireEvent.click(within(dialog()).getByRole('button', { name: 'Delete' }));
      });
      expect(within(dialog()).getByRole('button', { name: 'Cancel' })).toBeDisabled();
      expect(button('Delete (3)')).toBeDisabled();
      await act(async () => {
        resolve(RESULT);
      });
      expect(api.bulk).toHaveBeenCalledTimes(1);
    });
  });

  describe('when the number changed (409)', () => {
    it('keeps the dialog open with the new number, writes nothing more and asks again', async () => {
      api.bulk.mockRejectedValueOnce(conflict(1200));
      await renderManager();
      await click(selectAll());
      await click(button('Select all 1,234 matching this filter.'));
      await click(button('Delete (1,234)'));
      await click(within(dialog()).getByRole('button', { name: 'Delete' }));

      expect(within(dialog()).getByRole('alert')).toHaveTextContent('The number of matching emails is now 1,200. Nothing was changed.');
      expect(dialog()).toHaveTextContent('Delete 1,200 emails from gmail.com?');
      expect(toast.error).not.toHaveBeenCalled();
      expect(api.bulk).toHaveBeenCalledTimes(1);
      // The page's own numbers are read again, too.
      expect(api.countMatching.mock.calls.length).toBeGreaterThan(1);

      await click(within(dialog()).getByRole('button', { name: 'Delete' }));
      expect(api.bulk).toHaveBeenLastCalledWith({ action: 'delete', expectedCount: 1200, filter: { domain: 'gmail.com' } });
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('closes and says so when no email matches any more', async () => {
      api.bulk.mockRejectedValueOnce(conflict(0));
      await renderManager();
      await click(selectAll());
      await click(button('Delete (3)'));
      await click(within(dialog()).getByRole('button', { name: 'Delete' }));

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(toast).toHaveBeenCalledWith('No emails match any more. Nothing was changed.');
      expect(bar()).not.toBeInTheDocument();
    });

    it('treats a 409 without a count as a failure, not as a new number', async () => {
      api.bulk.mockRejectedValueOnce({ response: { status: 409, data: { message: 'Busy' } } });
      await renderManager();
      await click(selectAll());
      await click(button('Delete (3)'));
      await click(within(dialog()).getByRole('button', { name: 'Delete' }));

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(toast.error).toHaveBeenCalledWith('Busy');
    });
  });

  describe('when the request fails', () => {
    it("shows the server's reason, closes the dialog and keeps the selection", async () => {
      api.bulk.mockRejectedValueOnce({ response: { status: 400, data: { message: 'More than 20000 emails match.' } } });
      await renderManager();
      await click(selectAll());
      await click(button('Delete (3)'));
      await click(within(dialog()).getByRole('button', { name: 'Delete' }));

      expect(toast.error).toHaveBeenCalledWith('More than 20000 emails match.');
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(bar()).toHaveTextContent('3 emails selected');
    });

    it('names a failure that carries no message', async () => {
      api.bulk.mockRejectedValueOnce({ response: { status: 500, data: {} } });
      await renderManager();
      await click(selectAll());
      await click(button('Ignore (3)'));
      await click(within(dialog()).getByRole('button', { name: 'Ignore' }));
      expect(toast.error).toHaveBeenCalledWith('Could not ignore the emails');
    });
  });
});
