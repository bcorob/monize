import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { fireEvent, render, screen, within } from '@/test/render';
import { RuleExpressionEditor } from './RuleExpressionEditor';
import { parseCondition, type CelError } from '@/lib/rule-cel';
import { INDEX } from '@/test/rule-cel-support';
import { RULE_FIELDS } from '@/lib/rule-fields';

/** The editor over real state and the real parser, as the section wires it. */
function Harness({ initial = '', onText, codes = [] }: { initial?: string; onText?: (text: string) => void; codes?: string[] }) {
  const [text, setText] = useState(initial);
  const [error, setError] = useState<CelError | null>(null);
  return (
    <RuleExpressionEditor
      text={text}
      error={error}
      index={INDEX}
      codes={codes}
      onChange={(next) => {
        setText(next);
        const result = parseCondition(next, INDEX);
        setError(result.ok ? null : result.error);
        onText?.(next);
      }}
    />
  );
}

const box = () => screen.getByRole('textbox', { name: 'Condition expression' }) as HTMLTextAreaElement;

/** Types `value` with the caret at `caret` (default: the end). */
function type(value: string, caret = value.length) {
  fireEvent.change(box(), { target: { value, selectionStart: caret, selectionEnd: caret } });
}
const options = () => screen.queryAllByRole('option').map((o) => o.textContent);

