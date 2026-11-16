import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@/test/render';
import { BankSyncProfileNotes } from './BankSyncProfileNotes';
import type { BankSyncProfileNote } from '@/types/bank-sync';

const warning: BankSyncProfileNote = {
  id: 'gluedFields',
  severity: 'warning',
  text: 'The bank joins the town and the merchant.',
  lang: 'en',
};
const info: BankSyncProfileNote = {
  id: 'operationCodeLine',
  severity: 'info',
  text: 'The operation type is on line two.',
  lang: 'en',
};

describe('BankSyncProfileNotes', () => {
  it('renders nothing for no notes', () => {
    const { container } = render(<BankSyncProfileNotes notes={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('lists the notes under the heading, in the order given, with the server text as it is', () => {
    render(<BankSyncProfileNotes notes={[warning, info]} />);

    expect(screen.getByRole('heading', { name: "How this bank's API works" })).toBeInTheDocument();
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('The bank joins the town and the merchant.');
    expect(items[1]).toHaveTextContent('The operation type is on line two.');
  });

  it('sets a warning apart from an info note, in colour and for a screen reader', () => {
    render(<BankSyncProfileNotes notes={[warning, info]} />);
    const [warningItem, infoItem] = screen.getAllByRole('listitem');

    expect(warningItem).toHaveAttribute('data-severity', 'warning');
    expect(warningItem.className).toContain('bg-amber-50');
    expect(within(warningItem).getByText('Warning:', { exact: false })).toHaveClass('sr-only');

    expect(infoItem).toHaveAttribute('data-severity', 'info');
    expect(infoItem.className).not.toContain('bg-amber-50');
    expect(within(infoItem).getByText('Note:', { exact: false })).toHaveClass('sr-only');
  });

  it('marks each text with the language it is really in, so a screen reader pronounces it right', () => {
    render(
      <BankSyncProfileNotes
        notes={[
          { ...warning, text: 'Bank laczy pola.', lang: 'pl' },
          { ...info, lang: 'en' },
        ]}
      />,
    );

    expect(screen.getByText('Bank laczy pola.')).toHaveAttribute('lang', 'pl');
    expect(screen.getByText('The operation type is on line two.')).toHaveAttribute('lang', 'en');
  });
});
