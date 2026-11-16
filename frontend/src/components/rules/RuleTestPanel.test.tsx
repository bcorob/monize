import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@/test/render';
import { RuleTestPanel } from './RuleTestPanel';
import { ACCOUNT_ID, COFFEE_ID, TAG_ID, makePreview } from './rules-test-fixtures';
import { emptyDraft, type RuleDraft } from '@/lib/rule-draft';
import { createAction } from '@/lib/rule-actions';
import { AxiosError } from 'axios';

const api = vi.hoisted(() => ({ previewDraft: vi.fn() }));

vi.mock('@/lib/transaction-rules-api', () => ({ transactionRulesApi: api }));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

const accountOptions = [{ value: ACCOUNT_ID, label: 'Chequing (CAD)' }];

/** A complete draft: no condition (every transaction) and one add-tags action. */
function completeDraft(tagIds: string[] = [TAG_ID]): RuleDraft {
  const base = emptyDraft();
  return { ...base, name: 'Coffee', actions: [{ ...createAction('add_tags'), tagIds } as RuleDraft['actions'][number]] };
}

async function renderPanel(draft: RuleDraft = completeDraft(), ruleId?: string) {
  let result!: ReturnType<typeof render>;
  await act(async () => {
    result = render(<RuleTestPanel draft={draft} accountOptions={accountOptions} ruleId={ruleId} />);
  });
  return {
    ...result,
    rerenderWith: async (next: RuleDraft) => {
      await act(async () => {
        result.rerender(<RuleTestPanel draft={next} accountOptions={accountOptions} ruleId={ruleId} />);
      });
    },
  };
}

const testButton = () => screen.getByRole('button', { name: /^Test (rule|again)$/ });

async function runTest() {
  await act(async () => {
    fireEvent.click(testButton());
  });
}

function refused(status: number, data: unknown): AxiosError {
  const error = new AxiosError('failed');
  error.response = { status, data } as AxiosError['response'];
  return error;
}

