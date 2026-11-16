import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@/test/render';
import { RuleConditionCard } from './RuleConditionCard';
import { testOptions } from './rule-test-harness';
import { ACCOUNT_ID, COFFEE_ID, TAG_ID } from './rules-test-fixtures';
import en from '@/i18n/messages/en/rules.json';
import { EDITOR_RULE_FIELDS, RULE_CONDITION_FIELDS } from '@/lib/rule-fields';
import { createLeaf, type EditorLeaf } from '@/lib/rule-tree';

Element.prototype.scrollIntoView = vi.fn();

function Card({ initial, onLeaf }: { initial: EditorLeaf; onLeaf?: (leaf: EditorLeaf) => void }) {
  const [leaf, setLeaf] = useState(initial);
  return (
    <RuleConditionCard
      leaf={leaf}
      options={testOptions}
      actions={[]}
      errors={[]}
      onChange={(next) => {
        setLeaf(next);
        onLeaf?.(next);
      }}
    />
  );
}

const leaf = (over: Partial<EditorLeaf>): EditorLeaf => ({ ...createLeaf('referenceNumber'), ...over });
const optionLabels = (select: HTMLElement) => within(select).getAllByRole('option').map((o) => o.textContent);

describe('RuleConditionCard', () => {
  it.each(Object.entries(RULE_CONDITION_FIELDS))('offers only the operators of %s', (field, spec) => {
    render(<Card initial={createLeaf(field as EditorLeaf['field'])} />);
    expect(optionLabels(screen.getByLabelText('Operator'))).toEqual(
      spec.operators.map((op) => en.editor.operators[op]),
    );
  });

  it('lists every field the editor has a control for, in the table order', () => {
    render(<Card initial={leaf({})} />);
    expect(optionLabels(screen.getByLabelText('Field'))).toEqual(
      EDITOR_RULE_FIELDS.map((field) => en.editor.fields[field as keyof typeof en.editor.fields]),
    );
  });

  it('shows a leaf on a field this client does not know with its stored value, never a wrong control', () => {
    render(<Card initial={leaf({ field: 'futureField' as never, op: 'eq', value: 'x' })} />);
    expect(screen.getByLabelText('Field')).toHaveValue('futureField');
    expect(screen.getByText('"x"')).toBeInTheDocument();
  });

  it('takes a reference number like a description: text, with the text operators', () => {
    const onLeaf = vi.fn();
    render(<Card initial={createLeaf('referenceNumber')} onLeaf={onLeaf} />);
    expect(screen.getByLabelText('Field')).toHaveValue('referenceNumber');
    expect(optionLabels(screen.getByLabelText('Operator'))).toEqual(
      ['is', 'contains', 'starts with', 'matches the pattern', 'is empty'],
    );
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: 'CHK-1' } });
    expect(onLeaf).toHaveBeenLastCalledWith(expect.objectContaining({ field: 'referenceNumber', value: 'CHK-1' }));
  });

  it('takes a day of the month as a whole number from 1 to 31', () => {
    const onLeaf = vi.fn();
    render(<Card initial={createLeaf('dayOfMonth')} onLeaf={onLeaf} />);
    const day = screen.getByLabelText('Value');
    expect(day).toHaveValue('');
    fireEvent.change(day, { target: { value: '15' } });
    fireEvent.blur(day);
    expect(onLeaf).toHaveBeenLastCalledWith(expect.objectContaining({ field: 'dayOfMonth', op: 'eq', value: 15 }));

    fireEvent.change(day, { target: { value: '45' } });
    fireEvent.blur(day);
    expect(onLeaf).toHaveBeenLastCalledWith(expect.objectContaining({ value: 31 }));
  });

  it('takes two days for between, and a list of days for in, sorted', () => {
    const onLeaf = vi.fn();
    render(<Card initial={createLeaf('dayOfMonth')} onLeaf={onLeaf} />);
    fireEvent.change(screen.getByLabelText('Operator'), {
      target: { value: 'between' },
    });
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '5' } });
    fireEvent.blur(screen.getByLabelText('From'));
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '20' } });
    fireEvent.blur(screen.getByLabelText('To'));
    expect(onLeaf).toHaveBeenLastCalledWith(expect.objectContaining({ op: 'between', value: [5, 20] }));

    fireEvent.change(screen.getByLabelText('Operator'), {
      target: { value: 'in' },
    });
    fireEvent.click(screen.getByText('Choose days'));
    fireEvent.click(screen.getByLabelText('15'));
    fireEvent.click(screen.getByLabelText('1'));
    expect(onLeaf).toHaveBeenLastCalledWith(expect.objectContaining({ op: 'in', value: [1, 15] }));
  });

  it('keeps a single day when the operator becomes in', () => {
    const onLeaf = vi.fn();
    render(<Card initial={leaf({ field: 'dayOfMonth', op: 'eq', value: 28 })} onLeaf={onLeaf} />);
    fireEvent.change(screen.getByLabelText('Operator'), {
      target: { value: 'in' },
    });
    expect(onLeaf).toHaveBeenLastCalledWith(expect.objectContaining({ op: 'in', value: [28] }));
  });

  it('offers the weekdays Monday first, in the reader\'s language, and reports the code', () => {
    const onLeaf = vi.fn();
    render(<Card initial={createLeaf('weekday')} onLeaf={onLeaf} />);
    const select = screen.getByLabelText('Value');
    expect(optionLabels(select)).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
    expect(select).toHaveValue('MON');
    fireEvent.change(select, { target: { value: 'SUN' } });
    expect(onLeaf).toHaveBeenLastCalledWith(expect.objectContaining({ field: 'weekday', value: 'SUN' }));

    fireEvent.change(screen.getByLabelText('Operator'), {
      target: { value: 'in' },
    });
    // The pick made under "is" carries over, and more are added to it.
    fireEvent.click(screen.getByRole('button', { name: 'Sun' }));
    fireEvent.click(screen.getByLabelText('Sat'));
    expect(onLeaf).toHaveBeenLastCalledWith(expect.objectContaining({ op: 'in', value: ['SUN', 'SAT'] }));
  });

  it('offers the transaction statuses under the names the transaction filter uses', () => {
    const onLeaf = vi.fn();
    render(<Card initial={createLeaf('status')} onLeaf={onLeaf} />);
    const select = screen.getByLabelText('Value');
    expect(optionLabels(select)).toEqual(['Unreconciled', 'Cleared', 'Reconciled', 'Void']);
    fireEvent.change(select, { target: { value: 'VOID' } });
    expect(onLeaf).toHaveBeenLastCalledWith(expect.objectContaining({ field: 'status', op: 'eq', value: 'VOID' }));

    fireEvent.change(screen.getByLabelText('Operator'), {
      target: { value: 'in' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Void' }));
    fireEvent.click(screen.getByLabelText('Cleared'));
    expect(onLeaf).toHaveBeenLastCalledWith(expect.objectContaining({ op: 'in', value: ['VOID', 'CLEARED'] }));
  });

  it('uses a switch named after the field for has an attachment', () => {
    const onLeaf = vi.fn();
    render(<Card initial={createLeaf('hasAttachment')} onLeaf={onLeaf} />);
    const toggle = screen.getByRole('switch', { name: 'Has an attachment' });
    // The visible text beside the switch names the setting, not its state.
    expect(toggle.parentElement).toHaveTextContent('Has an attachment');
    expect(screen.queryByText('Yes')).not.toBeInTheDocument();
    fireEvent.click(toggle);
    expect(onLeaf).toHaveBeenLastCalledWith(expect.objectContaining({ field: 'hasAttachment', value: false }));
    expect(screen.queryByText('No')).not.toBeInTheDocument();
  });

  it('explains captures under a pattern, and flags a name the server would refuse', () => {
    const onLeaf = vi.fn();
    render(
      <RuleConditionCard
        leaf={leaf({ field: 'description', op: 'matches', value: '*{Payee}*' })}
        options={testOptions}
        actions={[]}
        errors={['INVALID_CAPTURE']}
        captureCodes={['INVALID_CAPTURE']}
        onChange={onLeaf}
      />,
    );
    expect(screen.getByText(/Use \{name\} to keep the text at that spot/)).toBeInTheDocument();
    expect(screen.getByText(/Use \* for any text/)).toBeInTheDocument();
    expect(screen.getByText(/A pattern can hold at most|A capture name must be lowercase/)).toBeInTheDocument();
    // shown once, under the pattern, not again in the card's list
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it.each([
    ['LOOKS_LIKE_REGEX', 'a|b*', /Regular expressions are not supported/],
    ['PATTERN_WITHOUT_WILDCARD', 'nagroda', /Without a \* this pattern must equal the whole text/],
  ])('says under a pattern why the server refuses it: %s', (code, value, message) => {
    render(
      <RuleConditionCard
        leaf={leaf({ field: 'description', op: 'matches', value })}
        options={testOptions}
        actions={[]}
        errors={[code]}
        captureCodes={[code]}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText(message)).toBeInTheDocument();
    // The hint says what a pattern without * matches, and the card does not list the code twice.
    expect(screen.getByText(/A pattern without \* matches only the whole text/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('starts over when the field changes: first operator of the new field, empty value', () => {
    const onLeaf = vi.fn();
    render(<Card initial={leaf({ field: 'amount', op: 'between', value: [1, 2] })} onLeaf={onLeaf} />);

    fireEvent.change(screen.getByLabelText('Field'), {
      target: { value: 'referenceNumber' },
    });

    expect(onLeaf).toHaveBeenLastCalledWith(
      expect.objectContaining({
        field: 'referenceNumber',
        op: 'eq',
        value: '',
      }),
    );
    expect(screen.getByLabelText('Operator')).toHaveValue('eq');
    expect(screen.getByLabelText('Value')).toHaveValue('');
    expect(screen.queryByLabelText('From')).not.toBeInTheDocument();
  });

  it('keeps a pick across operators of the same shape and swaps the control across shapes', () => {
    render(<Card initial={leaf({ field: 'payeeId', op: 'eq', value: '' })} />);
    expect(screen.getByPlaceholderText('Choose a payee')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Operator'), {
      target: { value: 'in' },
    });
    expect(screen.queryByPlaceholderText('Choose a payee')).not.toBeInTheDocument();
    expect(screen.getByText('Choose payees')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Operator'), {
      target: { value: 'isEmpty' },
    });
    expect(screen.queryByText('Choose payees')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Value')).not.toBeInTheDocument();
  });

  it('shows a picker with names for accounts, payees and categories, never an id', () => {
    const onLeaf = vi.fn();
    render(<Card initial={leaf({ field: 'accountId', op: 'eq', value: ACCOUNT_ID })} onLeaf={onLeaf} />);
    const input = screen.getByPlaceholderText('Choose an account');
    expect(input).toHaveValue('Chequing (CAD)');
    expect(screen.queryByDisplayValue(ACCOUNT_ID)).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Field'), {
      target: { value: 'categoryId' },
    });
    fireEvent.focus(screen.getByPlaceholderText('Choose a category'));
    fireEvent.click(screen.getByText('Food: Coffee'));
    expect(onLeaf).toHaveBeenLastCalledWith(expect.objectContaining({ field: 'categoryId', value: COFFEE_ID }));
  });

  it('offers inSubtree only for categories and reads it as a single pick', () => {
    render(<Card initial={leaf({ field: 'categoryId', op: 'inSubtree', value: '' })} />);
    expect(screen.getByLabelText('Operator')).toHaveValue('inSubtree');
    expect(screen.getByPlaceholderText('Choose a category')).toBeInTheDocument();
  });

  it('uses a multi-select for a list of accounts and reports the chosen ids', () => {
    const onLeaf = vi.fn();
    render(<Card initial={leaf({ field: 'accountId', op: 'in', value: [] })} onLeaf={onLeaf} />);
    fireEvent.click(screen.getByText('Choose accounts'));
    fireEvent.click(screen.getByLabelText('Chequing (CAD)'));
    expect(onLeaf).toHaveBeenLastCalledWith(expect.objectContaining({ value: [ACCOUNT_ID] }));
  });

  it('uses a multi-select over tags', () => {
    const onLeaf = vi.fn();
    render(<Card initial={leaf({ field: 'tagIds', op: 'hasAny', value: [] })} onLeaf={onLeaf} />);
    fireEvent.click(screen.getByText('Choose tags'));
    fireEvent.click(screen.getByLabelText('Coffee run'));
    expect(onLeaf).toHaveBeenLastCalledWith(expect.objectContaining({ value: [TAG_ID] }));
  });

  it('uses a text input, and explains the wildcard only for the pattern operator', () => {
    const onLeaf = vi.fn();
    render(<Card initial={leaf({ field: 'description', op: 'contains', value: '' })} onLeaf={onLeaf} />);
    fireEvent.change(screen.getByLabelText('Value'), {
      target: { value: 'coffee' },
    });
    expect(onLeaf).toHaveBeenLastCalledWith(expect.objectContaining({ value: 'coffee' }));
    expect(screen.queryByText(/wildcard/)).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Operator'), {
      target: { value: 'matches' },
    });
    expect(screen.getByText(/Use \* for any text/)).toBeInTheDocument();
    expect(screen.getByLabelText('Value')).toHaveValue('coffee');
  });

  it('uses a money input for an amount and two for a range', () => {
    const onLeaf = vi.fn();
    render(<Card initial={leaf({ field: 'amount', op: 'gt' })} onLeaf={onLeaf} />);
    const amount = screen.getByLabelText('Amount');
    fireEvent.change(amount, { target: { value: '12.5' } });
    fireEvent.blur(amount);
    expect(onLeaf).toHaveBeenLastCalledWith(expect.objectContaining({ op: 'gt', value: 12.5 }));

    fireEvent.change(screen.getByLabelText('Operator'), {
      target: { value: 'between' },
    });
    expect(onLeaf).toHaveBeenLastCalledWith(expect.objectContaining({ op: 'between', value: [12.5, undefined] }));
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '30' } });
    fireEvent.blur(screen.getByLabelText('To'));
    expect(onLeaf).toHaveBeenLastCalledWith(expect.objectContaining({ value: [12.5, 30] }));
    expect(screen.getByLabelText('From')).toBeInTheDocument();
  });

  it('turns the range fields into positive-only inputs for an unsigned amount', () => {
    render(
      <Card
        initial={leaf({
          field: 'absAmount',
          op: 'between',
          value: [undefined, undefined],
        })}
      />,
    );
    const from = screen.getByLabelText('From');
    fireEvent.change(from, { target: { value: '-5' } });
    fireEvent.blur(from);
    expect((from as HTMLInputElement).value).not.toContain('-');
  });

  it('uses a select of translated labels for the transaction type', () => {
    const onLeaf = vi.fn();
    render(<Card initial={leaf({ field: 'type', op: 'eq', value: 'EXPENSE' })} onLeaf={onLeaf} />);
    const select = screen.getByLabelText('Value');
    expect(optionLabels(select)).toEqual(['Expense', 'Income', 'Transfer']);
    fireEvent.change(select, { target: { value: 'TRANSFER' } });
    expect(onLeaf).toHaveBeenLastCalledWith(expect.objectContaining({ value: 'TRANSFER' }));

    fireEvent.change(screen.getByLabelText('Operator'), {
      target: { value: 'in' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Transfer' }));
    fireEvent.click(screen.getByLabelText('Income'));
    expect(onLeaf).toHaveBeenLastCalledWith(expect.objectContaining({ value: ['TRANSFER', 'INCOME'] }));
  });

  it('uses a select of the user currencies, keeping a stored one that is no longer active', () => {
    const onLeaf = vi.fn();
    render(<Card initial={leaf({ field: 'currencyCode', op: 'eq', value: 'EUR' })} onLeaf={onLeaf} />);
    const select = screen.getByLabelText('Value');
    expect(optionLabels(select)).toEqual(['Choose a currency', 'CAD', 'EUR', 'USD']);
    expect(select).toHaveValue('EUR');
    fireEvent.change(select, { target: { value: 'USD' } });
    expect(onLeaf).toHaveBeenLastCalledWith(expect.objectContaining({ value: 'USD' }));

    fireEvent.change(screen.getByLabelText('Operator'), {
      target: { value: 'in' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'USD' }));
    fireEvent.click(screen.getByLabelText('CAD'));
    expect(onLeaf).toHaveBeenLastCalledWith(expect.objectContaining({ value: ['USD', 'CAD'] }));
  });

  it('uses a switch for has-splits and no value control for isEmpty', () => {
    const onLeaf = vi.fn();
    render(<Card initial={leaf({ field: 'hasSplits', op: 'eq', value: true })} onLeaf={onLeaf} />);
    const toggle = screen.getByRole('switch', { name: 'Has splits' });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(toggle.parentElement).toHaveTextContent('Has splits');
    fireEvent.click(toggle);
    expect(onLeaf).toHaveBeenLastCalledWith(expect.objectContaining({ value: false }));
  });

  it('shows its errors on the card', () => {
    render(
      <RuleConditionCard leaf={leaf({})} options={testOptions} actions={[]} errors={['VALUE_REQUIRED']} onChange={vi.fn()} />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Enter or choose a value.');
  });

  it('stacks its three controls on a phone and puts them in a row from sm up', () => {
    render(<Card initial={leaf({})} />);
    const grid = screen.getByLabelText('Field').closest('.grid');
    expect(grid).toHaveClass('grid-cols-1');
    expect(grid?.className).toContain('sm:grid-cols-');
  });
});
