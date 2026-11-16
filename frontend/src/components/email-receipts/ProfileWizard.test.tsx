import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, within } from '@/test/render';
import { ProfileWizard } from './ProfileWizard';
import { WIZARD_WAIT_POLL_MS } from './WizardWaitingStep';
import { makeDetail, makeReceipt } from './email-receipts-fixtures';

const api = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  listUncovered: vi.fn(),
  getParser: vi.fn(),
  processBatch: vi.fn(),
  generateWithAi: vi.fn(),
  preview: vi.fn(),
  approve: vi.fn(),
}));
const txApi = vi.hoisted(() => ({ getAll: vi.fn() }));
vi.mock('@/lib/email-receipts-api', () => ({
  emailReceiptsApi: {
    receipts: { list: api.list, get: api.get, listUncovered: api.listUncovered, processBatch: api.processBatch },
    parsers: { generateWithAi: api.generateWithAi, preview: api.preview, approve: api.approve, get: api.getParser },
  },
}));
vi.mock('@/lib/transactions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/transactions')>()),
  transactionsApi: txApi,
}));
vi.mock('@/lib/apiCache', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/apiCache')>()),
  clearAllCache: vi.fn(),
}));
vi.mock('@/lib/aiActionSignal', () => ({ notifyAiAction: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

const emptyPreview = { selected: [], others: [], othersTotal: 0 };

async function click(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element);
  });
  await act(async () => {});
}

async function renderWizard() {
  const props = { domain: 'allegro.pl', onClose: vi.fn(), onFinished: vi.fn() };
  await act(async () => {
    render(<ProfileWizard {...props} />);
  });
  await act(async () => {});
  return props;
}

/** Choose the one transaction the picker lists for the first email, and tick it. */
async function pickFirstSample() {
  await click(screen.getByText('Order 1'));
  await click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Use this transaction' }));
  await click(screen.getByRole('checkbox', { name: 'Use the email Order 1 as a sample' }));
}

