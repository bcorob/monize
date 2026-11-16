import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AxiosError } from 'axios';
import toast from 'react-hot-toast';
import { render, screen, fireEvent, act, within } from '@/test/render';
import { WizardPreviewStep } from './WizardPreviewStep';
import type { ParserPreviewItem, ParserPreviewResult } from '@/types/email-receipts';

const api = vi.hoisted(() => ({ preview: vi.fn(), approve: vi.fn(), processBatch: vi.fn() }));
const accountsApi = vi.hoisted(() => ({ getAll: vi.fn() }));
vi.mock('@/lib/accounts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/accounts')>()),
  accountsApi,
}));
vi.mock('@/lib/email-receipts-api', () => ({
  emailReceiptsApi: { parsers: { preview: api.preview, approve: api.approve }, receipts: { processBatch: api.processBatch } },
}));
vi.mock('@/lib/apiCache', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/apiCache')>()),
  clearAllCache: vi.fn(),
}));
vi.mock('@/lib/aiActionSignal', () => ({ notifyAiAction: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

const item = (over: Partial<ParserPreviewItem> = {}): ParserPreviewItem => ({
  receiptId: 'r-1',
  subject: 'Order 1',
  receivedAt: '2026-09-01T10:00:00.000Z',
  effectiveDate: '2026-09-01T10:00:00.000Z',
  outcome: 'matched',
  statusReason: null,
  trade: null,
  parsed: { date: '2026-09-01', total: 25, currency: 'USD', lineCount: 2 },
  match: null,
  expected: { transactionId: 'tx-1', summary: 'Sep 1, 25.00, Allegro' },
  agrees: true,
  ...over,
});

const result = (over: Partial<ParserPreviewResult> = {}): ParserPreviewResult => ({
  selected: [item(), item({ receiptId: 'r-2', subject: 'Order 2', agrees: false })],
  others: [
    item({
      receiptId: 'r-3',
      subject: 'Other order',
      outcome: 'unmatched',
      statusReason: 'no_total',
      expected: null,
      agrees: null,
      match: { transactionId: 'tx-7', summary: 'Sep 3, 12.00, Allegro' },
    }),
  ],
  othersTotal: 1,
  ...over,
});

const pairs = [{ receiptId: 'r-1', transactionId: 'tx-1' }, { receiptId: 'r-2', transactionId: 'tx-2' }];

function props(over: Partial<React.ComponentProps<typeof WizardPreviewStep>> = {}) {
  return {
    domain: 'allegro.pl',
    draft: { parserId: 'p-1', revision: 3 },
    kind: 'receipt' as const,
    answer: null,
    pairs,
    canReviseWithAi: true,
    onBackToAi: vi.fn(),
    onBackToSamples: vi.fn(),
    onAccepted: vi.fn(),
    onClose: vi.fn(),
    ...over,
  };
}

async function renderStep(p = props()) {
  await act(async () => {
    render(<WizardPreviewStep {...p} />);
  });
  await act(async () => {});
  return p;
}

async function click(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element);
  });
  await act(async () => {});
}

