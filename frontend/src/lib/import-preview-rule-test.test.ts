import { describe, it, expect, vi } from 'vitest';
import { createRuleTestStore } from './import-preview-rule-test';
import type { ImportPreviewRuleInput } from '@/types/import-preview';
import type { RuleRowExplanation } from '@/types/transaction-rule-explain';

const input = (over: Partial<ImportPreviewRuleInput> = {}): ImportPreviewRuleInput => ({
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
  ...over,
});
const explanation = (): RuleRowExplanation => ({
  rules: [],
  labels: { accounts: {}, payees: {}, categories: {}, tags: {} },
});

/** A load that the test settles by hand. */
function deferred() {
  const calls: Array<{
    input: ImportPreviewRuleInput;
    resolve: (value: RuleRowExplanation) => void;
    reject: (error: unknown) => void;
  }> = [];
  const load = vi.fn(
    (value: ImportPreviewRuleInput) =>
      new Promise<RuleRowExplanation>((resolve, reject) => {
        calls.push({ input: value, resolve, reject });
      }),
  );
  return { load, calls };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('createRuleTestStore', () => {
  it('has nothing for a row nobody asked about', () => {
    expect(createRuleTestStore(vi.fn()).get('r1')).toBeUndefined();
  });

  it('goes from loading to ready and tells its listeners each time', async () => {
    const { load, calls } = deferred();
    const store = createRuleTestStore(load);
    const listener = vi.fn();
    store.subscribe(listener);

    store.request('r1', input());
    expect(store.get('r1')).toEqual({ status: 'loading' });
    expect(listener).toHaveBeenCalledTimes(1);

    const answer = explanation();
    calls[0].resolve(answer);
    await flush();
    expect(store.get('r1')).toEqual({ status: 'ready', explanation: answer });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('keeps the same state object until it changes, for a snapshot that must be stable', async () => {
    const { load, calls } = deferred();
    const store = createRuleTestStore(load);
    store.request('r1', input());
    const loading = store.get('r1');
    expect(store.get('r1')).toBe(loading);
    calls[0].resolve(explanation());
    await flush();
    const ready = store.get('r1');
    expect(ready).not.toBe(loading);
    expect(store.get('r1')).toBe(ready);
  });

  it('fetches each row once: asking again while loading or after the answer is a no-op', async () => {
    const { load, calls } = deferred();
    const store = createRuleTestStore(load);
    store.request('r1', input());
    store.request('r1', input());
    expect(load).toHaveBeenCalledTimes(1);
    calls[0].resolve(explanation());
    await flush();
    store.request('r1', input());
    store.request('r1', input(), { retry: true });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('keeps rows apart', async () => {
    const { load, calls } = deferred();
    const store = createRuleTestStore(load);
    store.request('r1', input({ payeeText: 'A' }));
    store.request('r2', input({ payeeText: 'B' }));
    expect(load).toHaveBeenCalledTimes(2);
    calls[1].resolve(explanation());
    await flush();
    expect(store.get('r1')).toEqual({ status: 'loading' });
    expect(store.get('r2')?.status).toBe('ready');
  });

  it('records a failure as an error, not as an empty result, and leaves it until a retry is asked for', async () => {
    const { load, calls } = deferred();
    const store = createRuleTestStore(load);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    store.request('r1', input());
    calls[0].reject(new Error('boom'));
    await flush();
    expect(store.get('r1')).toEqual({ status: 'error' });

    store.request('r1', input());
    expect(load).toHaveBeenCalledTimes(1);
    expect(store.get('r1')).toEqual({ status: 'error' });

    store.request('r1', input(), { retry: true });
    expect(load).toHaveBeenCalledTimes(2);
    expect(store.get('r1')).toEqual({ status: 'loading' });
    calls[1].resolve(explanation());
    await flush();
    expect(store.get('r1')?.status).toBe('ready');
  });

  it('treats the same row with another input as a new question and drops the answer to the old one', async () => {
    const { load, calls } = deferred();
    const store = createRuleTestStore(load);
    store.request('r1', input({ payeeText: 'old' }));
    store.request('r1', input({ payeeText: 'new' }));
    expect(load).toHaveBeenCalledTimes(2);

    // The old request answers last: it must not overwrite the new question.
    const newer = explanation();
    calls[1].resolve(newer);
    await flush();
    calls[0].resolve({ ...explanation(), rules: [{} as never] });
    await flush();
    expect(store.get('r1')).toEqual({ status: 'ready', explanation: newer });
  });

  it('stops telling a listener that unsubscribed', async () => {
    const { load, calls } = deferred();
    const store = createRuleTestStore(load);
    const listener = vi.fn();
    const off = store.subscribe(listener);
    off();
    store.request('r1', input());
    calls[0].resolve(explanation());
    await flush();
    expect(listener).not.toHaveBeenCalled();
  });
});
