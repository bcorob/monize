import { describe, expect, it, vi, beforeEach } from 'vitest';
import { AxiosError, AxiosHeaders, type AxiosResponse } from 'axios';
import { act, fireEvent, render, screen, within } from '@/test/render';
import { RuleEditor } from './RuleEditor';
import { ACCOUNT_ID, COFFEE_ID, FOOD_ID, PAYEE_ID, TAG_ID, lookupFixtures, makeRule } from './rules-test-fixtures';

Element.prototype.scrollIntoView = vi.fn();

const mocks = vi.hoisted(() => ({
  rules: { getById: vi.fn(), create: vi.fn(), update: vi.fn(), getApplications: vi.fn(), previewDraft: vi.fn(), previewRun: vi.fn(), run: vi.fn() },
  accounts: vi.fn(),
  payees: vi.fn(),
  categories: vi.fn(),
  tags: vi.fn(),
  currencies: vi.fn(),
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
vi.mock('@/lib/payees', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/payees')>()),
  payeesApi: { getAll: (...args: unknown[]) => mocks.payees(...args) },
}));
vi.mock('@/lib/categories', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/categories')>()),
  categoriesApi: { getAll: (...args: unknown[]) => mocks.categories(...args) },
}));
vi.mock('@/lib/tags', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tags')>()),
  tagsApi: { getAll: (...args: unknown[]) => mocks.tags(...args) },
}));
vi.mock('@/lib/exchange-rates', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/exchange-rates')>()),
  exchangeRatesApi: {
    getCurrencies: (...args: unknown[]) => mocks.currencies(...args),
  },
}));

function apiError(status: number, data: unknown): AxiosError {
  const response = {
    status,
    data,
    statusText: '',
    headers: {},
    config: { headers: new AxiosHeaders() },
  } as AxiosResponse;
  return new AxiosError('failed', 'ERR_BAD_REQUEST', undefined, undefined, response);
}

async function renderEditor(ruleId?: string) {
  await act(async () => {
    render(<RuleEditor ruleId={ruleId} />);
  });
}

const saveButton = () => screen.getByRole('button', { name: 'Save rule' });
const visualTab = () => screen.getByRole('button', { name: 'Visual' });
const expressionTab = () => screen.getByRole('button', { name: 'Expression' });
const box = () =>
  screen.getByRole('textbox', {
    name: 'Condition expression',
  }) as HTMLTextAreaElement;
const cards = () => screen.queryAllByRole('group', { name: 'Condition' });
const write = (value: string) =>
  fireEvent.change(box(), {
    target: { value, selectionStart: value.length, selectionEnd: value.length },
  });
const save = async () => {
  await act(async () => {
    fireEvent.click(saveButton());
  });
};

const stored = makeRule({
  id: 'rule-9',
  name: 'Coffee shops',
  revision: 7,
  condition: {
    all: [
      { field: 'accountId', op: 'eq', value: ACCOUNT_ID },
      { any: [{ field: 'payeeText', op: 'matches', value: '*CAFE*' }, { field: 'amount', op: 'between', value: [-50, -5] }] },
      { field: 'categoryId', op: 'inSubtree', value: COFFEE_ID },
    ],
  },
  actions: [{ type: 'add_tags', tagIds: [TAG_ID] }],
});

const STORED_TEXT =
  'transaction.accountId == account("Chequing") && (transaction.payeeText.matchesGlob("*CAFE*") || transaction.amount.between(-50, -5)) && transaction.categoryId.inSubtree(category("Food: Coffee"))';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.accounts.mockResolvedValue(lookupFixtures.accounts);
  mocks.payees.mockResolvedValue(lookupFixtures.payees);
  mocks.categories.mockResolvedValue(lookupFixtures.categories);
  mocks.tags.mockResolvedValue(lookupFixtures.tags);
  mocks.currencies.mockResolvedValue(lookupFixtures.currencies);
  mocks.rules.getApplications.mockResolvedValue([]);
  mocks.rules.getById.mockResolvedValue(stored);
});