describe('RuleExpressionEditor', () => {
  it('is a labelled, monospaced, spellcheck-free box with the help beside it', () => {
    render(<Harness initial={'transaction.referenceNumber == "a"'} />);
    expect(box()).toHaveValue('transaction.referenceNumber == "a"');
    expect(box()).toHaveClass('font-mono');
    expect(box()).toHaveClass('focus-visible:ring-1');
    expect(box()).toHaveAttribute('spellcheck', 'false');
    expect(box()).toHaveAccessibleDescription(/Write the conditions as text/);
    expect(box()).not.toHaveAttribute('aria-invalid', 'true');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  describe('errors', () => {
    it('says the line, the column and the reason, marks the spot, and describes the box', () => {
      render(<Harness />);
      type('transaction.referenceNumber == "a" &&\n  transaction.nope == 1');
      const alert = screen.getByRole('alert');
      expect(alert).toHaveTextContent('Line 2, column 15: Unknown field nope.');
      expect(box()).toHaveAttribute('aria-invalid', 'true');
      expect(box()).toHaveAccessibleDescription(/Line 2, column 15/);
      // The offending line, and a marker under the refused word.
      const excerpt = document.querySelector('pre');
      expect(excerpt?.textContent).toBe('  transaction.nope == 1\n              ^^^^');
    });

    it('translates every argument of the message', () => {
      render(<Harness />);
      type('transaction.type == "EXPENSES"');
      expect(screen.getByRole('alert')).toHaveTextContent('Use one of: EXPENSE, INCOME, TRANSFER.');
      type('transaction.accountId == account("Chequing")');
      expect(screen.getByRole('alert')).toHaveTextContent('2 items are named "Chequing". Add the number of the one you mean, for example account("Chequing", 1).');
      type('transaction.accountId == payee("Amazon")');
      expect(screen.getByRole('alert')).toHaveTextContent('Expected an account, for example account("Name").');
      type('transaction.payeeId == payee("Zed")');
      expect(screen.getByRole('alert')).toHaveTextContent('No payee is named "Zed".');
      type('transaction.payeeId == payee("Amazon", 9)');
      expect(screen.getByRole('alert')).toHaveTextContent('The number for "Amazon" must be from 1 to 3.');
    });

    it('clears when the text is fixed', () => {
      render(<Harness />);
      type('transaction.');
      type('transaction.referenceNumber == 5');
      expect(screen.getByRole('alert')).toBeInTheDocument();
      type('transaction.referenceNumber == "5"');
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('lists the codes the server or the draft check gave for the conditions', () => {
      render(<Harness initial="transaction.amount > _" codes={['VALUE_REQUIRED']} />);
      expect(screen.getByText('Enter or choose a value.')).toBeInTheDocument();
    });
  });

  describe('suggestions', () => {
    it('lists the fields after transaction., named by their labels, and points the box at the list', () => {
      render(<Harness />);
      type('transaction.');
      const list = screen.getByRole('listbox', { name: 'Suggestions' });
      expect(within(list).getAllByRole('option')).toHaveLength(RULE_FIELDS.length);
      expect(options()[0]).toBe('accountIdAccount');
      expect(box()).toHaveAttribute('aria-controls', list.id);
      expect(box()).toHaveAttribute('aria-autocomplete', 'list');
      expect(box()).not.toHaveAttribute('aria-activedescendant');
    });

    it('narrows while typing with the keyboard as a person would', async () => {
      const user = userEvent.setup();
      render(<Harness />);
      await user.type(box(), 'transaction.pay');
      expect(options()).toEqual(['payeeIdPayee', 'payeeTextPayee text as received']);
      await user.type(box(), 'eeT');
      expect(options()).toEqual(['payeeTextPayee text as received']);
    });

    it('moves the highlight with Down and Up, wrapping at both ends', () => {
      render(<Harness />);
      type('transaction.a');
      expect(options()).toEqual(['accountIdAccount', 'amountAmount (with sign)', 'absAmountAmount (ignoring sign)']);
      const active = () => screen.queryAllByRole('option').findIndex((o) => o.getAttribute('aria-selected') === 'true');
      expect(active()).toBe(-1);
      fireEvent.keyDown(box(), { key: 'ArrowDown' });
      expect(active()).toBe(0);
      expect(box()).toHaveAttribute('aria-activedescendant', screen.getAllByRole('option')[0].id);
      fireEvent.keyDown(box(), { key: 'ArrowDown' });
      fireEvent.keyDown(box(), { key: 'ArrowDown' });
      expect(active()).toBe(2);
      fireEvent.keyDown(box(), { key: 'ArrowDown' });
      expect(active()).toBe(0);
      fireEvent.keyDown(box(), { key: 'ArrowUp' });
      expect(active()).toBe(2);
      expect(box()).toHaveAttribute('aria-activedescendant', screen.getAllByRole('option')[2].id);
    });

    it('chooses the highlighted item with Enter, and puts the caret after it', () => {
      const onText = vi.fn();
      render(<Harness onText={onText} />);
      type('transaction.a');
      fireEvent.keyDown(box(), { key: 'ArrowDown' });
      fireEvent.keyDown(box(), { key: 'ArrowDown' });
      const enter = fireEvent.keyDown(box(), { key: 'Enter' });
      expect(enter).toBe(false);
      expect(box()).toHaveValue('transaction.amount');
      expect(box().selectionStart).toBe('transaction.amount'.length);
      expect(screen.queryByRole('option', { name: /Amount \(with sign\)/ })).toBeInTheDocument();
      expect(onText).toHaveBeenLastCalledWith('transaction.amount');
    });

    it('leaves Enter to the box, a new line, when nothing is highlighted', () => {
      render(<Harness />);
      type('transaction.a');
      const proceeded = fireEvent.keyDown(box(), { key: 'Enter' });
      expect(proceeded).toBe(true);
      expect(box()).toHaveValue('transaction.a');
    });

    it('closes on Escape and opens again when the text changes', () => {
      render(<Harness />);
      type('transaction.a');
      const dismissed = fireEvent.keyDown(box(), { key: 'Escape' });
      expect(dismissed).toBe(false);
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
      // Keys do nothing while it is closed.
      expect(fireEvent.keyDown(box(), { key: 'ArrowDown' })).toBe(true);
      type('transaction.am');
      expect(options()).toHaveLength(1);
    });

    it('chooses with a press of the mouse, without taking focus from the box', () => {
      render(<Harness />);
      box().focus();
      type('transaction.referenceN');
      const option = screen.getByRole('option', { name: /referenceNumber/ });
      const proceeded = fireEvent.mouseDown(option);
      expect(proceeded).toBe(false);
      expect(box()).toHaveValue('transaction.referenceNumber');
      expect(document.activeElement).toBe(box());
    });

    it('follows a chosen field with its operators, then its values, then closes over the reference', () => {
      render(<Harness />);
      type('transaction.');
      fireEvent.mouseDown(screen.getByRole('option', { name: /accountId/ }));
      expect(box()).toHaveValue('transaction.accountId');
      type('transaction.accountId ');
      expect(options()).toEqual(['==is', '!=is not', 'inis any of']);
      fireEvent.mouseDown(screen.getByRole('option', { name: /^==/ }));
      expect(box()).toHaveValue('transaction.accountId == ');
      expect(options()).toEqual(['account("Chequing", 1)', 'account("RRSP")', 'account("Chequing", 2)', 'account("Say \\"hi\\" \\\\ there")']);
      fireEvent.mouseDown(screen.getByRole('option', { name: 'account("RRSP")' }));
      expect(box()).toHaveValue('transaction.accountId == account("RRSP")');
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('offers names inside the quotes and inserts the name form, never an id', () => {
      render(<Harness />);
      type('transaction.payeeId == payee("ama');
      expect(options()).toEqual(['Amazon (1)', 'Amazon (2)', 'Amazon (3)']);
      fireEvent.mouseDown(screen.getByRole('option', { name: 'Amazon (2)' }));
      expect(box()).toHaveValue('transaction.payeeId == payee("Amazon", 2)');
      expect(box().value).not.toMatch(/pay-\d/);
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();

      type('transaction.categoryId.inSubtree(category("fo');
      fireEvent.keyDown(box(), { key: 'ArrowDown' });
      fireEvent.keyDown(box(), { key: 'ArrowDown' });
      fireEvent.keyDown(box(), { key: 'Enter' });
      expect(box()).toHaveValue('transaction.categoryId.inSubtree(category("Food: Coffee")');
    });

    it('escapes a name with quotes when it inserts it', () => {
      render(<Harness />);
      type('transaction.accountId == account("say');
      fireEvent.mouseDown(screen.getByRole('option'));
      expect(box()).toHaveValue('transaction.accountId == account("Say \\"hi\\" \\\\ there")');
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('offers the methods of the field and the enum members', () => {
      render(<Harness />);
      type('transaction.tagIds.');
      expect(options()).toEqual(['hasAnyhas any of', 'hasAllhas all of', 'hasNonehas none of']);
      type('transaction.type == "');
      expect(options()).toEqual(['EXPENSEExpense', 'INCOMEIncome', 'TRANSFERTransfer']);
      fireEvent.mouseDown(screen.getByRole('option', { name: /TRANSFER/ }));
      expect(box()).toHaveValue('transaction.type == "TRANSFER"');
    });

    it('recomputes when the caret moves without the text changing', () => {
      render(
        <Harness initial="transaction.referenceNumber == 'x' && transaction.am" />,
      );
      // React reports a moved caret (a click here) only for the focused box.
      box().focus();
      const end = box().value.length;
      box().setSelectionRange(end, end);
      fireEvent.mouseUp(box());
      expect(options()).toEqual(['amountAmount (with sign)']);
      // Just after the finished value 'x': nothing to offer.
      box().setSelectionRange(34, 34);
      fireEvent.mouseUp(box());
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    });
  });
});
