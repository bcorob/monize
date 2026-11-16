import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent } from '@/test/render';
import { ParserMatchFields } from './ParserMatchFields';
import { defaultMatchBy, emptyParserForm, type ParserFormChange, type ParserFormState } from '@/lib/receipt-parser-form';

/** The fields on a form held in state, so a change is seen in what the controls then show. */
function Harness({ initial, onForm }: { initial?: Partial<ParserFormState>; onForm?: (form: ParserFormState) => void }) {
  const [form, setForm] = useState(() => emptyParserForm(initial));
  const change: ParserFormChange = (changes) =>
    setForm((current) => {
      const next = { ...current, ...(typeof changes === 'function' ? changes(current) : changes) };
      onForm?.(next);
      return next;
    });
  return <ParserMatchFields form={form} onChange={change} />;
}

const order = () =>
  screen
    .getAllByRole('listitem')
    .map((item) => item.textContent)
    .filter((text): text is string => text !== null);

describe('ParserMatchFields', () => {
  it('lists the strategies that are on in the order they are tried, then the ones that are off', () => {
    render(<Harness />);
    expect(order()).toEqual(['1. Order number', '2. Amount and payee', '3. Amount and date', 'Reference']);
    expect(screen.getByRole('checkbox', { name: 'Reference' })).not.toBeChecked();
  });

  it('switches a strategy on at the end of the list', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Reference' }));
    expect(order()).toEqual(['1. Order number', '2. Amount and payee', '3. Amount and date', '4. Reference']);
  });

  it('moves a strategy earlier and later', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Move Amount and payee earlier' }));
    expect(order().slice(0, 2)).toEqual(['1. Amount and payee', '2. Order number']);
    fireEvent.click(screen.getByRole('button', { name: 'Move Amount and payee later' }));
    expect(order().slice(0, 2)).toEqual(['1. Order number', '2. Amount and payee']);
  });

  it('cannot move the first earlier or the last later', () => {
    render(<Harness />);
    expect(screen.getByRole('button', { name: 'Move Order number earlier' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move Amount and date later' })).toBeDisabled();
  });

  it('keeps the last strategy on', () => {
    render(<Harness initial={{ matchBy: ['orderId'] }} />);
    expect(screen.getByRole('checkbox', { name: /Order number/ })).toBeDisabled();
  });

  it('ignores a request to switch off the last one, whatever called it', () => {
    const forms: ParserFormState[] = [];
    render(<Harness initial={{ matchBy: ['orderId', 'amount_date'] }} onForm={(form) => forms.push(form)} />);
    fireEvent.click(screen.getByRole('checkbox', { name: /Amount and date/ }));
    expect(forms.at(-1)?.matchBy).toEqual(['orderId']);
  });

  it('warns when the reference strategy is on but there are no reference patterns', () => {
    render(<Harness initial={{ matchBy: ['reference', 'orderId'] }} />);
    expect(screen.getByRole('note')).toHaveTextContent('there are no reference patterns');
  });

  it('does not warn once there is a reference pattern', () => {
    render(<Harness initial={{ matchBy: ['reference', 'orderId'], reference: 'Ref {reference}' }} />);
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
  });

  it('tells the person what identifies the transaction best, and the default order', () => {
    render(<Harness />);
    expect(screen.getByText(/Best is a reference number taken from the bank operation description/)).toBeInTheDocument();
    expect(screen.getByText(/If there is none, the date and the amount are used/)).toBeInTheDocument();
  });

  it('puts the reference strategy first when the first reference pattern is typed, and out again when it is cleared', () => {
    render(<Harness />);
    fireEvent.change(screen.getByLabelText('Reference patterns'), { target: { value: 'Ref {reference}' } });
    expect(order()).toEqual(['1. Reference', '2. Order number', '3. Amount and payee', '4. Amount and date']);
    fireEvent.change(screen.getByLabelText('Reference patterns'), { target: { value: '' } });
    expect(order()).toEqual(['1. Order number', '2. Amount and payee', '3. Amount and date', 'Reference']);
  });

  it('keeps an order the person arranged when a reference is typed', () => {
    render(<Harness initial={{ matchBy: ['amount_date', 'orderId'] }} />);
    fireEvent.change(screen.getByLabelText('Reference patterns'), { target: { value: 'Ref {reference}' } });
    expect(order().slice(0, 2)).toEqual(['1. Amount and date', '2. Order number']);
  });

  it('writes the reference patterns', () => {
    const forms: ParserFormState[] = [];
    render(<Harness onForm={(form) => forms.push(form)} />);
    fireEvent.change(screen.getByLabelText('Reference patterns'), { target: { value: 'Ref {reference}' } });
    expect(forms.at(-1)?.reference).toBe('Ref {reference}');
  });

  it('chooses the fields a reference is looked for in, never none', () => {
    const forms: ParserFormState[] = [];
    render(<Harness onForm={(form) => forms.push(form)} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Payee name' }));
    expect(forms.at(-1)?.matchReferenceIn).toEqual(['description', 'referenceNumber']);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Payee name' }));
    expect(forms.at(-1)?.matchReferenceIn).toEqual(['description', 'payee', 'referenceNumber']);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Description' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Payee name' }));
    expect(screen.getByRole('checkbox', { name: 'Reference number' })).toBeDisabled();
  });

  it('writes the window and the tolerance, and shows the defaults and bounds as help', () => {
    const forms: ParserFormState[] = [];
    render(<Harness onForm={(form) => forms.push(form)} />);
    expect(screen.getByLabelText('Days before the purchase')).toHaveAttribute('placeholder', '3');
    expect(screen.getByLabelText('Days after the purchase')).toHaveAttribute('placeholder', '14');
    expect(screen.getByText('The window around the purchase date. Default 3, at most 60.')).toBeInTheDocument();
    expect(screen.getByText("How far the bank amount may differ from the email's total. Default 0, at most 5.")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Days after the purchase'), { target: { value: '30' } });
    expect(forms.at(-1)?.matchDaysAfter).toBe(30);
    fireEvent.change(screen.getByLabelText('Amount tolerance'), { target: { value: '0.5' } });
    expect(forms.at(-1)?.matchTolerance).toBe(0.5);
  });
});

describe('ParserMatchFields with a spy', () => {
  it('sends changes through onChange', () => {
    const onChange = vi.fn();
    render(<ParserMatchFields form={emptyParserForm()} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('Reference patterns'), { target: { value: 'x' } });
    // A function of the form, so the strategy order follows the reference.
    const change = onChange.mock.calls[0][0] as (current: ParserFormState) => Partial<ParserFormState>;
    expect(change(emptyParserForm())).toEqual({ reference: 'x', matchBy: defaultMatchBy(true) });
  });
});
