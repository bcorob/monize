import { describe, it, expect, vi, beforeEach } from 'vitest';
import apiClient from './api';
import { invalidateTransactionRulesCache, transactionRulesApi } from './transaction-rules-api';
import { invalidateCache } from './apiCache';

const cacheSpy = vi.hoisted(() => ({ clearAllCache: vi.fn() }));
vi.mock('./apiCache', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./apiCache')>()),
  clearAllCache: cacheSpy.clearAllCache,
}));

vi.mock('./api', () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

const definition = {
  name: 'Coffee',
  triggers: ['create' as const],
  condition: { all: [] },
  actions: [{ type: 'add_tags' as const, tagIds: ['t-1'] }],
};

describe('transactionRulesApi', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateCache('transaction-rules:');
  });

  it('getAll fetches /transaction-rules and caches the list', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [{ id: 'r-1' }] });
    const first = await transactionRulesApi.getAll();
    await transactionRulesApi.getAll();
    expect(apiClient.get).toHaveBeenCalledWith('/transaction-rules');
    expect(apiClient.get).toHaveBeenCalledTimes(1);
    expect(first).toHaveLength(1);
  });

  it('invalidateTransactionRulesCache drops the cached list for a write made elsewhere', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [{ id: 'r-1' }] });
    await transactionRulesApi.getAll();
    invalidateTransactionRulesCache();
    await transactionRulesApi.getAll();
    expect(apiClient.get).toHaveBeenCalledTimes(2);
  });

  it('getById is never cached', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: { id: 'r-1' } });
    await transactionRulesApi.getById('r-1');
    await transactionRulesApi.getById('r-1');
    expect(apiClient.get).toHaveBeenCalledWith('/transaction-rules/r-1');
    expect(apiClient.get).toHaveBeenCalledTimes(2);
  });

  it('create posts the definition and drops the cached list', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [] });
    vi.mocked(apiClient.post).mockResolvedValue({ data: { id: 'r-2' } });
    await transactionRulesApi.getAll();
    const created = await transactionRulesApi.create(definition);
    await transactionRulesApi.getAll();
    expect(apiClient.post).toHaveBeenCalledWith('/transaction-rules', definition);
    expect(created.id).toBe('r-2');
    expect(apiClient.get).toHaveBeenCalledTimes(2);
  });

  it('update patches the rule with its revision', async () => {
    vi.mocked(apiClient.patch).mockResolvedValue({ data: { id: 'r-1' } });
    await transactionRulesApi.update('r-1', { name: 'New', revision: 3 });
    expect(apiClient.patch).toHaveBeenCalledWith('/transaction-rules/r-1', {
      name: 'New',
      revision: 3,
    });
  });

  it('setEnabled patches /enabled', async () => {
    vi.mocked(apiClient.patch).mockResolvedValue({ data: { id: 'r-1', enabled: false } });
    const rule = await transactionRulesApi.setEnabled('r-1', false);
    expect(apiClient.patch).toHaveBeenCalledWith('/transaction-rules/r-1/enabled', {
      enabled: false,
    });
    expect(rule.enabled).toBe(false);
  });

  it('reorder puts the full id list', async () => {
    vi.mocked(apiClient.put).mockResolvedValue({ data: [{ id: 'b' }, { id: 'a' }] });
    const rules = await transactionRulesApi.reorder(['b', 'a']);
    expect(apiClient.put).toHaveBeenCalledWith('/transaction-rules/reorder', { ids: ['b', 'a'] });
    expect(rules.map((r) => r.id)).toEqual(['b', 'a']);
  });

  it('delete calls DELETE /transaction-rules/:id', async () => {
    vi.mocked(apiClient.delete).mockResolvedValue({});
    await transactionRulesApi.delete('r-1');
    expect(apiClient.delete).toHaveBeenCalledWith('/transaction-rules/r-1');
  });

  it('drops the cached list even when a write is refused', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [] });
    vi.mocked(apiClient.put).mockRejectedValue(new Error('409'));
    await transactionRulesApi.getAll();
    await expect(transactionRulesApi.reorder(['a'])).rejects.toThrow('409');
    await transactionRulesApi.getAll();
    expect(apiClient.get).toHaveBeenCalledTimes(2);
  });

  describe('testing and running', () => {
    const filters = { accountIds: ['a-1'], startDate: '2026-01-01', limit: 50 };

    it('previewDraft posts the unsaved rule and filters', async () => {
      vi.mocked(apiClient.post).mockResolvedValue({ data: { matched: [], fingerprint: 'f' } });
      const body = { condition: { all: [] }, actions: definition.actions, filters };
      const preview = await transactionRulesApi.previewDraft(body);
      expect(apiClient.post).toHaveBeenCalledWith('/transaction-rules/preview-draft', body);
      expect(preview.fingerprint).toBe('f');
    });

    it('matchDraft posts the condition, the window and the page', async () => {
      const answer = { data: [], pagination: { page: 2, limit: 10, total: 0, totalPages: 0, hasMore: false }, scanned: 0, truncated: false };
      vi.mocked(apiClient.post).mockResolvedValue({ data: answer });
      const body = { condition: { all: [] }, activeFrom: '2026-10-01', page: 2, limit: 10 };
      await expect(transactionRulesApi.matchDraft(body)).resolves.toEqual(answer);
      expect(apiClient.post).toHaveBeenCalledWith('/transaction-rules/match-draft', body);
    });

    it('explainRow posts the row and the trigger, caches nothing and drops no cache', async () => {
      const answer = { rules: [], labels: { accounts: {}, payees: {}, categories: {}, tags: {} } };
      vi.mocked(apiClient.post).mockResolvedValue({ data: answer });
      const input = {
        accountId: 'a-1',
        currencyCode: 'PLN',
        amount: '-1.0000',
        isTransfer: false,
        payeeId: null,
        payeeText: 'Shop',
        categoryId: null,
        description: null,
        tagIds: [],
        hasSplits: false,
      };
      const first = await transactionRulesApi.explainRow({ trigger: 'import', input });
      await transactionRulesApi.explainRow({ trigger: 'import', input });
      expect(apiClient.post).toHaveBeenCalledWith('/transaction-rules/explain-row', { trigger: 'import', input });
      expect(apiClient.post).toHaveBeenCalledTimes(2);
      expect(first).toBe(answer);
      expect(cacheSpy.clearAllCache).not.toHaveBeenCalled();
    });

    it('previewRun posts the filters to the rule', async () => {
      vi.mocked(apiClient.post).mockResolvedValue({ data: { matched: [] } });
      await transactionRulesApi.previewRun('r-1', filters);
      expect(apiClient.post).toHaveBeenCalledWith('/transaction-rules/r-1/preview-run', filters);
    });

    it('run sends the filters with the fingerprint and drops every cache once it succeeded', async () => {
      vi.mocked(apiClient.post).mockResolvedValue({ data: { changed: 2, skipped: [], historyId: 'h-1' } });
      const result = await transactionRulesApi.run('r-1', filters, 'abc');
      expect(apiClient.post).toHaveBeenCalledWith('/transaction-rules/r-1/run', { ...filters, fingerprint: 'abc' });
      expect(result.changed).toBe(2);
      expect(cacheSpy.clearAllCache).toHaveBeenCalledTimes(1);
    });

    it('run keeps the cache when the server refuses, because nothing was written', async () => {
      vi.mocked(apiClient.post).mockRejectedValue(new Error('409'));
      await expect(transactionRulesApi.run('r-1', filters, 'abc')).rejects.toThrow('409');
      expect(cacheSpy.clearAllCache).not.toHaveBeenCalled();
    });

    it('getApplications is never cached and passes the limit only when given', async () => {
      vi.mocked(apiClient.get).mockResolvedValue({ data: [] });
      await transactionRulesApi.getApplications('r-1');
      await transactionRulesApi.getApplications('r-1', 20);
      expect(apiClient.get).toHaveBeenNthCalledWith(1, '/transaction-rules/r-1/applications', { params: undefined });
      expect(apiClient.get).toHaveBeenNthCalledWith(2, '/transaction-rules/r-1/applications', { params: { limit: 20 } });
    });
  });
});
