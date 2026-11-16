import { describe, it, expect } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent } from '@/test/render';
import { ParserProposalFields } from './ParserProposalFields';
import { emptyParserForm, type ParserFormChange, type ParserFormState } from '@/lib/receipt-parser-form';

function Harness({ initial, onForm }: { initial?: Partial<ParserFormState>; onForm: (form: ParserFormState) => void }) {
  const [form, setForm] = useState(() => emptyParserForm(initial));
  const change: ParserFormChange = (changes) =>
    setForm((current) => {
      const next = { ...current, ...(typeof changes === 'function' ? changes(current) : changes) };
      onForm(next);
      return next;
    });
  return <ParserProposalFields form={form} onChange={change} />;
}

describe('ParserProposalFields', () => {
  it('shows no tag name until the tag is switched on, then offers the profile\'s own name', () => {
    const forms: ParserFormState[] = [];
    render(<Harness initial={{ name: ' Allegro ' }} onForm={(form) => forms.push(form)} />);
    expect(screen.queryByLabelText('Tag name')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: /Add a tag/ }));
    expect(screen.getByLabelText('Tag name')).toHaveValue('Allegro');
    expect(forms.at(-1)).toMatchObject({ tagEnabled: true, tagName: 'Allegro' });
  });

  it('keeps a tag name the person already chose', () => {
    render(<Harness initial={{ name: 'Allegro', tagName: 'Orders' }} onForm={() => {}} />);
    fireEvent.click(screen.getByRole('checkbox', { name: /Add a tag/ }));
    expect(screen.getByLabelText('Tag name')).toHaveValue('Orders');
  });

  it('writes the tag name', () => {
    const forms: ParserFormState[] = [];
    render(<Harness initial={{ tagEnabled: true, tagName: 'Orders' }} onForm={(form) => forms.push(form)} />);
    fireEvent.change(screen.getByLabelText('Tag name'), { target: { value: 'Shop orders' } });
    expect(forms.at(-1)?.tagName).toBe('Shop orders');
  });

  it('switches the AI categories on and off', () => {
    const forms: ParserFormState[] = [];
    render(<Harness onForm={(form) => forms.push(form)} />);
    const box = screen.getByRole('checkbox', { name: /Let the AI choose the category/ });
    expect(box).not.toBeChecked();
    fireEvent.click(box);
    expect(forms.at(-1)?.aiCategories).toBe(true);
    fireEvent.click(box);
    expect(forms.at(-1)?.aiCategories).toBe(false);
  });
});
