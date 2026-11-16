import { describe, expect, it, vi, beforeEach } from 'vitest';
import { AxiosError } from 'axios';
import toast from 'react-hot-toast';
import { act, fireEvent, render, screen } from '@/test/render';
import { RunRuleDialog } from './RunRuleDialog';
import { ACCOUNT_ID, JOINT_ACCOUNT_ID, lookupFixtures, makePreview } from './rules-test-fixtures';

Element.prototype.scrollIntoView = vi.fn();

const mocks = vi.hoisted(() => ({
  rules: { previewRun: vi.fn(), run: vi.fn() },
  accounts: vi.fn(),
  notify: vi.fn(),
}));

vi.mock('@/lib/transaction-rules-api', () => ({
  transactionRulesApi: mocks.rules,
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));
vi.mock('@/lib/accounts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/accounts')>()),
  accountsApi: { getAll: (...args: unknown[]) => mocks.accounts(...args) },
}));
vi.mock('@/lib/undoRedoSignal', () => ({
  notifyUndoRedo: mocks.notify,
  subscribeUndoRedo: () => () => {},
}));

const rule = { id: 'rule-1', name: 'Coffee shops' };
const onClose = vi.fn();
const FP = 'a'.repeat(64);
const NEW_FP = 'b'.repeat(64);

function refused(status: number, data: unknown): AxiosError {
  const error = new AxiosError('failed');
  error.response = { status, data } as AxiosError['response'];
  return error;
}

async function renderDialog(props: Partial<Parameters<typeof RunRuleDialog>[0]> = {}) {
  let result!: ReturnType<typeof render>;
  await act(async () => {
    result = render(<RunRuleDialog rule={rule} onClose={onClose} {...props} />);
  });
  return result;
}

const button = (name: string) => screen.getByRole('button', { name });

async function preview() {
  await act(async () => {
    fireEvent.click(button('Preview'));
  });
}

