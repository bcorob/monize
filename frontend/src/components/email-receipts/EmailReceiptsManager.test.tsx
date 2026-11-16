import { describe, it, expect, vi, beforeEach } from 'vitest';
import toast from 'react-hot-toast';
import { useRouter } from 'next/navigation';
import { render, screen, fireEvent, act, within } from '@/test/render';
import { EmailReceiptsManager } from './EmailReceiptsManager';
import { makeDetail, makeMailbox, makeParser, makeReceipt } from './email-receipts-fixtures';
import type { EmailReceiptListItem } from '@/types/email-receipts';

const api = vi.hoisted(() => ({
  list: vi.fn(),
  listDomains: vi.fn(),
  getStatusCounts: vi.fn(),
  approveProposal: vi.fn(),
  overview: vi.fn(),
  processBatch: vi.fn(),
  get: vi.fn(),
  reprocess: vi.fn(),
  link: vi.fn(),
  ignore: vi.fn(),
  remove: vi.fn(),
  askAi: vi.fn(),
  mailboxGet: vi.fn(),
  parserCreate: vi.fn(),
  parserTest: vi.fn(),
  draftWithAi: vi.fn(),
  profileBatch: vi.fn(),
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
const assistant = vi.hoisted(() => ({ canAnswer: vi.fn() }));
const transactionsApi = vi.hoisted(() => ({ getAll: vi.fn() }));
const payeesApi = vi.hoisted(() => ({ getAll: vi.fn() }));
const categoriesApi = vi.hoisted(() => ({ getAll: vi.fn() }));
const accountsApi = vi.hoisted(() => ({ getAll: vi.fn() }));
const exchangeRatesApi = vi.hoisted(() => ({ getCurrencies: vi.fn() }));

vi.mock('@/lib/email-receipts-api', () => ({
  emailReceiptsApi: {
    receipts: {
      list: api.list,
      listDomains: api.listDomains,
      getStatusCounts: api.getStatusCounts,
      approveProposal: api.approveProposal,
      overview: api.overview,
      processBatch: api.processBatch,
      get: api.get,
      reprocess: api.reprocess,
      link: api.link,
      ignore: api.ignore,
      remove: api.remove,
      askAi: api.askAi,
      profileBatch: api.profileBatch,
    },
    mailbox: { get: api.mailboxGet },
    parsers: { create: api.parserCreate, test: api.parserTest, draftWithAi: api.draftWithAi },
  },
}));
vi.mock('@/lib/assistant-ready', () => ({ assistantCanAnswerNow: assistant.canAnswer }));
vi.mock('@/lib/transactions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/transactions')>()),
  transactionsApi,
}));
vi.mock('@/lib/payees', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/payees')>()),
  payeesApi,
}));
vi.mock('@/lib/categories', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/categories')>()),
  categoriesApi,
}));
// The profile editor's lookups read the accounts and the currencies too (for a trade profile).
vi.mock('@/lib/accounts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/accounts')>()),
  accountsApi,
}));
vi.mock('@/lib/exchange-rates', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/exchange-rates')>()),
  exchangeRatesApi,
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

const tx = { id: 'tx-1', date: '2026-08-30', amount: -25, currencyCode: 'USD', payeeName: 'Allegro' };

const unmatched = makeReceipt({ id: 'r-unmatched', subject: 'Order unmatched', status: 'unmatched' });
const noParser = makeReceipt({ id: 'r-noparser', subject: 'Order no profile', status: 'no_parser', fromAddress: 'orders@shop.example', fromDomain: 'shop.example' });
const ambiguous = makeReceipt({ id: 'r-ambiguous', subject: 'Order ambiguous', status: 'ambiguous' });
const proposed = makeReceipt({ id: 'r-proposed', subject: 'Order proposed', status: 'review', displayState: 'proposed', transaction: tx, parserName: 'Allegro parser' });
const applied = makeReceipt({ id: 'r-applied', subject: 'Order applied', status: 'review', displayState: 'applied', transaction: tx });
const ignored = makeReceipt({ id: 'r-ignored', subject: 'Order ignored', status: 'ignored' });
const skipped = makeReceipt({ id: 'r-skipped', subject: 'Order skipped', status: 'skipped' });
const pending = makeReceipt({ id: 'r-pending', subject: 'Order pending', status: 'pending' });
const parseFailed = makeReceipt({ id: 'r-failed', subject: 'Order failed', status: 'parse_failed' });
const conflict = makeReceipt({ id: 'r-conflict', subject: 'Order conflict', status: 'review_conflict', transaction: tx });
const dismissed = makeReceipt({ id: 'r-dismissed', subject: 'Order dismissed', status: 'review', displayState: 'dismissed', transaction: tx });
const expired = makeReceipt({ id: 'r-expired', subject: 'Order expired', status: 'review', displayState: 'expired', transaction: tx });
const missing = makeReceipt({ id: 'r-missing', subject: 'Order missing', status: 'review', displayState: 'request_missing', transaction: tx });
const waiting = makeReceipt({ id: 'r-waiting', subject: 'Order waiting', status: 'review', displayState: 'pending_ai', transaction: tx });

const all = [unmatched, noParser, ambiguous, proposed, applied, ignored, skipped, pending];

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

/** The row's own button, or the entry behind its "More actions" menu. */
function actionNames(subject: string): string[] {
  const row = rowOf(subject);
  const inline = within(row)
    .queryAllByRole('button')
    .map((b) => b.getAttribute('aria-label') ?? b.textContent ?? '');
  return inline.filter((name) => name !== 'More actions');
}

async function runAction(subject: string, name: string) {
  const row = rowOf(subject);
  const direct = within(row).queryByRole('button', { name });
  if (direct) {
    await click(direct);
    return;
  }
  await click(within(row).getByRole('button', { name: 'More actions' }));
  await click(screen.getByRole('menuitem', { name }));
}

/** Every action a row offers, inline and in its menu. */
async function allActions(subject: string): Promise<string[]> {
  const row = rowOf(subject);
  const names = actionNames(subject);
  const more = within(row).queryByRole('button', { name: 'More actions' });
  if (more) {
    await click(more);
    const menu = screen.getAllByRole('menuitem').map((item) => item.textContent ?? '');
    await click(more);
    return [...names, ...menu];
  }
  return names;
}

describe('EmailReceiptsManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    assistant.canAnswer.mockResolvedValue(true);
    api.draftWithAi.mockResolvedValue({ ok: true, requestId: 'req-draft' });
    transactionsApi.getAll.mockResolvedValue({
      data: [],
      pagination: { page: 1, limit: 50, total: 0, totalPages: 1, hasMore: false },
    });
    nav.params = new URLSearchParams();
    api.list.mockResolvedValue(all);
    api.listDomains.mockResolvedValue([
      { domain: 'allegro.pl', count: 5, processable: 3 },
      { domain: 'shop.example.com', count: 2, processable: 2 },
    ]);
    api.overview.mockResolvedValue({ processable: 6 });
    api.getStatusCounts.mockResolvedValue({ pending: 1, no_parser: 2, review: 3, unmatched: 4 });
    api.mailboxGet.mockResolvedValue(makeMailbox({ aiMode: 'on_demand' }));
    payeesApi.getAll.mockResolvedValue([]);
    categoriesApi.getAll.mockResolvedValue([]);
    accountsApi.getAll.mockResolvedValue([]);
    exchangeRatesApi.getCurrencies.mockResolvedValue([]);
  });

  describe('the list', () => {
    it('shows each email with its sender, state and matched transaction', async () => {
      await renderManager();
      expect(api.list).toHaveBeenCalledWith(undefined, undefined, undefined, 0);
      const row = rowOf('Order proposed');
      expect(within(row).getByText('orders@allegro.pl')).toBeInTheDocument();
      expect(within(row).getByText('Waiting for approval')).toBeInTheDocument();
      expect(within(row).getByRole('link', { name: /\$25\.00.*Allegro|Allegro/ })).toHaveAttribute(
        'href',
        '/transactions?targetTransactionId=tx-1',
      );
      expect(within(rowOf('Order unmatched')).getByText('No transaction found', { selector: 'span' })).toBeInTheDocument();
      expect(within(rowOf('Order unmatched')).getByText('None yet')).toBeInTheDocument();
    });

    it('heads the date column "Date" and shows the effective date, not the forwarding date', async () => {
      api.list.mockResolvedValue([
        makeReceipt({
          id: 'r-fwd',
          subject: 'Order forwarded',
          receivedAt: '2026-09-20T10:00:00.000Z',
          originalSentAt: '2026-08-05T10:00:00.000Z',
          effectiveDate: '2026-08-05T10:00:00.000Z',
        }),
      ]);
      await renderManager();
      expect(screen.getByRole('columnheader', { name: 'Date' })).toBeInTheDocument();
      expect(screen.queryByRole('columnheader', { name: 'Received' })).not.toBeInTheDocument();
      const row = rowOf('Order forwarded');
      expect(row).toHaveTextContent(/2026-08-05|08\/05\/2026|05\/08\/2026|Aug/);
      expect(row).not.toHaveTextContent(/2026-09-20|09\/20\/2026|20\/09\/2026|Sep 20/);
    });

    it('links to the review inbox and to the settings', async () => {
      await renderManager();
      expect(screen.getByRole('link', { name: 'Open the AI review inbox' })).toHaveAttribute('href', '/ai-reviews');
      expect(screen.getByRole('link', { name: 'Mailbox settings' })).toHaveAttribute('href', '/email-receipts?tab=mailbox');
    });

    it('says there are no emails only when the list loaded empty', async () => {
      api.list.mockResolvedValue([]);
      await renderManager();
      expect(screen.getByText('No emails')).toBeInTheDocument();
    });

    it('invites connecting a mailbox when there is none', async () => {
      api.list.mockResolvedValue([]);
      api.mailboxGet.mockResolvedValue(null);
      await renderManager();
      expect(screen.getByRole('link', { name: 'Connect a mailbox' })).toHaveAttribute('href', '/email-receipts?tab=mailbox');
    });

    it('does not invite connecting a mailbox when there is one, or when that could not be checked', async () => {
      api.list.mockResolvedValue([]);
      api.mailboxGet.mockRejectedValue(new Error('boom'));
      await renderManager();
      expect(screen.getByText('No emails')).toBeInTheDocument();
      expect(screen.queryByRole('link', { name: 'Connect a mailbox' })).not.toBeInTheDocument();
    });

    it('does not invite connecting a mailbox when one is connected', async () => {
      api.list.mockResolvedValue([]);
      await renderManager();
      expect(screen.getByText('No emails')).toBeInTheDocument();
      expect(screen.queryByRole('link', { name: 'Connect a mailbox' })).not.toBeInTheDocument();
    });

    it('shows a failed load as an error with a retry, never as an empty list', async () => {
      api.list.mockRejectedValueOnce(new Error('boom'));
      await renderManager();
      expect(screen.getByRole('alert')).toHaveTextContent('The emails could not be loaded');
      expect(screen.queryByText('No emails')).not.toBeInTheDocument();
      await click(screen.getByRole('button', { name: 'Try again' }));
      expect(screen.getByRole('row', { name: /Order proposed/ })).toBeInTheDocument();
    });
  });

  describe('the status filter', () => {
    it('asks the server for the chosen status', async () => {
      await renderManager();
      await click(screen.getByRole('button', { name: 'Could not be read (0)' }));
      expect(api.list).toHaveBeenLastCalledWith('parse_failed', undefined, undefined, 0);
      expect(screen.getByRole('button', { name: 'Could not be read (0)' })).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByRole('button', { name: 'All (10)' })).toHaveAttribute('aria-pressed', 'false');
    });

    it('never draws the previous filter\'s rows, nor offers their actions, while the new one loads', async () => {
      await renderManager();
      let resolve!: (value: unknown) => void;
      api.list.mockReturnValueOnce(new Promise((r) => (resolve = r)));
      await click(screen.getByRole('button', { name: 'No profile (2)' }));
      expect(screen.queryByRole('row', { name: /Order proposed/ })).not.toBeInTheDocument();
      expect(screen.getByText('Loading emails')).toBeInTheDocument();
      await act(async () => {
        resolve([noParser]);
      });
      expect(screen.getByRole('row', { name: /Order no profile/ })).toBeInTheDocument();
      expect(screen.queryByRole('row', { name: /Order proposed/ })).not.toBeInTheDocument();
    });

    it('keeps the newest filter when an older request answers late', async () => {
      let resolveAll!: (value: unknown) => void;
      api.list.mockReturnValueOnce(new Promise((r) => (resolveAll = r)));
      await act(async () => {
        render(<EmailReceiptsManager />);
      });
      api.list.mockResolvedValueOnce([ignored]);
      await click(screen.getByRole('button', { name: 'Ignored (0)' }));
      expect(screen.getByRole('row', { name: /Order ignored/ })).toBeInTheDocument();
      await act(async () => {
        resolveAll(all);
      });
      expect(screen.getByRole('row', { name: /Order ignored/ })).toBeInTheDocument();
      expect(screen.queryByRole('row', { name: /Order proposed/ })).not.toBeInTheDocument();
    });

    it('says which state is empty, apart from an empty mailbox', async () => {
      await renderManager();
      api.list.mockResolvedValueOnce([]);
      await click(screen.getByRole('button', { name: 'Skipped (0)' }));
      expect(screen.getByText('No emails in this state')).toBeInTheDocument();
    });
  });

  describe('Retry failed emails', () => {
    it('is not offered when no email failed to parse', async () => {
      await renderManager();
      expect(screen.queryByRole('button', { name: /Retry failed emails/ })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Process all/ })).not.toBeInTheDocument();
    });

    it('is offered while the counts report parse_failed emails, and processes only those', async () => {
      api.getStatusCounts.mockResolvedValue({ pending: 1, parse_failed: 2, review: 3 });
      api.processBatch.mockResolvedValue({ processed: 2, byOutcome: { review: 2 }, failed: 0, remaining: 0, since: 'T' });
      await renderManager();
      await click(screen.getByRole('button', { name: 'Retry failed emails (2)' }));
      expect(api.processBatch).toHaveBeenCalledWith({ statuses: ['parse_failed'] });
      // The list and the counts are read again after the run.
      expect(api.getStatusCounts.mock.calls.length).toBeGreaterThan(1);
    });

    it('keeps the run to the filtered sender', async () => {
      nav.params = new URLSearchParams('domain=shop.example.com');
      api.getStatusCounts.mockResolvedValue({ parse_failed: 1 });
      api.processBatch.mockResolvedValue({ processed: 1, byOutcome: { review: 1 }, failed: 0, remaining: 0, since: 'T' });
      await renderManager();
      await click(screen.getByRole('button', { name: 'Retry failed emails (1)' }));
      expect(api.processBatch).toHaveBeenCalledWith({ domain: 'shop.example.com', statuses: ['parse_failed'] });
    });

    it('is not shown while the counts are unknown', async () => {
      api.getStatusCounts.mockRejectedValue(new Error('down'));
      await renderManager();
      expect(screen.queryByRole('button', { name: /Retry failed emails/ })).not.toBeInTheDocument();
    });
  });

  describe('the sender domain filter', () => {
    const tag = (name: string) => screen.getByRole('button', { name });
    const choose = (name: string) => click(tag(name));
    const SHOP = 'shop.example.com (2)';

    it('offers "All senders" and each sender domain with its count as tags, on all senders by default', async () => {
      await renderManager();
      expect(api.listDomains).toHaveBeenCalledTimes(1);
      const cloud = screen.getByRole('group', { name: 'Sender domain' });
      expect(within(cloud).getAllByRole('button').map((b) => b.textContent)).toEqual([
        'All senders',
        'allegro.pl (5)',
        SHOP,
      ]);
      expect(tag('All senders')).toHaveAttribute('aria-pressed', 'true');
      expect(tag('allegro.pl (5)')).toHaveAttribute('aria-pressed', 'false');
    });

    it('counts the sender domains within the chosen state, asking the server for that state', async () => {
      await renderManager();
      api.listDomains.mockResolvedValueOnce([{ domain: 'only.example', count: 7 }]);
      await click(screen.getByRole('button', { name: /^Could not be read/ }));
      expect(api.listDomains).toHaveBeenLastCalledWith('parse_failed');
      const cloud = screen.getByRole('group', { name: 'Sender domain' });
      expect(within(cloud).getAllByRole('button').map((b) => b.textContent)).toEqual(['All senders', 'only.example (7)']);
    });

    it('never shows another state\'s domains while this state\'s are loading', async () => {
      await renderManager();
      api.listDomains.mockReturnValueOnce(new Promise(() => {}));
      await click(screen.getByRole('button', { name: /^Could not be read/ }));
      expect(screen.queryByRole('button', { name: 'allegro.pl (5)' })).not.toBeInTheDocument();
      expect(screen.getByText('The sender counts could not be loaded.')).toBeInTheDocument();
    });

    it('toggles a domain: choosing the chosen tag again clears it', async () => {
      await renderManager();
      await choose(SHOP);
      expect(api.list).toHaveBeenLastCalledWith(undefined, undefined, 'shop.example.com', 0);
      await choose(SHOP);
      expect(api.list).toHaveBeenLastCalledWith(undefined, undefined, undefined, 0);
    });

    it('asks the server for the chosen domain beside the status, and writes it to the URL', async () => {
      await renderManager();
      await choose(SHOP);
      expect(api.list).toHaveBeenLastCalledWith(undefined, undefined, 'shop.example.com', 0);
      expect(nav.router.replace).toHaveBeenLastCalledWith('/email-receipts?tab=emails&domain=shop.example.com', { scroll: false });
      await click(screen.getByRole('button', { name: /^Could not be read/ }));
      expect(api.list).toHaveBeenLastCalledWith('parse_failed', undefined, 'shop.example.com', 0);
      expect(
        screen.getByText('Showing emails from shop.example.com and its sub-domains. Select several of them to draft one profile for the sender.'),
      ).toBeInTheDocument();
      await choose('All senders');
      expect(api.list).toHaveBeenLastCalledWith('parse_failed', undefined, undefined, 0);
      expect(nav.router.replace).toHaveBeenLastCalledWith('/email-receipts?tab=emails', { scroll: false });
    });

    it('keeps the other query parameters when it writes the domain', async () => {
      nav.params = new URLSearchParams('keep=1');
      await renderManager();
      await choose('allegro.pl (5)');
      expect(nav.router.replace).toHaveBeenLastCalledWith('/email-receipts?keep=1&tab=emails&domain=allegro.pl', { scroll: false });
    });

    it('starts from ?domain= and asks for it on the first load', async () => {
      nav.params = new URLSearchParams('domain=Shop.Example.com');
      await renderManager();
      expect(api.list).toHaveBeenCalledWith(undefined, undefined, 'shop.example.com', 0);
      expect(tag(SHOP)).toHaveAttribute('aria-pressed', 'true');
    });

    it('treats a ?domain= that is no host name as no filter, and offers a domain the list does not know', async () => {
      nav.params = new URLSearchParams('domain=%3Cscript%3E');
      await renderManager();
      expect(api.list).toHaveBeenCalledWith(undefined, undefined, undefined, 0);
      expect(tag('All senders')).toHaveAttribute('aria-pressed', 'true');
      expect(nav.router.replace).not.toHaveBeenCalled();
    });

    it('still shows a filtered domain that the counts do not list, and says which empty list it is', async () => {
      nav.params = new URLSearchParams('domain=gone.example.com');
      api.list.mockResolvedValue([]);
      await renderManager();
      expect(tag('gone.example.com')).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByText('No emails in this state')).toBeInTheDocument();
    });

    it('works with only "All senders" when the domains could not be read, never as an empty list', async () => {
      api.listDomains.mockRejectedValue(new Error('boom'));
      await renderManager();
      const cloud = screen.getByRole('group', { name: 'Sender domain' });
      expect(within(cloud).getAllByRole('button').map((b) => b.textContent)).toEqual(['All senders']);
      expect(screen.getByText('The sender counts could not be loaded.')).toBeInTheDocument();
      expect(screen.getByRole('row', { name: /Order proposed/ })).toBeInTheDocument();
    });

    it('never draws the previous domain\'s rows while the new one loads, and keeps the newest when an older answer is late', async () => {
      let resolveOld!: (value: unknown) => void;
      await renderManager();
      api.list.mockReturnValueOnce(new Promise((r) => (resolveOld = r)));
      await choose('allegro.pl (5)');
      expect(screen.queryByRole('row', { name: /Order proposed/ })).not.toBeInTheDocument();
      expect(screen.getByText('Loading emails')).toBeInTheDocument();
      api.list.mockResolvedValueOnce([noParser]);
      await choose(SHOP);
      expect(screen.getByRole('row', { name: /Order no profile/ })).toBeInTheDocument();
      await act(async () => {
        resolveOld(all);
      });
      expect(screen.getByRole('row', { name: /Order no profile/ })).toBeInTheDocument();
      expect(screen.queryByRole('row', { name: /Order proposed/ })).not.toBeInTheDocument();
    });

    it('keeps the ticked rows when the domain changes', async () => {
      await renderManager();
      await click(within(rowOf('Order no profile')).getByRole('checkbox'));
      expect(screen.getByRole('region', { name: 'Selected emails' })).toBeInTheDocument();
      await choose(SHOP);
      expect(screen.getByRole('region', { name: 'Selected emails' })).toHaveTextContent('1 email selected');
    });

    it('reads the domain counts again after a command', async () => {
      api.ignore.mockResolvedValue(makeDetail());
      await renderManager();
      expect(api.listDomains).toHaveBeenCalledTimes(1);
      await runAction('Order unmatched', 'Ignore');
      await click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Ignore' }));
      expect(api.listDomains).toHaveBeenCalledTimes(2);
    });
  });

  describe('which actions each email offers', () => {
    it('offers everything for an email with no profile', async () => {
      await renderManager();
      expect(await allActions('Order no profile')).toEqual(
        expect.arrayContaining(['View', 'Create profile', 'Prepare a profile with AI', 'Reprocess', 'Ignore', 'Delete']),
      );
    });

    it('puts "Prepare a profile with AI" inline and "Create profile" in the menu for an email with no profile', async () => {
      await renderManager();
      const row = rowOf('Order no profile');
      // The card's lead action goes first: an email nothing read is turned into a profile.
      expect(actionNames('Order no profile')).toEqual(['Prepare a profile with AI', 'View']);
      expect(within(row).queryByRole('button', { name: 'Create profile' })).not.toBeInTheDocument();
      await click(within(row).getByRole('button', { name: 'More actions' }));
      expect(screen.getByRole('menuitem', { name: 'Create profile' })).toBeInTheDocument();
    });

    it('offers the AI draft for an email a profile could not read, and for no other state', async () => {
      api.list.mockResolvedValue([...all, parseFailed, conflict, dismissed, waiting]);
      await renderManager();
      for (const subject of ['Order no profile', 'Order failed']) {
        expect(await allActions(subject), subject).toContain('Prepare a profile with AI');
      }
      for (const subject of ['Order unmatched', 'Order ambiguous', 'Order proposed', 'Order applied', 'Order ignored', 'Order skipped', 'Order pending', 'Order conflict', 'Order dismissed', 'Order waiting']) {
        expect(await allActions(subject), subject).not.toContain('Prepare a profile with AI');
      }
    });

    it('offers "Recognize with AI" for an email nothing read, or whose request was dismissed, expired or lost', async () => {
      api.list.mockResolvedValue([...all, parseFailed, conflict, dismissed, expired, missing, waiting]);
      await renderManager();
      for (const subject of [
        'Order unmatched',
        'Order no profile',
        'Order ambiguous',
        'Order failed',
        'Order conflict',
        'Order dismissed',
        'Order expired',
        'Order missing',
      ]) {
        expect(await allActions(subject), subject).toContain('Recognize with AI');
      }
    });

    it('offers it for no email with a proposal waiting, an applied request, or one ignored, skipped or not yet read', async () => {
      api.list.mockResolvedValue([...all, waiting]);
      await renderManager();
      for (const subject of ['Order proposed', 'Order waiting', 'Order applied', 'Order ignored', 'Order skipped', 'Order pending']) {
        expect(await allActions(subject), subject).not.toContain('Recognize with AI');
      }
    });

    it.each(['off', 'on_demand', 'automatic'] as const)(
      "offers it whatever the mailbox AI mode (%s): pressing it is the person's consent",
      async (aiMode) => {
        api.mailboxGet.mockResolvedValue(makeMailbox({ aiMode }));
        await renderManager();
        expect(await allActions('Order unmatched')).toContain('Recognize with AI');
      },
    );

    it('offers it when the mailbox could not be read', async () => {
      api.mailboxGet.mockRejectedValue(new Error('boom'));
      await renderManager();
      expect(await allActions('Order unmatched')).toContain('Recognize with AI');
    });

    it.each(['off', 'on_demand', 'automatic'] as const)(
      'offers the AI draft whatever the mailbox AI mode (%s): it goes through the chat, not a provider call from here',
      async (aiMode) => {
        api.mailboxGet.mockResolvedValue(makeMailbox({ aiMode }));
        await renderManager();
        expect(await allActions('Order no profile')).toContain('Prepare a profile with AI');
      },
    );

    it('offers the AI draft when the mailbox could not be read, and when there is none', async () => {
      api.mailboxGet.mockRejectedValue(new Error('boom'));
      await renderManager();
      expect(await allActions('Order no profile')).toContain('Prepare a profile with AI');
    });

    it('offers choosing a transaction for an email the matcher could not tie to one', async () => {
      await renderManager();
      expect(await allActions('Order ambiguous')).toContain('Choose transaction');
      expect(await allActions('Order unmatched')).toContain('Choose transaction');
      expect(await allActions('Order no profile')).toContain('Choose transaction');
    });

    it('offers no choosing once there is a proposal, or for a closed email', async () => {
      await renderManager();
      for (const subject of ['Order proposed', 'Order applied', 'Order ignored', 'Order skipped', 'Order pending']) {
        expect(await allActions(subject), subject).not.toContain('Choose transaction');
      }
    });

    it('offers nothing that changes an applied, ignored or skipped email but view and delete', async () => {
      await renderManager();
      for (const subject of ['Order applied', 'Order ignored', 'Order skipped']) {
        expect((await allActions(subject)).sort(), subject).toEqual(['Delete', 'View']);
      }
    });

    it('offers no reprocess for an email still waiting to be read', async () => {
      await renderManager();
      expect(await allActions('Order pending')).not.toContain('Reprocess');
    });
  });

  describe('view and link', () => {
    it('opens the detail dialog for the email', async () => {
      api.get.mockResolvedValue(makeDetail({ id: 'r-proposed', subject: 'Order proposed' }));
      await renderManager();
      await runAction('Order proposed', 'View');
      expect(api.get).toHaveBeenCalledWith('r-proposed');
      expect(screen.getByRole('dialog', { name: 'Email receipt' })).toBeInTheDocument();
    });

    describe('?email=', () => {
      const ID = '11111111-2222-4333-8444-555555555555';

      it('opens the detail dialog for a valid id', async () => {
        nav.params = new URLSearchParams(`tab=emails&email=${ID}`);
        api.get.mockResolvedValue(makeDetail({ id: ID, subject: 'Linked email' }));
        await renderManager();
        expect(api.get).toHaveBeenCalledWith(ID);
        expect(screen.getByRole('dialog', { name: 'Email receipt' })).toBeInTheDocument();
      });

      it('opens nothing for a value that is no id', async () => {
        nav.params = new URLSearchParams('tab=emails&email=not-an-id');
        await renderManager();
        expect(api.get).not.toHaveBeenCalled();
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      });

      it('removes the parameter, keeping the others, when the dialog closes', async () => {
        nav.params = new URLSearchParams(`tab=emails&domain=shop.example.com&email=${ID}`);
        api.get.mockResolvedValue(makeDetail({ id: ID, subject: 'Linked email' }));
        await renderManager();
        await click(screen.getAllByRole('button', { name: 'Close' }).at(-1) as HTMLElement);
        expect(nav.router.replace).toHaveBeenLastCalledWith('/email-receipts?tab=emails&domain=shop.example.com', {
          scroll: false,
        });
        expect(screen.queryByRole('dialog', { name: 'Email receipt' })).not.toBeInTheDocument();
      });

      it('does not touch the URL when a dialog opened from a row closes', async () => {
        api.get.mockResolvedValue(makeDetail({ id: 'r-proposed', subject: 'Order proposed' }));
        await renderManager();
        await runAction('Order proposed', 'View');
        await click(screen.getAllByRole('button', { name: 'Close' }).at(-1) as HTMLElement);
        expect(nav.router.replace).not.toHaveBeenCalled();
      });
    });

    it('links an ambiguous email to a candidate from the dialog and refreshes the list', async () => {
      api.get.mockResolvedValue(
        makeDetail({
          id: 'r-ambiguous',
          status: 'ambiguous',
          candidates: [{ id: 'tx-9', date: '2026-08-30', amount: -25, currencyCode: 'USD', payeeName: 'Allegro', description: null }],
        }),
      );
      api.link.mockResolvedValue(makeDetail({ id: 'r-ambiguous', status: 'review', displayState: 'proposed', transaction: tx }));
      await renderManager();
      await runAction('Order ambiguous', 'Choose transaction');
      expect(api.list).toHaveBeenCalledTimes(1);
      await click(screen.getByRole('button', { name: 'Link to this transaction' }));
      expect(api.link).toHaveBeenCalledWith('r-ambiguous', 'tx-9');
      expect(api.list).toHaveBeenCalledTimes(2);
    });
  });

  describe('reprocess', () => {
    it('reprocesses the email and refreshes the list', async () => {
      api.reprocess.mockResolvedValue(makeDetail());
      await renderManager();
      await runAction('Order unmatched', 'Reprocess');
      expect(api.reprocess).toHaveBeenCalledWith('r-unmatched');
      expect(toast.success).toHaveBeenCalledWith('Email reprocessed');
      expect(api.list).toHaveBeenCalledTimes(2);
    });

    it('names a refusal and still refreshes the list', async () => {
      api.reprocess.mockRejectedValue({ response: { data: { message: 'This email could not be read' } } });
      await renderManager();
      await runAction('Order unmatched', 'Reprocess');
      expect(screen.getByRole('alert')).toHaveTextContent('This email could not be read');
    });
  });

  describe('a trade confirmation', () => {
    const trade = (over: Partial<EmailReceiptListItem> = {}) =>
      makeReceipt({
        id: 'r-trade',
        subject: 'Order trade',
        isTrade: true,
        tradeSource: 'profile',
        status: 'review',
        displayState: 'proposed',
        ...over,
      });
    const booked = { id: 'it-1', date: '2026-10-15', action: 'BUY', symbol: 'XCNS', quantity: 75.9878, totalAmount: 2000, currencyCode: 'CAD' };

    it('offers "Recognize as a trade with AI" where "Recognize with AI" is, and the trade email only the former', async () => {
      api.list.mockResolvedValue([...all, trade({ status: 'parse_failed', displayState: null, statusReason: 'trade_no_symbol' })]);
      await renderManager();
      expect(await allActions('Order unmatched')).toContain('Recognize as a trade with AI');
      expect(await allActions('Order unmatched')).toContain('Recognize with AI');
      const tradeActions = await allActions('Order trade');
      expect(tradeActions).toContain('Recognize as a trade with AI');
      // A trade creates a transaction: there is no bank transaction to split.
      expect(tradeActions).not.toContain('Recognize with AI');
    });

    it('offers no recognition for an email with a proposal waiting or an applied one', async () => {
      api.list.mockResolvedValue([...all]);
      await renderManager();
      for (const subject of ['Order proposed', 'Order applied', 'Order ignored', 'Order skipped', 'Order pending']) {
        expect(await allActions(subject), subject).not.toContain('Recognize as a trade with AI');
      }
    });

    it('lets a trade email be linked to the transaction it reports, even once it was closed as already booked', async () => {
      api.list.mockResolvedValue([
        trade({ id: 'r-booked', subject: 'Order booked', status: 'ignored', displayState: null, statusReason: 'trade_exists' }),
        trade({ id: 'r-applied', subject: 'Order trade applied', displayState: 'applied' }),
      ]);
      await renderManager();
      expect(await allActions('Order booked')).toContain('Choose transaction');
      expect(await allActions('Order trade applied')).not.toContain('Choose transaction');
    });

    it('never links an email that already accounts for a transaction, and links one a trade profile read in part, as the server does', async () => {
      api.list.mockResolvedValue([
        trade({ id: 'r-linked', subject: 'Order linked', status: 'ignored', displayState: null, statusReason: 'trade_linked', investmentTransaction: booked }),
        trade({ id: 'r-noacct', subject: 'Order no account', status: 'parse_failed', displayState: null, statusReason: 'trade_no_account' }),
      ]);
      await renderManager();
      expect(await allActions('Order linked')).not.toContain('Choose transaction');
      expect(await allActions('Order no account')).toContain('Choose transaction');
    });

    it('offers to reprocess a trade the ledger already held, and nothing else on a closed email', async () => {
      api.list.mockResolvedValue([
        trade({ id: 'r-booked', subject: 'Order booked', status: 'ignored', displayState: null, statusReason: 'trade_exists' }),
        trade({ id: 'r-linked', subject: 'Order linked', status: 'ignored', displayState: null, statusReason: 'trade_linked', investmentTransaction: booked }),
        ignored,
      ]);
      api.reprocess.mockResolvedValue(makeDetail());
      await renderManager();
      const actions = await allActions('Order booked');
      expect(actions).toContain('Reprocess');
      expect(actions).not.toContain('Ignore');
      expect(await allActions('Order linked')).not.toContain('Reprocess');
      expect(await allActions('Order ignored')).not.toContain('Reprocess');
      await runAction('Order booked', 'Reprocess');
      expect(api.reprocess).toHaveBeenCalledWith('r-booked');
    });

    it('shows the investment transaction a trade email accounts for, linked to it, and marks the row as a trade', async () => {
      api.list.mockResolvedValue([
        trade({ id: 'r-done', subject: 'Order done', displayState: 'applied', investmentTransaction: booked }),
        trade({ id: 'r-open', subject: 'Order open' }),
      ]);
      await renderManager();
      const done = rowOf('Order done');
      expect(within(done).getByRole('link', { name: /^Bought 75\.9878 XCNS for .*2,000\.00/ })).toHaveAttribute(
        'href',
        '/investments?edit=it-1',
      );
      expect(within(done).getByText('Trade')).toBeInTheDocument();
      const open = rowOf('Order open');
      expect(within(open).getByText('Trade')).toBeInTheDocument();
      expect(within(open).getByText('None yet')).toBeInTheDocument();
      expect(within(rowOf('Order open')).queryByRole('link', { name: /Bought/ })).not.toBeInTheDocument();
    });

    it('names a booked dividend and a booked reinvestment as what they are, never as bought', async () => {
      api.list.mockResolvedValue([
        trade({
          id: 'r-div',
          subject: 'Order dividend',
          displayState: 'applied',
          investmentTransaction: { ...booked, id: 'it-2', action: 'DIVIDEND', quantity: 0, totalAmount: 12.34 },
        }),
        trade({
          id: 'r-drip',
          subject: 'Order reinvested',
          displayState: 'applied',
          investmentTransaction: { ...booked, id: 'it-3', action: 'REINVEST', quantity: 0.4688, totalAmount: 12.34 },
        }),
      ]);
      await renderManager();
      const dividend = rowOf('Order dividend');
      expect(within(dividend).getByRole('link', { name: /^Dividend from XCNS of .*12\.34 on / })).toHaveAttribute(
        'href',
        '/investments?edit=it-2',
      );
      expect(within(dividend).queryByRole('link', { name: /Bought/ })).not.toBeInTheDocument();
      const reinvested = rowOf('Order reinvested');
      expect(within(reinvested).getByRole('link', { name: /^Reinvested a dividend in 0\.4688 XCNS for / })).toBeInTheDocument();
      expect(within(reinvested).queryByRole('link', { name: /Bought/ })).not.toBeInTheDocument();
    });

    it('marks no order email as a trade', async () => {
      await renderManager();
      expect(within(rowOf('Order proposed')).queryByText('Trade')).not.toBeInTheDocument();
    });

    it('sends a trade proposal to the review inbox, where its card is shown, and approves nothing from the list', async () => {
      api.list.mockResolvedValue([trade({ aiReviewRequestId: 'req-trade' })]);
      await renderManager();
      await runAction('Order trade', 'Review in inbox');
      expect(useRouter().push).toHaveBeenCalledWith('/ai-reviews?kind=email_receipt');
      expect(api.approveProposal).not.toHaveBeenCalled();
    });

    it('opens the trade dialog, which queues the request as a trade', async () => {
      api.list.mockResolvedValue([trade({ status: 'no_parser', displayState: null, isTrade: false, id: 'r-np', subject: 'Order np' })]);
      api.askAi.mockResolvedValue({ ok: true, requestId: 'req-t', transactionId: null });
      api.get.mockResolvedValue(makeDetail({ id: 'r-np', transaction: null, bodyText: 'Symbol: XCNS' }));
      await renderManager();
      await runAction('Order np', 'Recognize as a trade with AI');
      expect(screen.getByRole('dialog', { name: 'Recognize as a trade with AI' })).toBeInTheDocument();
      await click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Recognize as a trade' }));
      expect(api.askAi).toHaveBeenCalledWith('r-np', undefined, { asTrade: true });
    });
  });

  describe('Recognize with AI', () => {
    beforeEach(() => {
      api.list.mockResolvedValue([dismissed, unmatched]);
      api.askAi.mockResolvedValue({ ok: true, requestId: 'req-1', transactionId: 'tx-1' });
      api.get.mockResolvedValue(makeDetail({ id: 'r-dismissed', transaction: tx, bodyText: 'Widget 12.00' }));
    });

    it("asks to confirm the email's own transaction, queues the request, reloads the list and opens the chat", async () => {
      await renderManager();
      await runAction('Order dismissed', 'Recognize with AI');
      expect(screen.getByRole('dialog')).toHaveTextContent(/Allegro/);
      expect(api.askAi).not.toHaveBeenCalled();

      await click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Recognize with AI' }));

      expect(api.askAi).toHaveBeenCalledWith('r-dismissed', undefined);
      expect(api.list).toHaveBeenCalledTimes(2);
      expect(useRouter().push).toHaveBeenCalledWith(expect.stringMatching(/^\/ai\?handoff=[0-9a-f-]{36}$/));
    });

    it('says the request waits in the review inbox when no assistant can answer', async () => {
      assistant.canAnswer.mockResolvedValue(false);
      await renderManager();
      await runAction('Order dismissed', 'Recognize with AI');
      await click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Recognize with AI' }));

      expect(screen.getByRole('status')).toHaveTextContent('Queued');
      expect(within(screen.getByRole('dialog')).getByRole('link', { name: 'Open the AI review inbox' })).toHaveAttribute(
        'href',
        '/ai-reviews',
      );
      expect(useRouter().push).not.toHaveBeenCalled();
    });

    it('opens the picker for an email with no transaction', async () => {
      await renderManager();
      await runAction('Order unmatched', 'Recognize with AI');
      expect(screen.getByRole('heading', { name: 'Choose the transaction for the AI' })).toBeInTheDocument();
    });
  });

  describe('parsers', () => {
    it('opens the profile editor prefilled with the sender domain and the email to test against', async () => {
      api.list.mockResolvedValue([noParser]);
      await renderManager();
      await runAction('Order no profile', 'Create profile');
      const dialog = screen.getByRole('dialog', { name: 'New profile' });
      expect((within(dialog).getByLabelText('Name') as HTMLInputElement).value).toBe('shop.example');
      expect((within(dialog).getByLabelText('Sender domains') as HTMLTextAreaElement).value).toBe('shop.example');
      expect(within(dialog).getByRole('button', { name: 'Order receipt' })).toHaveAttribute('aria-pressed', 'true');
    });

    it('starts a profile made from a trade confirmation as a trade profile, still switchable', async () => {
      api.list.mockResolvedValue([{ ...noParser, isTrade: true, tradeSource: 'ai' as const }]);
      await renderManager();
      await runAction('Order no profile', 'Create profile');
      const dialog = screen.getByRole('dialog', { name: 'New profile' });
      expect(within(dialog).getByRole('button', { name: 'Brokerage trade' })).toHaveAttribute('aria-pressed', 'true');
      await click(within(dialog).getByRole('button', { name: 'Order receipt' }));
      expect(within(dialog).getByRole('button', { name: 'Order receipt' })).toHaveAttribute('aria-pressed', 'true');
    });

    it('refreshes the list when a profile was created, and closes the editor', async () => {
      api.list.mockResolvedValue([noParser]);
      api.parserCreate.mockResolvedValue(makeParser());
      await renderManager();
      await runAction('Order no profile', 'Create profile');
      await click(screen.getByRole('button', { name: 'Save profile' }));
      expect(api.parserCreate).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      // The page's own list (the editor's test panel asks for its own, with a limit).
      const pageLists = api.list.mock.calls.filter(([, limit]) => limit === undefined);
      expect(pageLists).toHaveLength(2);
    });
  });

  it('offers to delete the stored emails a profile made here deletes, and does so on confirmation', async () => {
    api.list.mockResolvedValue([noParser]);
    api.parserCreate.mockResolvedValue(makeParser({ name: 'Spam shop', definition: { version: 2, discard: 'delete' } }));
    const page = { matched: 4, applied: 0, unreadable: 0, ignored: 0, done: 0, next: null };
    api.profileBatch.mockResolvedValueOnce(page).mockResolvedValueOnce({ ...page, done: 4 });
    await renderManager();
    await runAction('Order no profile', 'Create profile');
    await click(screen.getByRole('button', { name: 'Save profile' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('4 emails that Spam shop reads will be deleted');
    await click(within(dialog).getByRole('button', { name: 'Delete emails' }));
    expect(api.profileBatch).toHaveBeenLastCalledWith({ parserId: makeParser().id, action: 'delete' });
    expect(toast.success).toHaveBeenCalledWith('4 emails deleted');
  });

  describe('ignore and delete ask first', () => {
    it('ignores only after confirmation', async () => {
      api.ignore.mockResolvedValue(makeDetail());
      await renderManager();
      await runAction('Order unmatched', 'Ignore');
      const dialog = screen.getByRole('dialog');
      expect(within(dialog).getByText(/will propose nothing, and its open review request will be dismissed/)).toBeInTheDocument();
      expect(api.ignore).not.toHaveBeenCalled();
      await click(within(dialog).getByRole('button', { name: 'Ignore' }));
      expect(api.ignore).toHaveBeenCalledWith('r-unmatched');
      expect(toast.success).toHaveBeenCalledWith('Email ignored');
      expect(api.list).toHaveBeenCalledTimes(2);
    });

    it('does nothing when the confirmation is cancelled', async () => {
      await renderManager();
      await runAction('Order unmatched', 'Ignore');
      await click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
      expect(api.ignore).not.toHaveBeenCalled();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('deletes only after confirmation', async () => {
      api.remove.mockResolvedValue(undefined);
      await renderManager();
      await runAction('Order unmatched', 'Delete');
      const dialog = screen.getByRole('dialog');
      expect(within(dialog).getByText(/The stored email Order unmatched will be deleted/)).toBeInTheDocument();
      expect(api.remove).not.toHaveBeenCalled();
      await click(within(dialog).getByRole('button', { name: 'Delete' }));
      expect(api.remove).toHaveBeenCalledWith('r-unmatched');
      expect(toast.success).toHaveBeenCalledWith('Email deleted');
      expect(api.list).toHaveBeenCalledTimes(2);
    });

    it('names a refused delete and keeps the list as the server has it', async () => {
      api.remove.mockRejectedValue({ response: { data: { message: 'Email not found' } } });
      await renderManager();
      await runAction('Order unmatched', 'Delete');
      await click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }));
      expect(screen.getByRole('alert')).toHaveTextContent('Email not found');
    });
  });
});
