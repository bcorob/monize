import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, within } from '@/test/render';
import { RuleEditor } from './RuleEditor';
import { lookupFixtures, makeRule } from './rules-test-fixtures';

Element.prototype.scrollIntoView = vi.fn();

const mocks = vi.hoisted(() => ({
  rules: { getById: vi.fn(), create: vi.fn(), update: vi.fn(), getApplications: vi.fn(), previewDraft: vi.fn(), previewRun: vi.fn(), run: vi.fn() },
  accounts: vi.fn(),
  payees: vi.fn(),
  categories: vi.fn(),
  tags: vi.fn(),
  currencies: vi.fn(),
}));

vi.mock('@/lib/transaction-rules-api', () => ({ transactionRulesApi: mocks.rules }));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
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
  exchangeRatesApi: { getCurrencies: (...args: unknown[]) => mocks.currencies(...args) },
}));

async function renderEditor(ruleId?: string) {
  let result!: ReturnType<typeof render>;
  await act(async () => {
    result = render(<RuleEditor ruleId={ruleId} />);
  });
  return result;
}

const card = (label: 'Condition' | 'Action' | 'Group', index = 0) => screen.getAllByRole('group', { name: label })[index];
const saveButton = () => screen.getByRole('button', { name: 'Save rule' });
const click = (name: string | RegExp) => fireEvent.click(screen.getByRole('button', { name }));

