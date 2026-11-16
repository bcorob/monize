import { describe, it, expect, vi, beforeEach } from 'vitest';
import { emailReceiptsApi } from './email-receipts-api';

const client = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock('./api', () => ({ default: client }));

describe('emailReceiptsApi', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('mailbox', () => {
    it('reads the mailbox, and an empty body is "no mailbox"', async () => {
      client.get.mockResolvedValueOnce({ data: '' });
      expect(await emailReceiptsApi.mailbox.get()).toBeNull();
      expect(client.get).toHaveBeenCalledWith('/email-receipts/mailbox');

      const mailbox = { id: 'mb-1', host: 'imap.example.com' };
      client.get.mockResolvedValueOnce({ data: mailbox });
      expect(await emailReceiptsApi.mailbox.get()).toBe(mailbox);
    });

    it('replaces the mailbox with a PUT of the whole configuration', async () => {
      const payload = {
        host: 'imap.example.com',
        port: 993,
        security: 'tls' as const,
        username: 'me',
        enabled: true,
        aiMode: 'off' as const,
        autoApply: false,
      };
      client.put.mockResolvedValue({ data: { id: 'mb-1' } });
      expect(await emailReceiptsApi.mailbox.upsert(payload)).toEqual({ id: 'mb-1' });
      expect(client.put).toHaveBeenCalledWith('/email-receipts/mailbox', payload);
    });

    it('uploads files to /import, with process=false only when asked', async () => {
      client.post.mockResolvedValue({ data: { files: [], truncated: 0, processed: 0, busy: false } });
      const file = new File(['x'], 'a.eml');
      await emailReceiptsApi.mailbox.import([file]);
      expect(client.post.mock.calls.at(-1)?.[0]).toBe('/email-receipts/mailbox/import');
      expect(client.post.mock.calls.at(-1)?.[2]).not.toHaveProperty('params');
      await emailReceiptsApi.mailbox.import([file], { process: false });
      expect(client.post.mock.calls.at(-1)?.[2]).toMatchObject({ params: { process: 'false' } });
    });

    it('changes settings with a PATCH to /settings', async () => {
      client.patch.mockResolvedValue({ data: { id: 'mb-1', enabled: false } });
      await emailReceiptsApi.mailbox.updateSettings({ enabled: false });
      expect(client.patch).toHaveBeenCalledWith('/email-receipts/mailbox/settings', { enabled: false });
    });

    it('deletes, tests and polls', async () => {
      client.delete.mockResolvedValue({});
      await emailReceiptsApi.mailbox.remove();
      expect(client.delete).toHaveBeenCalledWith('/email-receipts/mailbox');

      client.post.mockResolvedValueOnce({ data: { ok: true, messages: 3 } });
      expect(await emailReceiptsApi.mailbox.test({ host: 'h' })).toEqual({ ok: true, messages: 3 });
      expect(client.post).toHaveBeenLastCalledWith('/email-receipts/mailbox/test', { host: 'h' });

      client.post.mockResolvedValueOnce({ data: { ok: true, fetched: 1, skipped: 0, processed: 1 } });
      await emailReceiptsApi.mailbox.pollNow();
      expect(client.post).toHaveBeenLastCalledWith('/email-receipts/mailbox/poll');
    });

    it('tests the stored settings when given no draft', async () => {
      client.post.mockResolvedValue({ data: { ok: false, error: 'nope' } });
      await emailReceiptsApi.mailbox.test();
      expect(client.post).toHaveBeenCalledWith('/email-receipts/mailbox/test', {});
    });
  });

  describe('oauth', () => {
    it('lists the providers the operator configured', async () => {
      client.get.mockResolvedValue({ data: { google: true, microsoft: false, redirectUri: 'https://x/cb' } });
      expect(await emailReceiptsApi.oauth.providers()).toEqual({
        google: true,
        microsoft: false,
        redirectUri: 'https://x/cb',
      });
      expect(client.get).toHaveBeenCalledWith('/email-receipts/mailbox/oauth/providers');
    });

    it('starts, completes and disconnects', async () => {
      client.post.mockResolvedValueOnce({ data: { authorizationUrl: 'https://accounts.example/auth' } });
      expect(await emailReceiptsApi.oauth.start('google')).toEqual({ authorizationUrl: 'https://accounts.example/auth' });
      expect(client.post).toHaveBeenLastCalledWith('/email-receipts/mailbox/oauth/start', { provider: 'google' });

      client.post.mockResolvedValueOnce({ data: { id: 'mb-1' } });
      await emailReceiptsApi.oauth.complete('the-code', 'the-state');
      expect(client.post).toHaveBeenLastCalledWith('/email-receipts/mailbox/oauth/complete', {
        code: 'the-code',
        state: 'the-state',
      });

      client.delete.mockResolvedValue({});
      await emailReceiptsApi.oauth.disconnect();
      expect(client.delete).toHaveBeenCalledWith('/email-receipts/mailbox/oauth');
    });
  });

  describe('receipts', () => {
    it('reads the per-state counts from byStatus', async () => {
      client.get.mockResolvedValue({ data: { total: 3, byStatus: { review: 2, unmatched: 1 } } });
      expect(await emailReceiptsApi.receipts.getStatusCounts()).toEqual({ review: 2, unmatched: 1 });
      expect(client.get).toHaveBeenLastCalledWith('/email-receipts/status-counts');
    });

    it('counts the emails matching a state and domain from status-counts, the same answer the state buttons read', async () => {
      client.get.mockResolvedValue({ data: { total: 1234, byStatus: { no_parser: 1000, review: 234 } } });
      expect(await emailReceiptsApi.receipts.countMatching(undefined, 'gmail.com')).toBe(1234);
      expect(client.get).toHaveBeenLastCalledWith('/email-receipts/status-counts', { params: { domain: 'gmail.com' } });
      expect(await emailReceiptsApi.receipts.countMatching('no_parser')).toBe(1000);
      expect(client.get).toHaveBeenLastCalledWith('/email-receipts/status-counts', { params: undefined });
      // A state with no email is absent from byStatus: zero.
      expect(await emailReceiptsApi.receipts.countMatching('ignored', 'gmail.com')).toBe(0);
    });

    it('posts a bulk command with ids or a filter and answers the four counts', async () => {
      const result = { affected: 2, skippedLinked: 1, unchanged: 0, notIgnorable: 0 };
      client.post.mockResolvedValue({ data: result });
      expect(await emailReceiptsApi.receipts.bulk({ action: 'delete', ids: ['a', 'b'], expectedCount: 2 })).toEqual(result);
      expect(client.post).toHaveBeenLastCalledWith('/email-receipts/bulk', { action: 'delete', ids: ['a', 'b'], expectedCount: 2 });
      await emailReceiptsApi.receipts.bulk({ action: 'ignore', filter: { status: 'no_parser', domain: 'gmail.com' }, expectedCount: 9 });
      expect(client.post).toHaveBeenLastCalledWith('/email-receipts/bulk', {
        action: 'ignore',
        filter: { status: 'no_parser', domain: 'gmail.com' },
        expectedCount: 9,
      });
    });

    it('approves a proposal by the review inbox batch route and throws on a refusal', async () => {
      client.post.mockResolvedValue({ data: { results: [{ id: 'rq-1', ok: true }] } });
      await emailReceiptsApi.receipts.approveProposal('rq-1');
      expect(client.post).toHaveBeenLastCalledWith('/ai-review-requests/approve-batch', { ids: ['rq-1'] });
      client.post.mockResolvedValue({ data: { results: [{ id: 'rq-1', ok: false, error: 'refused' }] } });
      await expect(emailReceiptsApi.receipts.approveProposal('rq-1')).rejects.toThrow('refused');
    });

    it('counts a narrowed filter, reprocesses and lists the approvable proposals through the bulk routes', async () => {
      client.post.mockResolvedValueOnce({ data: { count: 7 } });
      expect(await emailReceiptsApi.receipts.bulkCount({ excludeStatuses: ['ignored'] })).toBe(7);
      expect(client.post).toHaveBeenLastCalledWith('/email-receipts/bulk/count', { filter: { excludeStatuses: ['ignored'] } });

      const step = { processed: 10, failed: 0, byOutcome: {}, remaining: 4, since: 'S' };
      client.post.mockResolvedValueOnce({ data: step });
      expect(await emailReceiptsApi.receipts.bulkReprocess({ ids: ['a'], onlyStatuses: ['ignored'], since: 'S' })).toEqual(step);
      expect(client.post).toHaveBeenLastCalledWith('/email-receipts/bulk/reprocess', {
        ids: ['a'],
        onlyStatuses: ['ignored'],
        since: 'S',
      });

      client.post.mockResolvedValueOnce({ data: { requestIds: ['rq'], trades: 1 } });
      expect(await emailReceiptsApi.receipts.bulkApprovable({ filter: { status: 'review' } })).toEqual({ requestIds: ['rq'], trades: 1 });
      expect(client.post).toHaveBeenLastCalledWith('/email-receipts/bulk/approvable', { filter: { status: 'review' } });
    });

    it('approves requests 100 to a call, counts the refused and a failed call, and drops the cache', async () => {
      const ids = Array.from({ length: 250 }, (_, n) => `rq-${n}`);
      client.post
        .mockResolvedValueOnce({ data: { results: ids.slice(0, 100).map((id) => ({ id, ok: true })) } })
        .mockRejectedValueOnce(new Error('down'))
        .mockResolvedValueOnce({
          data: { results: ids.slice(200).map((id, n) => ({ id, ok: n !== 0, error: n === 0 ? 'refused' : undefined })) },
        });
      expect(await emailReceiptsApi.receipts.approveRequests(ids)).toEqual({ approved: 149, failed: 101 });
      expect(client.post).toHaveBeenCalledTimes(3);
      expect(client.post).toHaveBeenNthCalledWith(1, '/ai-review-requests/approve-batch', { ids: ids.slice(0, 100) });
      expect(client.post).toHaveBeenNthCalledWith(2, '/ai-review-requests/approve-batch', { ids: ids.slice(100, 200) });
      expect(client.post).toHaveBeenNthCalledWith(3, '/ai-review-requests/approve-batch', { ids: ids.slice(200) });
    });

    it('lists with an optional status and limit, sending no params when there are none', async () => {
      client.get.mockResolvedValue({ data: [] });
      await emailReceiptsApi.receipts.list();
      expect(client.get).toHaveBeenLastCalledWith('/email-receipts', { params: undefined });
      await emailReceiptsApi.receipts.list('unmatched', 20);
      expect(client.get).toHaveBeenLastCalledWith('/email-receipts', { params: { status: 'unmatched', limit: 20 } });
    });

    it('sends an offset for a later page, and none for the first', async () => {
      client.get.mockResolvedValue({ data: [] });
      await emailReceiptsApi.receipts.list('review', undefined, 'shop.example.com', 100);
      expect(client.get).toHaveBeenLastCalledWith('/email-receipts', {
        params: { status: 'review', domain: 'shop.example.com', offset: 100 },
      });
      await emailReceiptsApi.receipts.list(undefined, undefined, undefined, 0);
      expect(client.get).toHaveBeenLastCalledWith('/email-receipts', { params: undefined });
    });

    it('lists with a sender domain beside the status, and reads the domain counts', async () => {
      client.get.mockResolvedValue({ data: [] });
      await emailReceiptsApi.receipts.list(undefined, undefined, 'shop.example.com');
      expect(client.get).toHaveBeenLastCalledWith('/email-receipts', { params: { domain: 'shop.example.com' } });
      await emailReceiptsApi.receipts.list('review', 10, 'shop.example.com');
      expect(client.get).toHaveBeenLastCalledWith('/email-receipts', {
        params: { status: 'review', domain: 'shop.example.com', limit: 10 },
      });
      client.get.mockResolvedValue({ data: [{ domain: 'shop.example.com', count: 3 }] });
      await expect(emailReceiptsApi.receipts.listDomains()).resolves.toEqual([{ domain: 'shop.example.com', count: 3 }]);
      expect(client.get).toHaveBeenLastCalledWith('/email-receipts/domains', { params: undefined });
      // The cloud is counted within one state.
      await emailReceiptsApi.receipts.listDomains('review');
      expect(client.get).toHaveBeenLastCalledWith('/email-receipts/domains', { params: { status: 'review' } });
    });

    it('sends only the search fields that are set, on the list, the counts and the domains', async () => {
      client.get.mockResolvedValue({ data: [] });
      await emailReceiptsApi.receipts.list('review', undefined, 'shop.example.com', 50, {
        search: 'invoice',
        searchIn: 'subject',
        dateFrom: '2026-09-01',
        dateTo: '2026-09-30',
      });
      expect(client.get).toHaveBeenLastCalledWith('/email-receipts', {
        params: {
          status: 'review',
          domain: 'shop.example.com',
          offset: 50,
          search: 'invoice',
          searchIn: 'subject',
          dateFrom: '2026-09-01',
          dateTo: '2026-09-30',
        },
      });
      // "all" and a search of nothing are not sent; a date range alone is.
      await emailReceiptsApi.receipts.list(undefined, undefined, undefined, undefined, { search: 'x', searchIn: 'all' });
      expect(client.get).toHaveBeenLastCalledWith('/email-receipts', { params: { search: 'x' } });
      await emailReceiptsApi.receipts.list(undefined, undefined, undefined, undefined, { searchIn: 'body', dateFrom: '2026-09-01' });
      expect(client.get).toHaveBeenLastCalledWith('/email-receipts', { params: { dateFrom: '2026-09-01' } });
      await emailReceiptsApi.receipts.list(undefined, undefined, undefined, undefined, {});
      expect(client.get).toHaveBeenLastCalledWith('/email-receipts', { params: undefined });

      client.get.mockResolvedValue({ data: { total: 4, byStatus: { review: 3 } } });
      expect(await emailReceiptsApi.receipts.countMatching('review', 'shop.example.com', { search: 'a', searchIn: 'sender' })).toBe(3);
      expect(client.get).toHaveBeenLastCalledWith('/email-receipts/status-counts', {
        params: { domain: 'shop.example.com', search: 'a', searchIn: 'sender' },
      });
      await emailReceiptsApi.receipts.getStatusCounts({ dateTo: '2026-09-30' });
      expect(client.get).toHaveBeenLastCalledWith('/email-receipts/status-counts', { params: { dateTo: '2026-09-30' } });

      client.get.mockResolvedValue({ data: [] });
      await emailReceiptsApi.receipts.listDomains(undefined, { search: 'a' });
      expect(client.get).toHaveBeenLastCalledWith('/email-receipts/domains', { params: { search: 'a' } });
      await emailReceiptsApi.receipts.listDomains('review', { search: 'a', searchIn: 'body' });
      expect(client.get).toHaveBeenLastCalledWith('/email-receipts/domains', {
        params: { status: 'review', search: 'a', searchIn: 'body' },
      });
    });

    it('reads the overview and processes in bulk with the run\'s own request', async () => {
      client.get.mockResolvedValue({ data: { processable: 4 } });
      await expect(emailReceiptsApi.receipts.overview()).resolves.toEqual({ processable: 4 });
      expect(client.get).toHaveBeenLastCalledWith('/email-receipts/overview');

      const answer = { processed: 2, byOutcome: { review: 2 }, failed: 0, remaining: 0, since: 'T' };
      client.post.mockResolvedValue({ data: answer });
      await expect(emailReceiptsApi.receipts.processBatch()).resolves.toEqual(answer);
      expect(client.post).toHaveBeenLastCalledWith('/email-receipts/process-batch', {});
      await emailReceiptsApi.receipts.processBatch({ domain: 'shop.example.com', since: 'T' });
      expect(client.post).toHaveBeenLastCalledWith('/email-receipts/process-batch', { domain: 'shop.example.com', since: 'T' });
    });

    it('addresses one email by id', async () => {
      client.get.mockResolvedValue({ data: { id: 'r-1' } });
      await emailReceiptsApi.receipts.get('r-1');
      expect(client.get).toHaveBeenLastCalledWith('/email-receipts/r-1');

      client.post.mockResolvedValue({ data: {} });
      await emailReceiptsApi.receipts.reprocess('r-1');
      expect(client.post).toHaveBeenLastCalledWith('/email-receipts/r-1/reprocess');
      await emailReceiptsApi.receipts.link('r-1', 'tx-1');
      expect(client.post).toHaveBeenLastCalledWith('/email-receipts/r-1/link', { transactionId: 'tx-1' });
      await emailReceiptsApi.receipts.ignore('r-1');
      expect(client.post).toHaveBeenLastCalledWith('/email-receipts/r-1/ignore');
      await emailReceiptsApi.receipts.askAi('r-1');
      expect(client.post).toHaveBeenLastCalledWith('/email-receipts/r-1/ask-ai', {});
      await emailReceiptsApi.receipts.askAi('r-1', 'tx-9');
      expect(client.post).toHaveBeenLastCalledWith('/email-receipts/r-1/ask-ai', { transactionId: 'tx-9' });
      await emailReceiptsApi.receipts.askAi('r-1', undefined, { asTrade: true });
      expect(client.post).toHaveBeenLastCalledWith('/email-receipts/r-1/ask-ai', { asTrade: true });
      // The synchronous draft route is gone: parsers are drafted through the chat.
      expect((emailReceiptsApi.receipts as Record<string, unknown>).draftParser).toBeUndefined();

      client.delete.mockResolvedValue({});
      await emailReceiptsApi.receipts.remove('r-1');
      expect(client.delete).toHaveBeenCalledWith('/email-receipts/r-1');
    });
  });

  describe('parsers', () => {
    it('queues a request to draft a parser from the named emails, calling no provider', async () => {
      client.post.mockResolvedValue({ data: { ok: true, requestId: 'req-1' } });
      await expect(emailReceiptsApi.parsers.draftWithAi(['r-1', 'r-2'])).resolves.toEqual({ ok: true, requestId: 'req-1' });
      expect(client.post).toHaveBeenLastCalledWith('/email-receipt-parsers/draft-with-ai', { receiptIds: ['r-1', 'r-2'] });
    });

    it('asks for a trade profile when the emails are trade confirmations', async () => {
      client.post.mockResolvedValue({ data: { ok: true, requestId: 'req-2' } });
      await emailReceiptsApi.parsers.draftWithAi(['r-1'], 'trade');
      expect(client.post).toHaveBeenLastCalledWith('/email-receipt-parsers/draft-with-ai', { receiptIds: ['r-1'], kind: 'trade' });
    });

    const definition = { version: 2 as const, total: ['Total {amount}'] };

    it('lists, reads, creates, updates and deletes', async () => {
      client.get.mockResolvedValue({ data: [] });
      await emailReceiptsApi.parsers.list();
      expect(client.get).toHaveBeenLastCalledWith('/email-receipt-parsers');
      await emailReceiptsApi.parsers.get('p-1');
      expect(client.get).toHaveBeenLastCalledWith('/email-receipt-parsers/p-1');

      client.post.mockResolvedValue({ data: { id: 'p-1' } });
      await emailReceiptsApi.parsers.create({ name: 'Shop', fromDomains: ['shop.example'], definition });
      expect(client.post).toHaveBeenLastCalledWith('/email-receipt-parsers', {
        name: 'Shop',
        fromDomains: ['shop.example'],
        definition,
      });

      client.patch.mockResolvedValue({ data: { id: 'p-1' } });
      await emailReceiptsApi.parsers.update('p-1', { name: 'Shop 2', expectedRevision: 3 });
      expect(client.patch).toHaveBeenCalledWith('/email-receipt-parsers/p-1', { name: 'Shop 2', expectedRevision: 3 });

      client.delete.mockResolvedValue({});
      await emailReceiptsApi.parsers.remove('p-1');
      expect(client.delete).toHaveBeenCalledWith('/email-receipt-parsers/p-1');
    });

    it('approves with the revision the person read, when there is one', async () => {
      client.post.mockResolvedValue({ data: { id: 'p-1' } });
      await emailReceiptsApi.parsers.approve('p-1', 4);
      expect(client.post).toHaveBeenLastCalledWith('/email-receipt-parsers/p-1/approve', { expectedRevision: 4 });
      await emailReceiptsApi.parsers.approve('p-1');
      expect(client.post).toHaveBeenLastCalledWith('/email-receipt-parsers/p-1/approve', {});
    });

    it('tests a definition against a stored email', async () => {
      client.post.mockResolvedValue({ data: { candidateCount: 0 } });
      await emailReceiptsApi.parsers.test({ definition, receiptId: 'r-1' });
      expect(client.post).toHaveBeenCalledWith('/email-receipt-parsers/test', { definition, receiptId: 'r-1' });
    });
  });
});