describe('ProfileWizard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.get.mockResolvedValue(makeDetail({ id: 'r-1' }));
    api.list.mockResolvedValue([makeReceipt({ id: 'r-1', subject: 'Order 1' }), makeReceipt({ id: 'r-2', subject: 'Order 2' })]);
    api.listUncovered.mockResolvedValue([{ domain: 'allegro.pl', count: 2, draftParserId: null }]);
    api.preview.mockResolvedValue(emptyPreview);
    txApi.getAll.mockResolvedValue({
      data: [{ id: 'tx-9', transactionDate: '2026-09-02', payeeName: 'Allegro', amount: '-25.0000', currencyCode: 'USD', description: null, isTransfer: false, isVoid: false }],
      pagination: { page: 1, limit: 50, total: 1, totalPages: 1, hasMore: false },
    });
  });

  it('starts at the samples of the domain, marks the step, and offers no draft when there is none', async () => {
    await renderWizard();
    expect(screen.getByRole('heading', { name: 'Create a profile for allegro.pl' })).toBeInTheDocument();
    expect(screen.getByText('1. Samples')).toHaveAttribute('aria-current', 'step');
    expect(screen.queryByRole('button', { name: 'Start at the preview with the draft' })).not.toBeInTheDocument();
  });

  it('walks samples, generate and preview, then accepts and processes the domain', async () => {
    api.generateWithAi.mockResolvedValue({ parserId: 'p-1', revision: 2, answer: 'Draft saved' });
    api.approve.mockResolvedValue({});
    api.processBatch.mockResolvedValue({ processed: 2, byOutcome: { review: 2 }, failed: 0, remaining: 0, since: 'T' });
    const props = await renderWizard();
    await pickFirstSample();
    await click(screen.getByRole('button', { name: 'Continue to the assistant' }));
    expect(screen.getByText('2. Generate')).toHaveAttribute('aria-current', 'step');

    await click(screen.getByRole('button', { name: 'Send to AI' }));
    expect(api.generateWithAi).toHaveBeenCalledWith({ domain: 'allegro.pl', samples: [{ receiptId: 'r-1', transactionId: 'tx-9' }] });
    expect(screen.getByText('3. Preview and accept')).toHaveAttribute('aria-current', 'step');
    expect(api.preview).toHaveBeenCalledWith('p-1', {
      selectedReceiptIds: ['r-1'],
      expected: [{ receiptId: 'r-1', transactionId: 'tx-9' }],
    });
    expect(screen.getByText('Draft saved')).toBeInTheDocument();

    await click(screen.getByRole('button', { name: 'Accept and process' }));
    expect(api.approve).toHaveBeenCalledWith('p-1', 2);
    expect(api.processBatch).toHaveBeenCalledWith({ domain: 'allegro.pl' });
    expect(props.onFinished).toHaveBeenCalledTimes(1);
    await click(screen.getByRole('button', { name: 'Done' }));
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('sends the draft back to the AI with a note, then previews the revised draft', async () => {
    api.generateWithAi
      .mockResolvedValueOnce({ parserId: 'p-1', revision: 2, answer: 'first' })
      .mockResolvedValueOnce({ parserId: 'p-1', revision: 3, answer: 'second' });
    await renderWizard();
    await pickFirstSample();
    await click(screen.getByRole('button', { name: 'Continue to the assistant' }));
    await click(screen.getByRole('button', { name: 'Send to AI' }));

    await click(screen.getByRole('button', { name: 'Back to AI' }));
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Requested Changes'), { target: { value: 'Use the paid line' } });
    });
    await click(screen.getByRole('button', { name: 'Send note to AI' }));
    expect(api.generateWithAi).toHaveBeenLastCalledWith({
      domain: 'allegro.pl',
      samples: [{ receiptId: 'r-1', transactionId: 'tx-9' }],
      parserId: 'p-1',
      feedback: 'Use the paid line',
    });
    expect(api.preview).toHaveBeenCalledTimes(2);
    expect(screen.getByText('second')).toBeInTheDocument();
  });

  it('goes back to the samples from the preview and keeps the pairs', async () => {
    api.generateWithAi.mockResolvedValue({ parserId: 'p-1', revision: 2, answer: '' });
    await renderWizard();
    await pickFirstSample();
    await click(screen.getByRole('button', { name: 'Continue to the assistant' }));
    await click(screen.getByRole('button', { name: 'Send to AI' }));
    await click(screen.getByRole('button', { name: 'Back to samples' }));
    expect(screen.getByRole('checkbox', { name: 'Use the email Order 1 as a sample' })).toBeChecked();
  });

  it('offers to start at the preview with the draft the domain already has', async () => {
    api.listUncovered.mockResolvedValue([{ domain: 'allegro.pl', count: 2, draftParserId: 'p-7' }]);
    await renderWizard();
    await click(screen.getByRole('button', { name: 'Start at the preview with the draft' }));
    expect(api.preview).toHaveBeenCalledWith('p-7', { selectedReceiptIds: [] });
    expect(screen.getByText('3. Preview and accept')).toHaveAttribute('aria-current', 'step');
    expect(screen.queryByRole('button', { name: 'Back to AI' })).not.toBeInTheDocument();
  });

  describe('when the user\'s own agent writes the profile', () => {
    const waitingEntry = { domain: 'allegro.pl', count: 2, draftParserId: null, pendingRequestId: 'req-1', pendingRequestStatus: 'pending' };

    afterEach(() => {
      vi.useRealTimers();
    });

    it('shows the wait with the inbox link after the request is queued, and moves to the preview when the draft arrives', async () => {
      vi.useFakeTimers();
      api.generateWithAi.mockResolvedValue({ status: 'queued', requestId: 'req-1' });
      await renderWizard();
      await pickFirstSample();
      await click(screen.getByRole('button', { name: 'Continue to the assistant' }));
      await click(screen.getByRole('button', { name: 'Send to AI' }));

      expect(screen.getByRole('status')).toHaveTextContent('Sent to the AI inbox.');
      expect(screen.getByRole('link', { name: 'Open the AI inbox' })).toHaveAttribute('href', '/ai-reviews');
      expect(screen.queryByRole('button', { name: 'Send to AI' })).not.toBeInTheDocument();
      expect(api.preview).not.toHaveBeenCalled();

      api.listUncovered.mockResolvedValue([{ ...waitingEntry, draftParserId: 'p-5', pendingRequestId: null, pendingRequestStatus: null }]);
      api.getParser.mockResolvedValue({ id: 'p-5', revision: 1 });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(WIZARD_WAIT_POLL_MS);
      });
      await act(async () => {});
      expect(api.preview).toHaveBeenCalledWith('p-5', { selectedReceiptIds: ['r-1'], expected: [{ receiptId: 'r-1', transactionId: 'tx-9' }] });
      expect(screen.getByText('3. Preview and accept')).toHaveAttribute('aria-current', 'step');
    });

    it('opens on the wait, not step 1, for a domain that already has a request in the inbox', async () => {
      api.listUncovered.mockResolvedValue([waitingEntry]);
      await renderWizard();
      expect(screen.getByRole('status')).toHaveTextContent('Waiting for your AI agent');
      expect(screen.getByText('2. Generate')).toHaveAttribute('aria-current', 'step');
      expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    });

    it('starts over from the wait at the samples', async () => {
      api.listUncovered.mockResolvedValue([waitingEntry]);
      await renderWizard();
      await click(screen.getByRole('button', { name: 'Start over' }));
      expect(screen.getByText('1. Samples')).toHaveAttribute('aria-current', 'step');
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
    });
  });

  it('closes on Cancel', async () => {
    const props = await renderWizard();
    await click(screen.getByRole('button', { name: 'Cancel' }));
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  describe('trade confirmations', () => {
    it('writes a trade profile from emails alone: no transaction is chosen, and the request is a trade one', async () => {
      api.generateWithAi.mockResolvedValue({ status: 'saved', parserId: 'p-1', revision: 1, answer: 'Done' });
      await renderWizard();
      await click(screen.getByRole('checkbox', { name: /brokerage trade confirmations/ }));
      await click(screen.getByRole('checkbox', { name: 'Use the email Order 1 as a sample' }));
      await click(screen.getByRole('button', { name: 'Continue to the assistant' }));
      expect(screen.getByText('Order 1')).toBeInTheDocument();
      expect(screen.getByText('Trade confirmation')).toBeInTheDocument();
      await click(screen.getByRole('button', { name: 'Send to AI' }));
      expect(api.generateWithAi).toHaveBeenCalledWith({ domain: 'allegro.pl', kind: 'trade', tradeReceiptIds: ['r-1'] });
      // The preview then names the ticked emails, though none has a transaction to pair.
      expect(api.preview).toHaveBeenCalledWith('p-1', { selectedReceiptIds: ['r-1'] });
    });

    it('forgets the ticked emails when the kind changes, so a receipt sample is never sent as a trade', async () => {
      await renderWizard();
      await click(screen.getByRole('checkbox', { name: /brokerage trade confirmations/ }));
      await click(screen.getByRole('checkbox', { name: 'Use the email Order 1 as a sample' }));
      expect(screen.getByText('1 of 5 samples ticked')).toBeInTheDocument();
      await click(screen.getByRole('checkbox', { name: /brokerage trade confirmations/ }));
      expect(screen.getByText('0 of 5 samples ticked')).toBeInTheDocument();
    });
  });
});