describe('WizardPreviewStep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.preview.mockResolvedValue(result());
    accountsApi.getAll.mockResolvedValue([]);
  });

  it('previews the draft over the selected samples with what was expected', async () => {
    await renderStep();
    expect(api.preview).toHaveBeenCalledWith('p-1', { selectedReceiptIds: ['r-1', 'r-2'], expected: pairs });
  });

  it('reads no accounts for a receipt profile', async () => {
    await renderStep();
    expect(accountsApi.getAll).not.toHaveBeenCalled();
  });

  it('shows a trade sample with the trade columns and the account it books to, by name and currency', async () => {
    accountsApi.getAll.mockResolvedValue([{ id: 'acc-usd', name: 'RRSP', currencyCode: 'USD' }]);
    api.preview.mockResolvedValue(
      result({
        selected: [
          item({
            outcome: 'trade',
            expected: null,
            agrees: null,
            trade: { action: 'BUY', symbol: 'VTI', quantity: 3, consistent: true, accountId: 'acc-usd', currency: 'USD' },
          }),
          // A guard stopped this one: no trade, and still a trade sample.
          item({ receiptId: 'r-2', subject: 'Order 2', outcome: 'not_applicable', expected: null, agrees: null, trade: null, parsed: null }),
        ],
        others: [],
        othersTotal: 0,
      }),
    );
    await renderStep(props({ kind: 'trade', pairs: [], selectedReceiptIds: ['r-1', 'r-2'] }));
    expect(accountsApi.getAll).toHaveBeenCalledWith(true);
    expect(screen.queryByRole('columnheader', { name: 'Agrees' })).not.toBeInTheDocument();
    expect(screen.getByText('Account: RRSP (USD)')).toBeInTheDocument();
  });

  it('shows the selected emails with expected against parsed, and whether they agree', async () => {
    await renderStep();
    const selected = screen.getByRole('region', { name: 'Selected emails' });
    const first = within(selected).getByRole('row', { name: /Order 1/ });
    expect(first).toHaveTextContent('Sep 1, 25.00, Allegro');
    // The server sends the total in money units.
    expect(first).toHaveTextContent('25.00');
    expect(within(first).getByText('Yes')).toBeInTheDocument();
    expect(within(within(selected).getByRole('row', { name: /Order 2/ })).getByText('No')).toBeInTheDocument();
  });

  it('shows the other emails with outcome, what was read and the transaction it would match', async () => {
    await renderStep();
    const others = screen.getByRole('region', { name: 'Other emails from this domain' });
    const row = within(others).getByRole('row', { name: /Other order/ });
    expect(row).toHaveTextContent('No transaction matched');
    expect(row).toHaveTextContent('The email states no total.');
    expect(row).toHaveTextContent('Sep 3, 12.00, Allegro');
    expect(within(others).queryByText(/Showing the newest/)).not.toBeInTheDocument();
  });

  it('dates each email by when the shop sent it, not when it was forwarded', async () => {
    const forwarded = item({ receivedAt: '2026-09-20T10:00:00.000Z', effectiveDate: '2026-08-05T10:00:00.000Z' });
    api.preview.mockResolvedValue(result({ selected: [forwarded], others: [] }));
    await renderStep();
    const row = screen.getByRole('row', { name: /Order 1/ });
    expect(row).toHaveTextContent(/2026-08-05|08\/05\/2026|05\/08\/2026|Aug/);
    expect(row).not.toHaveTextContent(/2026-09-20|09\/20\/2026|20\/09\/2026|Sep 20/);
  });

  it('says when the other emails are capped', async () => {
    api.preview.mockResolvedValue(result({ othersTotal: 340 }));
    await renderStep();
    expect(screen.getByText('Showing the newest 1 of 340 other emails.')).toBeInTheDocument();
  });

  it('leaves out the second table when the domain has no other emails', async () => {
    api.preview.mockResolvedValue(result({ others: [], othersTotal: 0 }));
    await renderStep();
    expect(screen.queryByRole('region', { name: 'Other emails from this domain' })).not.toBeInTheDocument();
  });

  it('shows a total with no currency as a bare number and a missing one as not stated', async () => {
    api.preview.mockResolvedValue(
      result({
        selected: [
          item({ parsed: { date: null, total: 25, currency: null, lineCount: 0 } }),
          item({ receiptId: 'r-2', subject: 'Order 2', parsed: { date: '2026-09-01', total: null, currency: 'USD', lineCount: 1 } }),
          item({ receiptId: 'r-4', subject: 'Order 4', parsed: null }),
        ],
        others: [],
      }),
    );
    await renderStep();
    expect(screen.getByRole('row', { name: /Order 2/ })).toHaveTextContent('Total: not stated');
    expect(screen.getByRole('row', { name: /Order 4/ })).toHaveTextContent('Nothing could be read');
    expect(screen.getAllByText('Date: not stated')).toHaveLength(1);
  });

  it('previews an existing draft with no samples', async () => {
    await renderStep(props({ pairs: [], draft: { parserId: 'p-5', revision: null }, canReviseWithAi: false }));
    expect(api.preview).toHaveBeenCalledWith('p-5', { selectedReceiptIds: [] });
    expect(screen.queryByRole('button', { name: 'Back to AI' })).not.toBeInTheDocument();
  });

  it('shows the assistant\'s answer', async () => {
    await renderStep(props({ answer: 'I used the Amount paid line.' }));
    expect(screen.getByText('I used the Amount paid line.')).toBeInTheDocument();
  });

  it('offers the way back to the AI and to the samples', async () => {
    const p = await renderStep();
    await click(screen.getByRole('button', { name: 'Back to AI' }));
    await click(screen.getByRole('button', { name: 'Back to samples' }));
    expect(p.onBackToAi).toHaveBeenCalledTimes(1);
    expect(p.onBackToSamples).toHaveBeenCalledTimes(1);
  });

  it('accepts: approves at the draft\'s revision, then processes the domain and reports the outcome', async () => {
    api.approve.mockResolvedValue({});
    api.processBatch.mockResolvedValue({ processed: 4, byOutcome: { review: 3, unmatched: 1 }, failed: 0, remaining: 0, since: 'T' });
    const p = await renderStep();
    await click(screen.getByRole('button', { name: 'Accept and process' }));
    expect(api.approve).toHaveBeenCalledWith('p-1', 3);
    expect(api.processBatch).toHaveBeenCalledWith({ domain: 'allegro.pl' });
    expect(p.onAccepted).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status')).toHaveTextContent('4 emails processed.');
    await click(screen.getByRole('button', { name: 'Done' }));
    expect(p.onClose).toHaveBeenCalledTimes(1);
  });

  it('approves an existing draft without a revision to check', async () => {
    api.approve.mockResolvedValue({});
    api.processBatch.mockResolvedValue({ processed: 0, byOutcome: {}, failed: 0, remaining: 0, since: 'T' });
    await renderStep(props({ pairs: [], draft: { parserId: 'p-5', revision: null }, canReviseWithAi: false }));
    await click(screen.getByRole('button', { name: 'Accept and process' }));
    expect(api.approve).toHaveBeenCalledWith('p-5', undefined);
  });

  it('processes nothing when the approval is refused because the draft moved on', async () => {
    api.approve.mockRejectedValue(new AxiosError('conflict', '409', undefined, undefined, { status: 409, data: {} } as never));
    const p = await renderStep();
    await click(screen.getByRole('button', { name: 'Accept and process' }));
    expect(toast.error).toHaveBeenCalledWith('The profile changed elsewhere. Reload the preview.');
    expect(api.processBatch).not.toHaveBeenCalled();
    expect(p.onAccepted).not.toHaveBeenCalled();
  });

  it('cannot be accepted until the preview has loaded, and a failed preview says so', async () => {
    api.preview.mockRejectedValueOnce(new Error('down'));
    await renderStep();
    expect(screen.getByRole('alert')).toHaveTextContent('The preview could not be run.');
    expect(screen.getByRole('button', { name: 'Accept and process' })).toBeDisabled();
    await click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByRole('button', { name: 'Accept and process' })).toBeEnabled();
  });
});
