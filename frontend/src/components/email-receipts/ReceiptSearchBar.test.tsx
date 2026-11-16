import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { ReceiptSearchBar } from './ReceiptSearchBar';
import { EMPTY_RECEIPT_SEARCH_INPUT } from '@/lib/receipt-search';

function setup(overrides: Partial<React.ComponentProps<typeof ReceiptSearchBar>> = {}) {
  const props = {
    input: EMPTY_RECEIPT_SEARCH_INPUT,
    onChange: vi.fn(),
    onClear: vi.fn(),
    canClear: false,
    rangeBackwards: false,
    ...overrides,
  };
  render(<ReceiptSearchBar {...props} />);
  return props;
}

describe('ReceiptSearchBar', () => {
  it('reports the typed text and the chosen field', () => {
    const props = setup();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search by subject, sender or content...' }), { target: { value: 'invoice' } });
    expect(props.onChange).toHaveBeenLastCalledWith({ text: 'invoice' });
    const select = screen.getByRole('combobox', { name: 'Search in' });
    expect(Array.from((select as HTMLSelectElement).options).map((option) => option.textContent)).toEqual([
      'All fields',
      'Subject',
      'Sender',
      'Content',
    ]);
    fireEvent.change(select, { target: { value: 'sender' } });
    expect(props.onChange).toHaveBeenLastCalledWith({ searchIn: 'sender' });
  });

  it('draws no label above the search text: the placeholder names what is searched', () => {
    setup();
    const box = screen.getByRole('searchbox', { name: 'Search by subject, sender or content...' });
    expect(box).toHaveAttribute('placeholder', 'Search by subject, sender or content...');
    expect(document.querySelector('label[for="receipt-search-text"]')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Search' })).not.toBeInTheDocument();
  });

  it('has two date fields and reports a typed date', () => {
    const props = setup();
    const from = screen.getByLabelText('From date');
    expect(screen.getByLabelText('To date')).toBeInTheDocument();
    fireEvent.change(from, { target: { value: '2026-09-01' } });
    fireEvent.blur(from);
    expect(props.onChange).toHaveBeenCalledWith({ dateFrom: '2026-09-01' });
  });

  it('offers Clear only when something is entered', () => {
    setup();
    expect(screen.queryByRole('button', { name: 'Clear search' })).not.toBeInTheDocument();
  });

  it('clears through the button', () => {
    const props = setup({ canClear: true, input: { ...EMPTY_RECEIPT_SEARCH_INPUT, text: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(props.onClear).toHaveBeenCalledTimes(1);
  });

  it('says a backwards range is not applied, and wraps on a phone', () => {
    setup({ rangeBackwards: true });
    expect(screen.getByText(/end date is before the start date/i)).toBeInTheDocument();
    expect(screen.getByRole('search', { name: 'Search emails' }).className).toContain('flex-wrap');
  });
});