async function confirm() {
  await act(async () => {
    fireEvent.click(button('Confirm and run'));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.accounts.mockResolvedValue(lookupFixtures.accounts);
  mocks.rules.previewRun.mockResolvedValue(makePreview({ fingerprint: FP }));
});

describe('RunRuleDialog', () => {
  it('renders nothing while there is no rule', async () => {
    await renderDialog({ rule: null });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(mocks.accounts).not.toHaveBeenCalled();
  });

  it('opens with the rule named, the filters and nothing to confirm yet', async () => {
    await renderDialog();
    expect(
      screen.getByRole('dialog', {
        name: 'Run "Coffee shops" on existing transactions',
      }),
    ).toBeInTheDocument();
    expect(mocks.accounts).toHaveBeenCalledWith(true);
    expect(screen.getByText(/Nothing changes until you confirm/)).toBeInTheDocument();
    expect(button('Confirm and run')).toBeDisabled();
    expect(mocks.rules.previewRun).not.toHaveBeenCalled();
  });

  it('offers only the caller\'s own accounts when it loads them itself', async () => {
    await renderDialog();
    fireEvent.click(screen.getByText('All accounts'));
    expect(screen.getByLabelText('Chequing (CAD)')).toBeInTheDocument();
    expect(screen.queryByLabelText(/Partner joint/)).not.toBeInTheDocument();
    expect(lookupFixtures.accounts.find((a) => a.id === JOINT_ACCOUNT_ID)?.isJoint).toBe(true);
  });

  it('does not fetch accounts when the caller already holds them', async () => {
    await renderDialog({
      accountOptions: [{ value: ACCOUNT_ID, label: 'Held (CAD)' }],
    });
    expect(mocks.accounts).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('All accounts'));
    expect(screen.getByLabelText('Held (CAD)')).toBeInTheDocument();
  });

  it('says the accounts failed to load and offers a retry, and keeps the preview disabled', async () => {
    mocks.accounts.mockRejectedValueOnce(new Error('offline'));
    await renderDialog();
    expect(screen.getByRole('alert')).toHaveTextContent('Your accounts could not be loaded');
    expect(button('Preview')).toBeDisabled();
    await act(async () => {
      fireEvent.click(button('Try again'));
    });
    expect(button('Preview')).toBeEnabled();
    expect(mocks.accounts).toHaveBeenCalledTimes(2);
  });

  it('previews with the chosen filters, then confirms with the fingerprint of that preview', async () => {
    mocks.rules.run.mockResolvedValue({
      changed: 1,
      skipped: [],
      historyId: 'h-1',
    });
    await renderDialog();
    fireEvent.click(screen.getByText('All accounts'));
    fireEvent.click(screen.getByLabelText('Chequing (CAD)'));
    fireEvent.mouseDown(document.body);
    await preview();

    expect(mocks.rules.previewRun).toHaveBeenCalledWith('rule-1', {
      accountIds: [ACCOUNT_ID],
      limit: 200,
    });
    const row = screen.getByText('Corner Cafe').closest('tr') as HTMLElement;
    expect(row).toHaveTextContent('Category: none → Food: Coffee');
    expect(button('Confirm and run')).toBeEnabled();
    expect(mocks.rules.run).not.toHaveBeenCalled();

    await confirm();
    expect(mocks.rules.run).toHaveBeenCalledWith('rule-1', { accountIds: [ACCOUNT_ID], limit: 200 }, FP);
    expect(toast.success).toHaveBeenCalledWith(
      '1 transaction changed. You can undo this from the action history.',
    );
    expect(mocks.notify).toHaveBeenCalledTimes(1);
    expect(screen.getByText('1 transaction was changed.')).toBeInTheDocument();
    expect(screen.getByText('You can undo the run from the action history.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Confirm and run' })).not.toBeInTheDocument();
    // The header's X and the footer's Close are both named Close.
    fireEvent.click(screen.getAllByRole('button', { name: 'Close' }).at(-1)!);
    expect(onClose).toHaveBeenCalled();
  });

  it('reports the rows the run skipped after it finished', async () => {
    mocks.rules.run.mockResolvedValue({
      changed: 0,
      skipped: [{ transactionId: 's-1', reason: 'reconciled_locked' }],
      historyId: null,
    });
    await renderDialog();
    await preview();
    await confirm();
    expect(screen.getByText('No transactions were changed.')).toBeInTheDocument();
    expect(screen.getByTestId('rule-run-skipped')).toHaveTextContent('1 transaction: it is reconciled and locked');
  });

  it('cannot confirm a preview with nothing to change', async () => {
    mocks.rules.previewRun.mockResolvedValue(
      makePreview({
        matched: [],
        conditionMatchedCount: 0,
        scanned: 5,
        fingerprint: FP,
      }),
    );
    await renderDialog();
    await preview();
    expect(screen.getByText('No transactions would change')).toBeInTheDocument();
    expect(button('Confirm and run')).toBeDisabled();
  });

  it('confirms a run whose only work is queueing AI reviews, and reports what it queued without an undo', async () => {
    mocks.rules.previewRun.mockResolvedValue(
      makePreview({
        matched: [],
        conditionMatchedCount: 3,
        scanned: 5,
        aiReviewRequests: 3,
        fingerprint: FP,
      }),
    );
    mocks.rules.run.mockResolvedValue({
      changed: 0,
      skipped: [],
      historyId: null,
      aiReviewsQueued: 2,
      aiReviewsAlreadyQueued: 1,
    });
    await renderDialog();
    await preview();
    expect(screen.getByTestId('rule-run-ai-review')).toHaveTextContent(
      '3 transactions would be queued for AI review. The request is created when you confirm.',
    );
    expect(screen.queryByText('No transactions would change')).not.toBeInTheDocument();
    expect(button('Confirm and run')).toBeEnabled();

    await confirm();
    expect(mocks.rules.run).toHaveBeenCalledWith('rule-1', { limit: 200 }, FP);
    expect(toast.success).toHaveBeenCalledWith('2 transactions queued for AI review.');
    expect(screen.getByText('No transactions were changed.')).toBeInTheDocument();
    expect(screen.getByText('2 transactions were queued for AI review.')).toBeInTheDocument();
    expect(
      screen.getByText('1 transaction already had an open AI review request, so it was not queued again.'),
    ).toBeInTheDocument();
    // Nothing was written to the ledger, so there is no history entry to undo.
    expect(screen.queryByText('You can undo the run from the action history.')).not.toBeInTheDocument();
  });

  it('says nothing new was queued, and promises no undo, when every review was already open', async () => {
    mocks.rules.previewRun.mockResolvedValue(
      makePreview({ matched: [], conditionMatchedCount: 3, scanned: 5, aiReviewRequests: 1, fingerprint: FP }),
    );
    mocks.rules.run.mockResolvedValue({
      changed: 0,
      skipped: [],
      historyId: null,
      aiReviewsQueued: 0,
      aiReviewsAlreadyQueued: 3,
    });
    await renderDialog();
    await preview();
    await confirm();
    expect(toast.success).toHaveBeenCalledWith(
      '3 transactions already had an open AI review request, so nothing new was queued.',
    );
    expect(toast.success).not.toHaveBeenCalledWith(expect.stringContaining('undo'));
  });

  it('on PREVIEW_CHANGED shows a message and a refreshed preview, and confirms the new fingerprint only after the reader sees it', async () => {
    mocks.rules.run
      .mockRejectedValueOnce(
        refused(409, {
          errorCode: 'PREVIEW_CHANGED',
          fingerprint: 'c'.repeat(64),
        }),
      )
      .mockResolvedValueOnce({ changed: 2, skipped: [], historyId: 'h-2' });
    await renderDialog();
    await preview();
    mocks.rules.previewRun.mockResolvedValueOnce(
      makePreview({
        fingerprint: NEW_FP,
        matched: [{ ...makePreview().matched[0], payeeName: 'Fresh Beans' }],
      }),
    );
    await confirm();

    expect(mocks.rules.previewRun).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/The transactions or the rule changed since the preview/)).toBeInTheDocument();
    expect(screen.getByText('Fresh Beans')).toBeInTheDocument();
    expect(mocks.rules.run).toHaveBeenCalledTimes(1);
    expect(toast.success).not.toHaveBeenCalled();
    expect(mocks.notify).not.toHaveBeenCalled();

    await confirm();
    // The fingerprint of the refreshed preview, not the one the 409 carried.
    expect(mocks.rules.run).toHaveBeenLastCalledWith('rule-1', { limit: 200 }, NEW_FP);
    expect(screen.getByText('2 transactions were changed.')).toBeInTheDocument();
  });

  it('shows the refresh failing instead of an old preview when the second preview cannot load', async () => {
    mocks.rules.run.mockRejectedValue(refused(409, { errorCode: 'PREVIEW_CHANGED' }));
    await renderDialog();
    await preview();
    mocks.rules.previewRun.mockRejectedValueOnce(refused(500, { message: 'Down' }));
    await confirm();
    expect(screen.getByText(/The preview could not be loaded, so nothing can be run. Down/)).toBeInTheDocument();
    expect(screen.queryByText('Corner Cafe')).not.toBeInTheDocument();
    expect(button('Confirm and run')).toBeDisabled();
  });

  it.each([
    ['RUN_TOO_LARGE', /too many transactions to be undone in one step/],
    ['INVALID_RULE', /This rule is not valid, so it cannot be run/],
    ['DATE_RANGE_INVALID', /The start date must not be after the end date/],
  ])('shows the %s refusal and leaves the preview in place', async (errorCode, message) => {
    mocks.rules.run.mockRejectedValue(refused(400, { errorCode, message: 'server words' }));
    await renderDialog();
    await preview();
    await confirm();
    expect(screen.getByText(message)).toBeInTheDocument();
    expect(screen.getByText('Corner Cafe')).toBeInTheDocument();
    expect(toast.success).not.toHaveBeenCalled();
    expect(mocks.notify).not.toHaveBeenCalled();
    expect(button('Confirm and run')).toBeEnabled();
  });

  it('says an unrecognised run failure could not be completed and points at the history', async () => {
    mocks.rules.run.mockRejectedValue(new Error(''));
    await renderDialog();
    await preview();
    await confirm();
    expect(screen.getByText(/The run could not be completed. Check the action history/)).toBeInTheDocument();
  });

  it('shows a failed preview as an error, never as an empty table', async () => {
    mocks.rules.previewRun.mockRejectedValue(new Error(''));
    await renderDialog();
    await preview();
    expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong while loading the preview.');
    expect(screen.queryByText('No transactions would change')).not.toBeInTheDocument();
    expect(button('Confirm and run')).toBeDisabled();
  });

  it('marks the preview out of date and disables the run when a filter changes', async () => {
    await renderDialog();
    await preview();
    fireEvent.click(screen.getByText('All accounts'));
    fireEvent.click(screen.getByLabelText('Chequing (CAD)'));
    fireEvent.mouseDown(document.body);
    expect(screen.getByRole('status')).toHaveTextContent('The filters changed since this preview');
    expect(button('Confirm and run')).toBeDisabled();

    await preview();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(button('Confirm and run')).toBeEnabled();
  });

  it('closes from Cancel', async () => {
    await renderDialog();
    fireEvent.click(button('Cancel'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps a run in flight from being cancelled or repeated', async () => {
    let resolve!: (value: unknown) => void;
    mocks.rules.run.mockReturnValue(new Promise((r) => (resolve = r)));
    await renderDialog();
    await preview();
    await confirm();
    expect(button('Cancel')).toBeDisabled();
    expect(button('Confirm and run')).toBeDisabled();
    await act(async () => resolve({ changed: 1, skipped: [], historyId: null }));
    expect(mocks.rules.run).toHaveBeenCalledTimes(1);
  });
});
