import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@/test/render';
import { ParserTraceList } from './ParserTraceList';
import type { ReceiptTrace } from '@/types/email-receipts';

const empty: ReceiptTrace = {
  orderId: null,
  reference: null,
  total: null,
  paid: null,
  shipping: null,
  discount: null,
  payee: null,
  requireLine: null,
  skipIfLine: null,
  waitIfLine: null,
  items: [],
};

describe('ParserTraceList', () => {
  it('says so when nothing was read', () => {
    render(<ParserTraceList trace={empty} />);
    expect(screen.getByText('Matched by')).toBeInTheDocument();
    expect(screen.getByText('No value was read from this email.')).toBeInTheDocument();
  });

  it('lists each field that read something with its entry, glob, line number and text', () => {
    render(
      <ParserTraceList
        trace={{
          ...empty,
          total: { entry: 1, pattern: 'Razem: {amount} zł', line: { line: 14, text: 'Razem: 24,99 zł' } },
          paid: { entry: 0, pattern: 'Visa-*: {amount} zł', line: { line: 19, text: 'Visa-1234: 21,99 zł' } },
        }}
      />,
    );
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('Total entry 2 (Razem: {amount} zł), line 14: Razem: 24,99 zł');
    expect(items[1]).toHaveTextContent('Paid entry 1 (Visa-*: {amount} zł), line 19: Visa-1234: 21,99 zł');
  });

  it('gives a labelled entry both its label line and its value line', () => {
    render(
      <ParserTraceList
        trace={{
          ...empty,
          total: {
            entry: 0,
            pattern: '{amount} zł',
            label: 'RAZEM',
            labelLine: { line: 44, text: 'RAZEM' },
            line: { line: 45, text: '59,20 zł' },
          },
        }}
      />,
    );
    expect(screen.getByRole('listitem')).toHaveTextContent(
      'Total entry 1, label RAZEM on line 44 (RAZEM), value {amount} zł on line 45: 59,20 zł',
    );
  });

  it('lists every line a multi-line pattern matched', () => {
    render(
      <ParserTraceList
        trace={{
          ...empty,
          total: {
            entry: 0,
            pattern: 'Receipt from *\\n{amount}\\nPaid',
            line: { line: 2, text: 'Receipt from Anthropic, PBC' },
            lines: [
              { line: 2, text: 'Receipt from Anthropic, PBC' },
              { line: 3, text: '$333' },
              { line: 4, text: 'Paid' },
            ],
          },
        }}
      />,
    );
    const [hit, ...lines] = screen.getAllByRole('listitem');
    expect(hit).toHaveTextContent('Total entry 1 (Receipt from *\\n{amount}\\nPaid), lines 2 to 4:');
    expect(lines.map((line) => line.textContent)).toEqual([
      'line 2: Receipt from Anthropic, PBC',
      'line 3: $333',
      'line 4: Paid',
    ]);
  });

  it('names the subject when the order number came from it', () => {
    render(
      <ParserTraceList
        trace={{ ...empty, orderId: { entry: 0, pattern: '*#{orderid}', line: { line: 0, text: 'Order #A-1' } } }}
      />,
    );
    expect(screen.getByRole('listitem')).toHaveTextContent('Order number entry 1 (*#{orderid}), the subject: Order #A-1');
  });

  it('lists each item with its lines, a record with the glob of each step', () => {
    render(
      <ParserTraceList
        trace={{
          ...empty,
          items: [
            {
              mode: 'record',
              patterns: ['{name}', '{amount} zł'],
              lines: [
                { line: 23, text: 'Szukacz Par' },
                { line: 27, text: '59,20 zł' },
              ],
            },
            { mode: 'patterns', patterns: ['{name} {amount} zł'], lines: [{ line: 30, text: 'Pen 1,00 zł' }] },
          ],
        }}
      />,
    );
    expect(screen.getByText('Item 1')).toBeInTheDocument();
    expect(screen.getByText('Item 2')).toBeInTheDocument();
    expect(screen.getByText('{name}, line 23: Szukacz Par')).toBeInTheDocument();
    expect(screen.getByText('{amount} zł, line 27: 59,20 zł')).toBeInTheDocument();
    expect(screen.getByText('{name} {amount} zł, line 30: Pen 1,00 zł')).toBeInTheDocument();
  });

  it('shows email text as text, never as markup', () => {
    render(
      <ParserTraceList
        trace={{ ...empty, payee: { entry: 0, pattern: '{payee}', line: { line: 3, text: '<img src=x onerror=alert(1)>' } } }}
      />,
    );
    expect(document.querySelector('img')).toBeNull();
    expect(within(screen.getByRole('listitem')).getByText(/<img src=x/)).toBeInTheDocument();
  });

  it('lists the line a component link key was read from, and nothing for a trace without one', () => {
    render(
      <ParserTraceList
        trace={{ ...empty, linkKey: { entry: 0, pattern: 'Order {value}', line: { line: 3, text: 'Order KEY-9' } } }}
      />,
    );
    expect(screen.getByRole('listitem')).toHaveTextContent('Link key entry 1 (Order {value}), line 3: Order KEY-9');
  });
});