describe('RuleTestPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends the rule id of a saved rule so an unchanged condition is not re-advised', async () => {
    api.previewDraft.mockResolvedValue(makePreview());
    await renderPanel(completeDraft(), 'rule-1');
    await runTest();
    expect(api.previewDraft).toHaveBeenCalledWith({
      ruleId: 'rule-1',
      condition: { all: [] },
      actions: [{ type: 'add_tags', tagIds: [TAG_ID] }],
      filters: { limit: 200 },
    });
  });

  it('sends no rule id for a new rule', async () => {
    api.previewDraft.mockResolvedValue(makePreview());
    await renderPanel();
    await runTest();
    expect(api.previewDraft.mock.calls[0][0]).not.toHaveProperty('ruleId');
  });

  it('sends the current unsaved draft with the default limit and shows the planned changes in words', async () => {
    api.previewDraft.mockResolvedValue(makePreview());
    await renderPanel();
    expect(screen.getByText(/Choose which transactions to try the rule on/)).toBeInTheDocument();
    await runTest();

    expect(api.previewDraft).toHaveBeenCalledTimes(1);
    expect(api.previewDraft).toHaveBeenCalledWith({
      condition: { all: [] },
      actions: [{ type: 'add_tags', tagIds: [TAG_ID] }],
      filters: { limit: 200 },
    });
    expect(screen.getByText('1 transaction would change out of 12 transactions scanned.')).toBeInTheDocument();
    const row = screen.getByText('Corner Cafe').closest('tr') as HTMLElement;
    expect(row).toHaveTextContent('Category: none → Food: Coffee');
    expect(row).toHaveTextContent('Tags added: Coffee run');
    expect(row).toHaveTextContent('-$4.50');
    expect(screen.getByRole('button', { name: 'Test again' })).toBeInTheDocument();
    expect(screen.getByTestId('rule-test-result')).toHaveAttribute('data-stale', 'false');
  });

  it('sends the filters the reader chose', async () => {
    api.previewDraft.mockResolvedValue(makePreview());
    await renderPanel();
    fireEvent.click(screen.getByText('All accounts'));
    fireEvent.click(screen.getByLabelText('Chequing (CAD)'));
    fireEvent.mouseDown(document.body);
    await runTest();
    expect(api.previewDraft.mock.calls[0][0].filters).toEqual({
      accountIds: [ACCOUNT_ID],
      limit: 200,
    });
  });

  it('names a removed tag and a payee change, and says a missing name is a deleted item', async () => {
    api.previewDraft.mockResolvedValue(
      makePreview({
        matched: [
          {
            transactionId: 'tx-2',
            date: '2026-08-15',
            payeeName: null,
            amount: 10,
            currencyCode: 'CAD',
            changes: {
              payeeId: { before: 'gone', after: null },
              tagIds: { before: [TAG_ID], after: [] },
              categoryId: { before: COFFEE_ID, after: 'unlabelled' },
            },
          },
        ],
      }),
    );
    await renderPanel();
    await runTest();
    const row = screen.getByText('No payee').closest('tr') as HTMLElement;
    expect(row).toHaveTextContent('Payee: a deleted item → none');
    expect(row).toHaveTextContent('Tags removed: Coffee run');
    expect(row).toHaveTextContent('Category: Food: Coffee → a deleted item');
  });

  it('says no rows matched instead of drawing an empty table', async () => {
    api.previewDraft.mockResolvedValue(makePreview({ matched: [], conditionMatchedCount: 0, scanned: 30 }));
    await renderPanel();
    await runTest();
    expect(screen.getByText('No transactions would change')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.getByText('0 transactions would change out of 30 transactions scanned.')).toBeInTheDocument();
  });

  it('says the condition matches but nothing would change, instead of claiming no rows matched', async () => {
    api.previewDraft.mockResolvedValue(makePreview({ matched: [], conditionMatchedCount: 8, scanned: 30 }));
    await renderPanel();
    await runTest();
    expect(screen.getByText('No transactions would change')).toBeInTheDocument();
    expect(
      screen.getByText(/8 of the 30 transactions examined match the rule's conditions, but nothing would change/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/None of the scanned transactions match the rule/)).not.toBeInTheDocument();
  });

  it('notes a truncated scan and lists the skipped rows by reason', async () => {
    api.previewDraft.mockResolvedValue(
      makePreview({
        truncated: true,
        skipped: [
          { transactionId: 's-1', reason: 'reconciled_locked' },
          { transactionId: 's-2', reason: 'reconciled_locked' },
          { transactionId: 's-3', reason: 'split_category' },
          { transactionId: 's-4', reason: 'a_future_reason' as never },
        ],
      }),
    );
    await renderPanel();
    await runTest();
    expect(screen.getByText(/More transactions matched than the limit allows/)).toBeInTheDocument();
    const skipped = screen.getByTestId('rule-run-skipped');
    expect(skipped).toHaveTextContent('4 transactions are left alone');
    expect(skipped).toHaveTextContent('2 transactions: it is reconciled and locked');
    expect(skipped).toHaveTextContent('1 transaction: it is split, so the category belongs to the splits');
    expect(skipped).toHaveTextContent('1 transaction: the rule cannot change it');
  });

  it('describes what the text actions would do: the payee named by text, a payee that will be created, the description', async () => {
    api.previewDraft.mockResolvedValue(
      makePreview({
        matched: [
          {
            transactionId: 'tx-1',
            date: '2026-08-14',
            payeeName: null,
            amount: -4.5,
            currencyCode: 'CAD',
            changes: {
              payeeName: { before: null, after: 'Corner Cafe Ltd' },
              payeeCreated: true,
              description: { before: 'POS 123', after: 'POS 123 / REF 9' },
            },
          },
          {
            transactionId: 'tx-2',
            date: '2026-08-15',
            payeeName: 'Old',
            amount: -1,
            currencyCode: 'CAD',
            changes: { payeeName: { before: 'Old', after: 'Corner Cafe' }, description: { before: null, after: 'Note' } },
          },
        ],
        skipped: [
          { transactionId: 's-1', reason: 'empty_render' },
          { transactionId: 's-2', reason: 'payee_not_found' },
        ],
      }),
    );
    await renderPanel();
    await runTest();
    const rows = screen.getAllByRole('row').slice(1);
    expect(rows[0]).toHaveTextContent('Payee: none → Corner Cafe Ltd');
    expect(rows[0]).toHaveTextContent('A new payee will be created: Corner Cafe Ltd');
    expect(rows[0]).toHaveTextContent('Description: "POS 123" → "POS 123 / REF 9"');
    expect(rows[1]).toHaveTextContent('Payee: Old → Corner Cafe');
    expect(rows[1]).not.toHaveTextContent('will be created');
    expect(rows[1]).toHaveTextContent('Description: none → "Note"');
    const skipped = screen.getByTestId('rule-run-skipped');
    expect(skipped).toHaveTextContent('1 transaction: the text of an action came out empty for it');
    expect(skipped).toHaveTextContent('1 transaction: no payee has the name the rule built, and it does not create one');
  });

  it('shows a failed request as an error, never as an empty result', async () => {
    api.previewDraft.mockRejectedValue(refused(500, { message: 'Database unavailable' }));
    await renderPanel();
    await runTest();
    expect(screen.getByRole('alert')).toHaveTextContent('The test could not be completed. Database unavailable');
    expect(screen.queryByText('No transactions would change')).not.toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('explains a draft the server refuses and a generic failure', async () => {
    api.previewDraft.mockRejectedValueOnce(refused(400, { errors: [{ path: 'actions[0]', code: 'ARRAY_EMPTY' }] }));
    await renderPanel();
    await runTest();
    expect(screen.getByRole('alert')).toHaveTextContent('The rule is incomplete or not valid.');

    api.previewDraft.mockRejectedValueOnce(new Error(''));
    await runTest();
    expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong while testing the rule.');
  });

  it('marks the result out of date when the draft changes, and keeps it readable', async () => {
    api.previewDraft.mockResolvedValue(makePreview());
    const { rerenderWith } = await renderPanel();
    await runTest();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();

    await rerenderWith(completeDraft(['other-tag']));
    expect(screen.getByRole('status')).toHaveTextContent('The rule or the filters changed since this result.');
    expect(screen.getByTestId('rule-test-result')).toHaveAttribute('data-stale', 'true');
    expect(screen.getByText('Corner Cafe')).toBeInTheDocument();

    api.previewDraft.mockResolvedValue(makePreview({ matched: [], conditionMatchedCount: 0, scanned: 3 }));
    await runTest();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByText('No transactions would change')).toBeInTheDocument();
  });

  it('marks the result out of date when a filter changes', async () => {
    api.previewDraft.mockResolvedValue(makePreview());
    await renderPanel();
    await runTest();
    fireEvent.click(screen.getByText('All accounts'));
    fireEvent.click(screen.getByLabelText('Chequing (CAD)'));
    fireEvent.mouseDown(document.body);
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('shows an answer for an earlier draft as out of date when the draft moved while it was in flight', async () => {
    let resolve!: (value: ReturnType<typeof makePreview>) => void;
    api.previewDraft.mockReturnValue(new Promise((r) => (resolve = r)));
    const { rerenderWith } = await renderPanel();
    await runTest();
    expect(screen.getByText('Testing the rule...')).toBeInTheDocument();
    expect(testButton()).toBeDisabled();

    await rerenderWith(completeDraft(['other-tag']));
    await act(async () => resolve(makePreview()));
    expect(screen.getByTestId('rule-test-result')).toHaveAttribute('data-stale', 'true');
  });

  it('will not send an incomplete draft, and says what is missing', async () => {
    await renderPanel(emptyDraft());
    expect(testButton()).toBeDisabled();
    expect(screen.getByText('Complete the conditions and actions above to test the rule.')).toBeInTheDocument();
    expect(api.previewDraft).not.toHaveBeenCalled();
  });

  it('does not need a name to test', async () => {
    api.previewDraft.mockResolvedValue(makePreview());
    await renderPanel({ ...completeDraft(), name: '' });
    expect(testButton()).toBeEnabled();
  });

  it('refuses a backwards date range before asking the server', async () => {
    await renderPanel();
    const [from, to] = screen.getAllByRole('textbox', { name: /^(From|To)/ });
    fireEvent.change(from, { target: { value: '2026-09-30' } });
    fireEvent.blur(from);
    fireEvent.change(to, { target: { value: '2026-01-01' } });
    fireEvent.blur(to);
    expect(screen.getByText('The start date must not be after the end date.')).toBeInTheDocument();
    expect(testButton()).toBeDisabled();
  });
});