describe('RuleEditor: the Visual / Expression switch', () => {
  it('starts on Visual, with the switch as a pressed-state pair', async () => {
    await renderEditor('rule-9');
    expect(within(screen.getByRole('group', { name: 'Condition view' })).getAllByRole('button')).toHaveLength(2);
    expect(visualTab()).toHaveAttribute('aria-pressed', 'true');
    expect(expressionTab()).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByRole('textbox', { name: 'Condition expression' })).not.toBeInTheDocument();
    expect(cards().length).toBeGreaterThan(0);
  });

  it('shows the stored rule as text made of names, never ids', async () => {
    await renderEditor('rule-9');
    fireEvent.click(expressionTab());
    expect(box()).toHaveValue(STORED_TEXT);
    expect(box().value).not.toContain(ACCOUNT_ID);
    expect(box().value).not.toContain(COFFEE_ID);
    expect(expressionTab()).toHaveAttribute('aria-pressed', 'true');
    expect(cards()).toHaveLength(0);
  });

  it('shows a new rule as the empty condition, and says it applies to every transaction', async () => {
    await renderEditor();
    fireEvent.click(expressionTab());
    expect(box()).toHaveValue('true');
    expect(screen.getByText('No conditions yet, so this rule applies to every transaction.')).toBeInTheDocument();
  });

  it('an edit that parses changes the rule, and Visual then shows exactly that rule', async () => {
    await renderEditor('rule-9');
    fireEvent.click(expressionTab());
    write('transaction.referenceNumber.contains("tea") && !(transaction.tagIds.hasAny([tag("Work")]))');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    fireEvent.click(visualTab());

    expect(visualTab()).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('textbox', { name: 'Condition expression' })).not.toBeInTheDocument();
    const [leaf, negated] = [screen.getAllByRole('group', { name: 'Condition' })[0], screen.getByRole('group', { name: 'Group' })];
    expect(within(leaf).getByLabelText('Field')).toHaveValue('referenceNumber');
    expect(within(leaf).getByLabelText('Operator')).toHaveValue('contains');
    expect(within(leaf).getByLabelText('Value')).toHaveValue('tea');
    expect(within(negated).getByRole('switch', { name: 'Negate Group' })).toBeChecked();
    expect(within(negated).getByLabelText('Field')).toHaveValue('tagIds');
  });

  it('a change made in Visual is in the text the next time Expression opens', async () => {
    await renderEditor('rule-9');
    fireEvent.click(screen.getAllByRole('button', { name: 'Any of these' })[0]);
    fireEvent.click(expressionTab());
    expect(box().value.startsWith('transaction.accountId == account("Chequing") || ')).toBe(true);
    fireEvent.click(visualTab());
    fireEvent.click(expressionTab());
    expect(box().value.startsWith('transaction.accountId == account("Chequing") || ')).toBe(true);
  });

  it('round trips the stored rule unchanged: opening Expression and going back changes nothing to save', async () => {
    await renderEditor('rule-9');
    fireEvent.click(expressionTab());
    write(STORED_TEXT);
    fireEvent.click(visualTab());
    expect(saveButton()).toBeDisabled();
  });

  it('saves the condition written as text, with the ids of the names it uses', async () => {
    mocks.rules.create.mockResolvedValue(makeRule({ id: 'new-id' }));
    await renderEditor();
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'From text' },
    });
    fireEvent.click(screen.getByRole('button', { name: '+ Add action' }));
    fireEvent.change(screen.getByLabelText('Action type'), {
      target: { value: 'set_payee' },
    });
    fireEvent.focus(screen.getByPlaceholderText('Choose a payee'));
    fireEvent.click(screen.getByText('Corner Cafe'));
    fireEvent.click(expressionTab());
    write(
      'transaction.payeeId == payee("Corner Cafe") && (transaction.categoryId.inSubtree(category("Food")) || transaction.tagIds.hasNone([tag("Work")])) && !(transaction.accountId in [account("Chequing")])',
    );

    await save();

    expect(mocks.rules.create).toHaveBeenCalledWith({
      name: 'From text',
      enabled: true,
      triggers: ['create', 'import'],
      condition: {
        all: [
          { field: 'payeeId', op: 'eq', value: PAYEE_ID },
          {
            any: [
              { field: 'categoryId', op: 'inSubtree', value: FOOD_ID },
              {
                field: 'tagIds',
                op: 'hasNone',
                value: [lookupFixtures.tags[1].id],
              },
            ],
          },
          { field: 'accountId', op: 'notIn', value: [ACCOUNT_ID] },
        ],
      },
      actions: [{ type: 'set_payee', payeeId: PAYEE_ID, onlyIfEmpty: true }],
      stopProcessing: false,
    });
  });
});