async function save() {
  await act(async () => {
    fireEvent.click(saveButton());
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.accounts.mockResolvedValue(lookupFixtures.accounts);
  mocks.payees.mockResolvedValue(lookupFixtures.payees);
  mocks.categories.mockResolvedValue(lookupFixtures.categories);
  mocks.tags.mockResolvedValue(lookupFixtures.tags);
  mocks.currencies.mockResolvedValue(lookupFixtures.currencies);
  mocks.rules.getApplications.mockResolvedValue([]);
});

const PATTERN = '*Payee: {payee} Ref: {ref}*';

function addPatternCondition(pattern = PATTERN) {
  click('+ Add condition');
  fireEvent.change(screen.getByLabelText('Operator'), { target: { value: 'matches' } });
  fireEvent.change(screen.getByLabelText('Value'), { target: { value: pattern } });
}

describe('RuleEditor: the text actions', () => {
  it('builds both actions with the placeholders of the rule, and sends the payload the API takes', async () => {
    mocks.rules.create.mockResolvedValue(makeRule({ id: 'new-id' }));
    await renderEditor();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Bank text' } });
    addPatternCondition();

    click('+ Add action');
    fireEvent.change(within(card('Action', 0)).getByLabelText('Action type'), { target: { value: 'set_payee_from_text' } });
    const payee = card('Action', 0);
    // The suggestions are the two built-ins and the two captures of the pattern above.
    expect(within(payee).getAllByRole('button', { name: /^Insert / }).map((b) => b.textContent)).toEqual([
      '{payeeText}',
      '{description}',
      '{payee}',
      '{ref}',
    ]);
    fireEvent.click(within(payee).getByRole('button', { name: 'Insert {payee}' }));
    expect(within(payee).getByLabelText('Payee name')).toHaveValue('{payee}');
    expect(within(payee).getByRole('switch', { name: 'Only if empty' })).toHaveAttribute('aria-checked', 'true');
    expect(within(payee).getByRole('switch', { name: 'Create the payee if it does not exist' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
    fireEvent.click(within(payee).getByRole('switch', { name: 'Create the payee if it does not exist' }));

    click('+ Add action');
    fireEvent.change(within(card('Action', 1)).getByLabelText('Action type'), { target: { value: 'set_description' } });
    const description = card('Action', 1);
    expect(within(description).getByLabelText('Description Mode')).toHaveValue('replace');
    expect(within(description).getByRole('switch', { name: 'Only if empty' })).toHaveAttribute('aria-checked', 'false');
    fireEvent.change(within(description).getByLabelText('Description Mode'), { target: { value: 'append' } });
    fireEvent.change(within(description).getByLabelText('Description text'), { target: { value: ' / ' } });
    fireEvent.click(within(description).getByRole('button', { name: 'Insert {ref}' }));

    await save();

    expect(mocks.rules.create).toHaveBeenCalledWith({
      name: 'Bank text',
      enabled: true,
      triggers: ['create', 'import'],
      condition: { all: [{ field: 'payeeText', op: 'matches', value: PATTERN }] },
      actions: [
        { type: 'set_payee_from_text', template: '{payee}', createIfMissing: true, onlyIfEmpty: true },
        { type: 'set_description', template: ' / {ref}', mode: 'append', onlyIfEmpty: false },
      ],
      stopProcessing: false,
    });
  });

  it('flags a placeholder the rule does not define as it is typed, and does not save', async () => {
    await renderEditor();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Bank text' } });
    addPatternCondition('*Payee: {payee}*');
    click('+ Add action');
    fireEvent.change(within(card('Action', 0)).getByLabelText('Action type'), { target: { value: 'set_description' } });
    const action = card('Action', 0);
    fireEvent.change(within(action).getByLabelText('Description text'), { target: { value: '{payee} {nope} {Bad}' } });

    expect(within(action).getByText(/Not defined by this rule: \{nope\}/)).toBeInTheDocument();
    expect(within(action).getByText(/Not a valid placeholder: \{Bad\}/)).toBeInTheDocument();

    await save();
    expect(mocks.rules.create).not.toHaveBeenCalled();
    // Said once, under the text, not again in the card's list.
    expect(within(action).getAllByText(/Not defined by this rule/)).toHaveLength(1);

    // Removing the offending placeholders clears the message.
    fireEvent.change(within(action).getByLabelText('Description text'), { target: { value: '{payee}' } });
    expect(within(action).queryByText(/Not defined by this rule/)).not.toBeInTheDocument();
  });

  it('flags a capture the server would refuse under the pattern, and does not save', async () => {
    await renderEditor();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Bank text' } });
    addPatternCondition('*{a}{a}*');
    click('+ Add action');
    fireEvent.change(within(card('Action', 0)).getByLabelText('Action type'), { target: { value: 'set_description' } });
    fireEvent.change(within(card('Action', 0)).getByLabelText('Description text'), { target: { value: '{a}' } });

    expect(within(card('Condition')).getByText('Each capture name can be used once in a rule.')).toBeInTheDocument();
    await save();
    expect(mocks.rules.create).not.toHaveBeenCalled();
  });

  it('refuses an empty text with the server\'s own sentence', async () => {
    await renderEditor();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Bank text' } });
    click('+ Add action');
    fireEvent.change(within(card('Action', 0)).getByLabelText('Action type'), { target: { value: 'set_payee_from_text' } });
    await save();
    expect(mocks.rules.create).not.toHaveBeenCalled();
    expect(within(card('Action', 0)).getByRole('alert')).toHaveTextContent('Enter some text.');
  });

  it('explains that a payee may be created', async () => {
    await renderEditor();
    click('+ Add action');
    fireEvent.change(within(card('Action', 0)).getByLabelText('Action type'), { target: { value: 'set_payee_from_text' } });
    expect(
      within(card('Action', 0)).getByRole('button', { name: /a new payee is created with it/ }),
    ).toBeInTheDocument();
  });
});

describe('RuleEditor: a stored rule with the text actions and the newer fields', () => {
  const stored = makeRule({
    id: 'rule-text',
    name: 'Bank text',
    revision: 3,
    triggers: ['import'],
    condition: {
      all: [
        { field: 'payeeText', op: 'matches', value: PATTERN },
        { field: 'referenceNumber', op: 'startsWith', value: 'CHK' },
        { field: 'dayOfMonth', op: 'between', value: [1, 15] },
        { field: 'weekday', op: 'in', value: ['SAT', 'SUN'] },
        { field: 'status', op: 'neq', value: 'VOID' },
        { field: 'hasAttachment', op: 'eq', value: false },
      ],
    },
    actions: [
      { type: 'set_payee_from_text', template: ' {payee}  ', createIfMissing: true, onlyIfEmpty: false },
      { type: 'set_description', template: '{description} | {ref}', mode: 'prepend', onlyIfEmpty: true },
    ],
  });

  beforeEach(() => {
    mocks.rules.getById.mockResolvedValue(stored);
  });

  it('opens with every setting as stored, and nothing to save until something changes', async () => {
    await renderEditor('rule-text');
    expect(screen.queryByText(/could not be read/)).not.toBeInTheDocument();
    const payee = card('Action', 0);
    expect(within(payee).getByLabelText('Payee name')).toHaveValue(' {payee}  ');
    expect(within(payee).getByRole('switch', { name: 'Create the payee if it does not exist' })).toHaveAttribute('aria-checked', 'true');
    expect(within(payee).getByRole('switch', { name: 'Only if empty' })).toHaveAttribute('aria-checked', 'false');
    const description = card('Action', 1);
    expect(within(description).getByLabelText('Description Mode')).toHaveValue('prepend');
    expect(within(description).getByLabelText('Description text')).toHaveValue('{description} | {ref}');
    expect(within(description).getByRole('switch', { name: 'Only if empty' })).toHaveAttribute('aria-checked', 'true');
    expect(within(card('Condition', 1)).getByLabelText('Field')).toHaveValue('referenceNumber');
    expect(within(card('Condition', 2)).getByLabelText('From')).toHaveValue('1');
    expect(within(card('Condition', 2)).getByLabelText('To')).toHaveValue('15');
    expect(within(card('Condition', 3)).getByRole('button', { name: '2 selected' })).toBeInTheDocument();
    expect(within(card('Condition', 4)).getByLabelText('Value')).toHaveValue('VOID');
    expect(within(card('Condition', 5)).getByRole('switch', { name: 'Has an attachment' })).toHaveAttribute('aria-checked', 'false');
    expect(saveButton()).toBeDisabled();
  });

  it('saves an edit to the name with the definition unchanged, byte for byte', async () => {
    mocks.rules.update.mockResolvedValue({ ...stored, name: 'Bank text 2', revision: 4 });
    await renderEditor('rule-text');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Bank text 2' } });
    await save();
    expect(mocks.rules.update).toHaveBeenCalledWith('rule-text', {
      name: 'Bank text 2',
      enabled: true,
      triggers: ['import'],
      condition: stored.condition,
      actions: stored.actions,
      stopProcessing: false,
      revision: 3,
    });
  });
});
