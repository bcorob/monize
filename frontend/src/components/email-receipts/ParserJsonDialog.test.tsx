import { describe, it, expect, vi, beforeEach } from 'vitest';
import toast from 'react-hot-toast';
import { render, screen, fireEvent, act } from '@/test/render';
import { ParserJsonDialog } from './ParserJsonDialog';
import { makeParser } from './email-receipts-fixtures';

const DEFINITION = {
  version: 2,
  total: [{ label: 'RAZEM', value: '{amount} zł', within: 3 }],
  items: { skipLines: ['<*>'], record: [{ line: '{name}' }, { line: '{amount} zł' }] },
};

const writeText = vi.fn();

const copy = async () => {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
  });
};

describe('ParserJsonDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    writeText.mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  });

  it('shows the stored definition pretty-printed, read-only, under the profile name', () => {
    render(<ParserJsonDialog parser={makeParser({ definition: DEFINITION })} onClose={vi.fn()} />);
    expect(screen.getByRole('dialog', { name: 'Definition of Allegro parser' })).toBeInTheDocument();
    const pre = screen.getByLabelText('Definition JSON');
    expect(pre.tagName).toBe('PRE');
    expect(pre.textContent).toBe(JSON.stringify(DEFINITION, null, 2));
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('shows the effective matching the server answers, defaults included, and says that it does', () => {
    const effective = {
      version: 2,
      reference: ['Ref {reference}'],
      match: {
        by: ['reference', 'orderId', 'amount_payee', 'amount_date'],
        referenceIn: ['description', 'payee', 'referenceNumber'],
        daysBefore: 3,
        daysAfter: 14,
        amountTolerance: '0.00',
      },
    };
    render(<ParserJsonDialog parser={makeParser({ definition: effective })} onClose={vi.fn()} />);
    const text = screen.getByLabelText('Definition JSON').textContent ?? '';
    expect(JSON.parse(text).match).toEqual(effective.match);
    expect(screen.getByText(/The matching section shows the settings in effect, defaults included/)).toBeInTheDocument();
  });

  it('shows a definition as text, never as HTML', () => {
    const parser = makeParser({ definition: { version: 2, orderId: ['<img src=x onerror=alert(1)>{orderid}'] } });
    render(<ParserJsonDialog parser={parser} onClose={vi.fn()} />);
    expect(document.querySelector('img')).toBeNull();
    expect(screen.getByLabelText('Definition JSON').textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('shows what is stored even when it is invalid, such as an old version 1 definition', () => {
    const parser = makeParser({ definition: { version: 1, total: ['T {amount}'] }, definitionValid: false });
    render(<ParserJsonDialog parser={parser} onClose={vi.fn()} />);
    expect(screen.getByLabelText('Definition JSON').textContent).toContain('"version": 1');
  });

  it('copies the JSON text to the clipboard and says so', async () => {
    render(<ParserJsonDialog parser={makeParser({ definition: DEFINITION })} onClose={vi.fn()} />);
    await copy();
    expect(writeText).toHaveBeenCalledWith(JSON.stringify(DEFINITION, null, 2));
    expect(toast.success).toHaveBeenCalledWith('JSON copied');
  });

  it('says so when the clipboard refuses', async () => {
    writeText.mockRejectedValue(new Error('denied'));
    render(<ParserJsonDialog parser={makeParser({ definition: DEFINITION })} onClose={vi.fn()} />);
    await copy();
    expect(toast.error).toHaveBeenCalledWith('Could not copy the JSON');
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('says so when there is no clipboard at all', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    render(<ParserJsonDialog parser={makeParser({ definition: DEFINITION })} onClose={vi.fn()} />);
    await copy();
    expect(toast.error).toHaveBeenCalledWith('Could not copy the JSON');
  });
});
