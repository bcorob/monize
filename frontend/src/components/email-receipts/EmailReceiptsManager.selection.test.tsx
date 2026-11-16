import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, within } from '@/test/render';
import { EmailReceiptsManager } from './EmailReceiptsManager';
import { makeMailbox, makeReceipt } from './email-receipts-fixtures';

const api = vi.hoisted(() => ({
  list: vi.fn(),
  listDomains: vi.fn(),
  getStatusCounts: vi.fn(),
  countMatching: vi.fn(),
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
    receipts: {
      list: api.list,
      listDomains: api.listDomains,
      getStatusCounts: api.getStatusCounts,
      countMatching: api.countMatching,
    },
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

const A = 'a.example.com';
const B = 'b.example.com';
const mail = (n: number, domain: string, status: 'no_parser' | 'unmatched' = 'no_parser') =>
  makeReceipt({
    id: `r-${n}`,
    subject: `Order ${n}`,
    status,
    fromAddress: `shop@${domain}`,
    fromDomain: domain,
  });

const rowsOf: Record<string, ReturnType<typeof mail>[]> = {
  [A]: [mail(1, A), mail(2, A)],
  [B]: [mail(3, B), mail(4, B)],
};
const everything = [...rowsOf[A], ...rowsOf[B]];

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

const row = (n: number) => screen.getByRole('checkbox', { name: `Select Order ${n}` });
const bar = () => screen.queryByRole('region', { name: 'Selected emails' });
const tag = (name: string) => screen.getByRole('button', { name });
const selectAll = () => screen.getByRole('checkbox', { name: 'Select all emails on this list' });
const HIDDEN = (n: number) =>
  n === 1 ? '1 of the selected emails is not shown in this list.' : `${n} of the selected emails are not shown in this list.`;

describe('EmailReceiptsManager: ticks that outlive a filter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    nav.params = new URLSearchParams();
    api.list.mockImplementation(async (status?: string, _limit?: number, domain?: string) =>
      (domain ? rowsOf[domain] : everything).filter((r) => status === undefined || r.status === status),
    );
    api.listDomains.mockResolvedValue([
      { domain: A, count: 2, processable: 2 },
      { domain: B, count: 2, processable: 2 },
    ]);
    api.getStatusCounts.mockResolvedValue({ no_parser: 4, unmatched: 1 });
    api.countMatching.mockResolvedValue(4);
    api.mailboxGet.mockResolvedValue(makeMailbox());
    api.draftWithAi.mockResolvedValue({ ok: true, requestId: 'req-draft' });
  });

  it('drafts linked profiles from one email of sender A and one of sender B', async () => {
    await renderManager();
    await click(tag(`${A} (2)`));
    await click(row(1));
    await click(tag(`${B} (2)`));
    expect(bar()).toHaveTextContent('1 email selected');
    expect(bar()).toHaveTextContent(HIDDEN(1));
    await click(row(3));
    expect(bar()).toHaveTextContent('2 emails selected');
    expect(bar()).toHaveTextContent(HIDDEN(1));

    await click(screen.getByRole('button', { name: 'Prepare a profile with AI (2)' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent(`${B} (1 email), ${A} (1 email)`);
    expect(api.draftWithAi).not.toHaveBeenCalled();
    await click(within(dialog).getByRole('button', { name: 'Draft linked profiles' }));
    expect(api.draftWithAi).toHaveBeenCalledTimes(1);
    expect(api.draftWithAi).toHaveBeenCalledWith(['r-3', 'r-1'], 'receipt');
  });

  it('keeps the ticks when the state filter changes', async () => {
    await renderManager();
    await click(row(1));
    await click(screen.getByRole('button', { name: /^No profile/ }));
    expect(bar()).toHaveTextContent('1 email selected');
    expect(row(1)).toBeChecked();
  });

  it('empties the selection from Clear', async () => {
    await renderManager();
    await click(tag(`${A} (2)`));
    await click(row(1));
    await click(tag(`${B} (2)`));
    await click(screen.getByRole('button', { name: 'Clear selection' }));
    expect(bar()).not.toBeInTheDocument();
    await click(tag(`${A} (2)`));
    expect(row(1)).not.toBeChecked();
  });

  it('ends an "every email matching" selection when the domain changes', async () => {
    api.countMatching.mockResolvedValue(1234);
    await renderManager();
    await click(selectAll());
    await click(screen.getByRole('button', { name: 'Select all 1,234 matching this filter.' }));
    expect(bar()).toHaveTextContent('1,234 emails selected');
    await click(tag(`${B} (2)`));
    expect(bar()).not.toBeInTheDocument();
    expect(row(3)).not.toBeChecked();
  });

  it('leaves the ticks of another domain alone when the header box acts on this page', async () => {
    await renderManager();
    await click(tag(`${A} (2)`));
    await click(row(1));
    await click(tag(`${B} (2)`));
    await click(selectAll());
    expect(bar()).toHaveTextContent('3 emails selected');
    expect(bar()).toHaveTextContent(HIDDEN(1));
    expect(row(3)).toBeChecked();
    expect(row(4)).toBeChecked();

    await click(selectAll());
    expect(row(3)).not.toBeChecked();
    expect(row(4)).not.toBeChecked();
    expect(bar()).toHaveTextContent('1 email selected');
    await click(tag(`${A} (2)`));
    expect(row(1)).toBeChecked();
    expect(bar()).not.toHaveTextContent('not shown');
  });
});
