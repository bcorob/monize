import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, within } from '@/test/render';
import { EmailReceiptsManager } from './EmailReceiptsManager';
import { makeMailbox, makeReceipt } from './email-receipts-fixtures';
import { RECEIPT_SEARCH_DEBOUNCE_MS } from './useReceiptSearch';

const api = vi.hoisted(() => ({
  list: vi.fn(),
  countMatching: vi.fn(),
  listDomains: vi.fn(),
  getStatusCounts: vi.fn(),
  bulk: vi.fn(),
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
      listDomains: api.listDomains,
      getStatusCounts: api.getStatusCounts,
      bulk: api.bulk,
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

const mail = (n: number, subject = `Order ${n}`) =>
  makeReceipt({ id: `r-${n}`, subject, status: 'no_parser', fromAddress: 'a@shop.example', fromDomain: 'shop.example' });
const mails = (first: number, count: number) => Array.from({ length: count }, (_, i) => mail(first + i));

/** A promise the test settles by hand. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

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
/** Type into the search box and let the text rest past the delay. */
async function typeSearch(text: string) {
  await act(async () => {
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search by subject, sender or content...' }), { target: { value: text } });
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, RECEIPT_SEARCH_DEBOUNCE_MS + 50));
  });
  await act(async () => {});
}

const lastList = () => api.list.mock.calls[api.list.mock.calls.length - 1];
const selectAll = () => screen.getByRole('checkbox', { name: 'Select all emails on this list' });
const bar = () => screen.queryByRole('region', { name: 'Selected emails' });
const button = (name: string) => screen.getByRole('button', { name });

describe('EmailReceiptsManager: search', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    nav.params = new URLSearchParams();
    api.list.mockResolvedValue(mails(1, 3));
    api.countMatching.mockResolvedValue(3);
    api.listDomains.mockResolvedValue([]);
    api.getStatusCounts.mockResolvedValue({ no_parser: 3 });
    api.bulk.mockResolvedValue({ affected: 3, skippedLinked: 0, unchanged: 0, notIgnorable: 0 });
    api.mailboxGet.mockResolvedValue(makeMailbox());
  });

  it('sends no search argument until there is a search', async () => {
    await renderManager();
    expect(lastList()).toEqual([undefined, undefined, undefined, 0]);
    expect(api.getStatusCounts).toHaveBeenLastCalledWith();
    expect(api.listDomains).toHaveBeenLastCalledWith();
    expect(screen.getByRole('search', { name: 'Search emails' })).toBeInTheDocument();
  });

  it('puts the search first in the toolbar, before the state filter', async () => {
    await renderManager();
    const search = screen.getByRole('search', { name: 'Search emails' });
    const states = screen.getByRole('group', { name: 'Filter by state' });
    expect(search.compareDocumentPosition(states) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('sends the text to the list, the counts, the matching total and the domains once it has rested', async () => {
    await renderManager();
    await act(async () => {
      fireEvent.change(screen.getByRole('searchbox', { name: 'Search by subject, sender or content...' }), { target: { value: 'invoice' } });
    });
    // Not yet: the text has not rested.
    expect(lastList()).toEqual([undefined, undefined, undefined, 0]);
    await typeSearch('invoice');
    expect(lastList()).toEqual([undefined, undefined, undefined, 0, { search: 'invoice' }]);
    expect(api.countMatching).toHaveBeenLastCalledWith(undefined, undefined, { search: 'invoice' });
    expect(api.getStatusCounts).toHaveBeenLastCalledWith({ search: 'invoice' });
    expect(api.listDomains).toHaveBeenLastCalledWith(undefined, { search: 'invoice' });
    expect(nav.router.replace).toHaveBeenLastCalledWith('/email-receipts?q=invoice&tab=emails', { scroll: false });
  });

  it('sends the field with the text, and the state beside the search', async () => {
    await renderManager();
    await click(button('No profile (3)'));
    await act(async () => {
      fireEvent.change(screen.getByRole('combobox', { name: 'Search in' }), { target: { value: 'body' } });
    });
    await typeSearch('refund');
    expect(lastList()).toEqual(['no_parser', undefined, undefined, 0, { search: 'refund', searchIn: 'body' }]);
    expect(api.listDomains).toHaveBeenLastCalledWith('no_parser', { search: 'refund', searchIn: 'body' });
  });

  it('starts from the URL, dates included', async () => {
    nav.params = new URLSearchParams('q=hello&in=sender&from=2026-09-01&to=2026-09-30');
    await renderManager();
    expect(lastList()).toEqual([
      undefined,
      undefined,
      undefined,
      0,
      { search: 'hello', searchIn: 'sender', dateFrom: '2026-09-01', dateTo: '2026-09-30' },
    ]);
    expect(screen.getByRole('searchbox', { name: 'Search by subject, sender or content...' })).toHaveValue('hello');
    expect(nav.router.replace).not.toHaveBeenCalled();
  });

  it('returns to the first page when the search changes', async () => {
    api.list.mockImplementation(async (_s?: string, _l?: number, _d?: string, offset = 0) =>
      mails(offset + 1, Math.max(0, Math.min(50, 120 - offset))),
    );
    api.countMatching.mockResolvedValue(120);
    await renderManager();
    await click(screen.getByTitle('Next page'));
    expect(lastList()[3]).toBe(50);
    await typeSearch('order');
    expect(lastList()).toEqual([undefined, undefined, undefined, 0, { search: 'order' }]);
    expect(document.body.textContent).toContain('Showing 1 - 50 of 120 emails');
  });

  it('drops the selection when the search changes, as a new domain does', async () => {
    await renderManager();
    await click(selectAll());
    expect(bar()).toBeInTheDocument();
    await typeSearch('order');
    expect(bar()).not.toBeInTheDocument();
  });

  it('never draws the answer for a search the reader has left', async () => {
    const first = deferred<ReturnType<typeof mails>>();
    const second = deferred<ReturnType<typeof mails>>();
    await renderManager();
    api.list.mockImplementation((_s?: string, _l?: number, _d?: string, _o?: number, search?: { search?: string }) =>
      search?.search === 'alpha' ? first.promise : second.promise,
    );
    await typeSearch('alpha');
    // The previous list is not on screen, so no action can be aimed at one of its rows.
    expect(screen.queryByText('Order 1')).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'Select Order 1' })).not.toBeInTheDocument();
    await typeSearch('beta');
    // B answers first, A answers late.
    await act(async () => {
      second.resolve([mail(20, 'Beta result')]);
    });
    await act(async () => {
      first.resolve([mail(10, 'Alpha result')]);
    });
    expect(screen.getByText('Beta result')).toBeInTheDocument();
    expect(screen.queryByText('Alpha result')).not.toBeInTheDocument();
  });

  it('does not show the counts of another search under the new one', async () => {
    const counts = deferred<Record<string, number>>();
    await renderManager();
    expect(screen.getByRole('button', { name: 'No profile (3)' })).toBeInTheDocument();
    api.getStatusCounts.mockImplementation(() => counts.promise);
    await typeSearch('beta');
    // The old numbers are not these emails' numbers: no number until the new ones arrive.
    expect(screen.getByRole('button', { name: 'No profile' })).toBeInTheDocument();
    await act(async () => {
      counts.resolve({ no_parser: 1 });
    });
    expect(screen.getByRole('button', { name: 'No profile (1)' })).toBeInTheDocument();
  });

  it('says no email matches the search, and clears it from there', async () => {
    await renderManager();
    api.list.mockImplementation(async (...args: unknown[]) => (args[4] ? [] : mails(1, 3)));
    api.countMatching.mockImplementation(async (...args: unknown[]) => (args[2] ? 0 : 3));
    await typeSearch('nothing');
    expect(screen.getByText('No email matches the search')).toBeInTheDocument();
    expect(screen.queryByText('No emails')).not.toBeInTheDocument();
    await click(within(screen.getByText('No email matches the search').closest('div')!.parentElement!).getByRole('button', { name: 'Clear search' }));
    expect(screen.getByRole('searchbox', { name: 'Search by subject, sender or content...' })).toHaveValue('');
    expect(screen.getByText('Order 1')).toBeInTheDocument();
    expect(lastList()).toEqual([undefined, undefined, undefined, 0]);
  });

  it('acts on the searched set when every matching email is selected, and says so in the confirmation', async () => {
    api.countMatching.mockImplementation(async (...args: unknown[]) => (args[2] ? 12 : 3));
    await renderManager();
    await typeSearch('invoice');
    await click(selectAll());
    await click(button('Select all 12 matching this filter.'));
    await click(button('Delete (12)'));
    expect(screen.getByRole('dialog')).toHaveTextContent('Only the emails that match the search are included.');
    await click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }));
    expect(api.bulk).toHaveBeenCalledWith({
      action: 'delete',
      expectedCount: 12,
      filter: { search: 'invoice' },
    });
  });
});