describe('RuleEditor: text that is not a rule', () => {
  it('shows where and why, disables Save, the way back to Visual and the test, and says so', async () => {
    await renderEditor('rule-9');
    fireEvent.click(expressionTab());
    write('transaction.referenceNumber == "a" &&\ntransaction.nope == 1');

    expect(screen.getByRole('alert')).toHaveTextContent('Line 2, column 13: Unknown field nope.');
    expect(saveButton()).toBeDisabled();
    expect(visualTab()).toBeDisabled();
    expect(screen.getByText('Fix the expression to switch back to Visual or to save.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Test rule' })).toBeDisabled();
    expect(expressionTab()).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(visualTab());
    expect(box()).toBeInTheDocument();
  });

  it('never saves the last good tree while the text is broken, even from a new rule that could be saved', async () => {
    mocks.rules.create.mockResolvedValue(makeRule());
    await renderEditor();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'R' } });
    fireEvent.click(screen.getByRole('button', { name: '+ Add action' }));
    fireEvent.change(screen.getByLabelText('Action type'), {
      target: { value: 'set_payee' },
    });
    fireEvent.focus(screen.getByPlaceholderText('Choose a payee'));
    fireEvent.click(screen.getByText('Corner Cafe'));
    fireEvent.click(expressionTab());
    write('transaction.referenceNumber == 5');

    expect(saveButton()).toBeDisabled();
    await save();
    expect(mocks.rules.create).not.toHaveBeenCalled();
  });

  it('enables everything again as soon as the text is a rule', async () => {
    await renderEditor('rule-9');
    fireEvent.click(expressionTab());
    write('transaction.referenceNumber == ');
    expect(visualTab()).toBeDisabled();
    write('transaction.referenceNumber == "ok"');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(visualTab()).toBeEnabled();
    expect(saveButton()).toBeEnabled();
    fireEvent.click(visualTab());
    expect(within(screen.getByRole('group', { name: 'Condition' })).getByLabelText('Value')).toHaveValue('ok');
  });

  it('keeps a half-finished condition: a value not chosen yet is an underscore and blocks the save as it does in Visual', async () => {
    mocks.rules.update.mockResolvedValue(stored);
    await renderEditor('rule-9');
    fireEvent.click(expressionTab());
    write('transaction.amount > _');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await save();

    expect(mocks.rules.update).not.toHaveBeenCalled();
    expect(screen.getByText('Enter or choose a value.')).toBeInTheDocument();
    fireEvent.click(visualTab());
    expect(within(screen.getByRole('group', { name: 'Condition' })).getByText('Enter or choose a value.')).toBeInTheDocument();
  });

  it('lists the server\'s condition errors under the box, since there are no cards to carry them', async () => {
    mocks.rules.update.mockRejectedValue(
      apiError(400, { errors: [{ path: 'condition.all[0].value', code: 'REFERENCE_NOT_FOUND' }, { path: 'condition.all[1].all[0]', code: 'MAX_DEPTH' }] }),
    );
    await renderEditor('rule-9');
    fireEvent.click(expressionTab());
    write('transaction.referenceNumber == "changed"');
    await save();

    expect(screen.getByText('An item chosen here no longer exists. Choose another.')).toBeInTheDocument();
    expect(screen.getByText(/Groups are nested too deeply/)).toBeInTheDocument();
    // The next edit clears them, as it does on the cards.
    write('transaction.referenceNumber == "changed again"');
    expect(screen.queryByText('An item chosen here no longer exists. Choose another.')).not.toBeInTheDocument();
  });

  it('opens a rule with an item that no longer exists, showing it as missing() so nothing is lost', async () => {
    mocks.rules.getById.mockResolvedValue(
      makeRule({ condition: { all: [{ field: 'tagIds', op: 'hasAny', value: ['gone-tag'] }] } }),
    );
    await renderEditor('rule-1');
    fireEvent.click(expressionTab());
    expect(box()).toHaveValue('transaction.tagIds.hasAny([missing("gone-tag")])');
    fireEvent.click(visualTab());
    fireEvent.click(expressionTab());
    expect(box()).toHaveValue('transaction.tagIds.hasAny([missing("gone-tag")])');
  });
});
