import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, within } from '@/test/render';
import { EmailReceiptsManager } from './EmailReceiptsManager';
import { makeMailbox, makeReceipt } from './email-receipts-fixtures';

const api = vi.hoisted(() => ({
  list: vi.fn(),
  countMatching: vi.fn(),
  bulk: vi.fn(),
  mailboxGet: vi.fn(),
}));
const nav = vi.hoisted(() => ({
  params: new URLSearchParams(),
  router: {
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
    refresh: vi.fn(),
  },
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
  },
}));
vi.mock('@/lib/assistant-ready', () => ({
  assistantCanAnswerNow: vi.fn().mockResolvedValue(false),
}));
vi.mock('@/hooks/useReceiptParserLookups', () => ({
  useReceiptParserLookups: () => ({
    state: { status: 'loading' },
    reload: vi.fn(),
  }),
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

const mail = (n: number) =>
  makeReceipt({
    id: `r-${n}`,
    subject: `Order ${n}`,
    status: 'no_parser',
    fromAddress: 'a@shop.example',
    fromDomain: 'shop.example',
  });

/** `count` emails numbered from `first`. */
const mails = (first: number, count: number) => Array.from({ length: count }, (_, i) => mail(first + i));

/** A 351-email list: the server answers by offset, 50 to a page. */
const serve =
  (total: number) =>
  async (_status?: string, _limit?: number, _domain?: string, offset = 0) =>
    mails(offset + 1, Math.max(0, Math.min(50, total - offset)));

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

const next = () => screen.getByTitle('Next page');
const unknownNext = () => screen.getByRole('button', { name: 'Next page' });
const unknownPrevious = () => screen.getByRole('button', { name: 'Previous page' });
const previous = () => screen.getByTitle('Previous page');
const selectAll = () => screen.getByRole('checkbox', { name: 'Select all emails on this list' });
const row = (n: number) => screen.getByRole('checkbox', { name: `Select Order ${n}` });
const bar = () => screen.queryByRole('region', { name: 'Selected emails' });
const lastOffset = () => api.list.mock.calls[api.list.mock.calls.length - 1][3];

describe('EmailReceiptsManager: paging', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    nav.params = new URLSearchParams();
    api.list.mockImplementation(serve(351));
    api.countMatching.mockResolvedValue(351);
    api.mailboxGet.mockResolvedValue(makeMailbox());
    api.bulk.mockResolvedValue({ affected: 1, skippedLinked: 0, unchanged: 0, notIgnorable: 0 });
  });

  it('asks for the first page, and says which emails of how many are shown', async () => {
    await renderManager();
    expect(api.list).toHaveBeenLastCalledWith(undefined, undefined, undefined, 0);
    expect(screen.getByRole('checkbox', { name: 'Select Order 50' })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'Select Order 51' })).not.toBeInTheDocument();
    expect(document.body.textContent).toContain('Showing 1 - 50 of 351 emails');
    expect(previous()).toBeDisabled();
  });

  it('loads page 2 with an offset of 50 and walks on to the last, short page', async () => {
    await renderManager();
    await click(next());
    expect(api.list).toHaveBeenLastCalledWith(undefined, undefined, undefined, 50);
    expect(row(51)).toBeInTheDocument();
    expect(document.body.textContent).toContain('Showing 51 - 100 of 351 emails');

    await click(screen.getByTitle('Last page'));
    expect(lastOffset()).toBe(350);
    expect(row(351)).toBeInTheDocument();
    expect(document.body.textContent).toContain('Showing 351 - 351 of 351 emails');
    expect(next()).toBeDisabled();
  });

  it('counts the filter once, not again for every page', async () => {
    await renderManager();
    const counts = api.countMatching.mock.calls.length;
    await click(next());
    expect(api.countMatching.mock.calls.length).toBe(counts);
  });

  it('returns to page 1 when the state filter changes', async () => {
    await renderManager();
    await click(next());
    await click(next());
    expect(lastOffset()).toBe(100);
    await click(screen.getByRole('button', { name: 'No profile' }));
    expect(api.list).toHaveBeenLastCalledWith('no_parser', undefined, undefined, 0);
  });

  it('returns to page 1 when the sender domain changes', async () => {
    nav.params = new URLSearchParams('domain=shop.example');
    await renderManager();
    await click(next());
    expect(lastOffset()).toBe(50);
    await click(screen.getByRole('button', { name: 'No profile' }));
    expect(api.list).toHaveBeenLastCalledWith('no_parser', undefined, 'shop.example', 0);
  });

  it('never draws a page that a newer request overtook', async () => {
    await renderManager();
    let finishPage2: (rows: ReturnType<typeof mails>) => void = () => {};
    api.list.mockImplementationOnce(() => new Promise((resolve) => (finishPage2 = resolve as typeof finishPage2)));
    await click(next()); // page 2: still waiting
    api.list.mockImplementationOnce(async () => mails(101, 50));
    await click(next()); // page 3: answered first
    expect(row(101)).toBeInTheDocument();

    await act(async () => {
      finishPage2(mails(51, 50)); // the late answer for page 2
    });
    expect(row(101)).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'Select Order 51' })).not.toBeInTheDocument();
    expect(document.body.textContent).toContain('Showing 101 - 150 of 351 emails');
  });

  it('goes to the last page that exists when the page the reader was on has emptied', async () => {
    await renderManager();
    await click(next());
    await click(row(51));
    // The emails of page 2 are gone after the delete; 40 remain, so the last page is the first.
    api.list.mockImplementation(serve(40));
    api.countMatching.mockResolvedValue(40);
    await click(screen.getByRole('button', { name: 'Delete (1)' }));
    await click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }));
    expect(api.bulk).toHaveBeenCalledTimes(1);
    expect(lastOffset()).toBe(0);
    expect(row(1)).toBeInTheDocument();
  });

  it('stays on the current page after a reload that leaves it in place', async () => {
    await renderManager();
    await click(next());
    await click(row(51));
    await click(screen.getByRole('button', { name: 'Delete (1)' }));
    await click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }));
    expect(lastOffset()).toBe(50);
    expect(row(51)).toBeInTheDocument();
  });

  describe('selection', () => {
    it('keeps the ticked rows when the page changes, and says how many are not shown', async () => {
      await renderManager();
      await click(row(1));
      expect(bar()).toHaveTextContent('1 email selected');
      await click(next());
      expect(bar()).toHaveTextContent('1 email selected');
      expect(bar()).toHaveTextContent('1 of the selected emails is not shown in this list.');
      await click(row(51));
      expect(bar()).toHaveTextContent('2 emails selected');
      await click(previous());
      expect(row(1)).toBeChecked();
      expect(bar()).toHaveTextContent('1 of the selected emails is not shown in this list.');
    });

    it('ticks the rows of the current page with the header box, and offers every matching email', async () => {
      await renderManager();
      await click(next());
      await click(selectAll());
      expect(bar()).toHaveTextContent('All 50 on this page are selected.');
      expect(
        screen.getByRole('button', {
          name: 'Select all 351 matching this filter.',
        }),
      ).toBeInTheDocument();
    });

    it('keeps "every email matching the filter" across pages', async () => {
      await renderManager();
      await click(selectAll());
      await click(
        screen.getByRole('button', {
          name: 'Select all 351 matching this filter.',
        }),
      );
      await click(next());
      expect(bar()).toHaveTextContent('All 351 emails matching this filter are selected.');
      expect(row(51)).toBeChecked();
    });
  });

  describe('when the total is unknown', () => {
    beforeEach(() => {
      api.countMatching.mockRejectedValue(new Error('down'));
    });

    it('offers Next while the page came back full, and never claims zero emails', async () => {
      await renderManager();
      expect(document.body.textContent).not.toContain('of 0');
      expect(document.body.textContent).toContain('Page 1');
      expect(unknownNext()).toBeEnabled();
      expect(unknownPrevious()).toBeDisabled();
      await click(unknownNext());
      expect(lastOffset()).toBe(50);
      expect(document.body.textContent).toContain('Page 2');
      expect(unknownPrevious()).toBeEnabled();
    });

    it('closes Next on a short page', async () => {
      api.list.mockImplementation(serve(60));
      await renderManager();
      await click(unknownNext());
      expect(row(51)).toBeInTheDocument();
      expect(unknownNext()).toBeDisabled();
    });

    it('draws no pager for a short first page', async () => {
      api.list.mockImplementation(serve(3));
      await renderManager();
      expect(screen.queryByRole('button', { name: 'Next page' })).not.toBeInTheDocument();
    });
  });

  it('draws the count and no stepper when everything fits on one page', async () => {
    api.list.mockImplementation(serve(3));
    api.countMatching.mockResolvedValue(3);
    await renderManager();
    expect(screen.queryByTitle('Next page')).not.toBeInTheDocument();
    expect(screen.getByText('3 emails')).toBeInTheDocument();
  });
});
