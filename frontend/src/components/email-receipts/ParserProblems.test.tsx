import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@/test/render';
import { ParserProblems } from './ParserProblems';
import { PARSER_VALIDATION_CODES } from '@/lib/receipt-parser-form';

describe('ParserProblems', () => {
  it('says where each problem is in the words of the form and what is wrong', () => {
    render(
      <ParserProblems
        problems={[
          { path: 'total[0]', code: 'capture_missing' },
          { path: 'items.patterns[1]', code: 'capture_conflict' },
          { path: 'categoryRules[2].categoryId', code: 'invalid_uuid' },
          { path: 'categoryRules[0].match', code: 'too_long' },
          { path: 'orderId', code: 'too_many' },
          { path: 'items.startAfter', code: 'too_long' },
          { path: '', code: 'not_object' },
        ]}
      />,
    );
    const alert = screen.getByRole('alert');
    expect(within(alert).getByText('Total patterns, line 1: is missing a capture this field needs')).toBeInTheDocument();
    expect(
      within(alert).getByText('Item patterns, line 2: captures both the line total and the unit price. Use one of them.'),
    ).toBeInTheDocument();
    expect(within(alert).getByText('Category rule 3, category: is not a valid category')).toBeInTheDocument();
    expect(within(alert).getByText('Category rule 1, pattern: is too long (at most 200 characters)')).toBeInTheDocument();
    expect(within(alert).getByText('Order number patterns: has too many entries (at most 10)')).toBeInTheDocument();
    expect(within(alert).getByText('Items start after: is too long (at most 100 characters)')).toBeInTheDocument();
    expect(within(alert).getByText('The definition: is not a valid definition')).toBeInTheDocument();
  });

  it('says where the linked receipts problems are and what is wrong', () => {
    render(
      <ParserProblems
        problems={[
          { path: 'role', code: 'role_invalid' },
          { path: 'linkKey[0]', code: 'capture_missing' },
          { path: 'linkKey', code: 'link_key_requires_component' },
          { path: '', code: 'link_key_missing' },
          { path: 'link', code: 'link_requires_settlement' },
          { path: 'link.fromDomains[1]', code: 'link_domain_invalid' },
          { path: 'link.fromDomains', code: 'too_many' },
          { path: 'link.daysBefore', code: 'link_days_invalid' },
          { path: 'items.patterns[0]', code: 'link_capture_requires_settlement' },
          { path: 'role', code: 'role_trade_conflict' },
        ]}
      />,
    );
    const alert = screen.getByRole('alert');
    expect(within(alert).getByText('Profile role: must be standalone, component or settlement')).toBeInTheDocument();
    expect(within(alert).getByText('Link key patterns, line 1: is missing a capture this field needs')).toBeInTheDocument();
    expect(within(alert).getByText('Link key patterns: can only be used when the role is component')).toBeInTheDocument();
    expect(within(alert).getByText('The definition: is needed when the role is component')).toBeInTheDocument();
    expect(within(alert).getByText('The link section: can only be used when the role is settlement')).toBeInTheDocument();
    expect(
      within(alert).getByText('Sender domains of the purchase emails, line 2: is not a valid sender domain (at most 10 domains)'),
    ).toBeInTheDocument();
    expect(within(alert).getByText('Sender domains of the purchase emails: has too many entries (at most 10)')).toBeInTheDocument();
    expect(within(alert).getByText('Days before the repayment: must be a whole number from 0 to 365')).toBeInTheDocument();
    expect(
      within(alert).getByText('Item patterns, line 1: uses a link or instalment capture, which only a settlement profile accepts'),
    ).toBeInTheDocument();
    expect(
      within(alert).getByText('Profile role: cannot be component or settlement in a brokerage trade profile, which reads only the trade'),
    ).toBeInTheDocument();
  });

  it('says where a labelled entry, a record step and a skip line are', () => {
    render(
      <ParserProblems
        problems={[
          { path: 'total[0].within', code: 'out_of_range' },
          { path: 'shipping[1].label', code: 'capture_not_allowed' },
          { path: 'items.record[2].line', code: 'duplicate_capture' },
          { path: 'items.record[0]', code: 'invalid_type' },
          { path: 'items.record', code: 'record_name_missing' },
          { path: 'items.record', code: 'too_many' },
          { path: 'items.skipLines', code: 'too_many' },
          { path: 'items.skipLines[3]', code: 'capture_not_allowed' },
          { path: 'items', code: 'items_patterns_and_record' },
          { path: 'version', code: 'unsupported_version' },
        ]}
      />,
    );
    const alert = screen.getByRole('alert');
    expect(within(alert).getByText('Total patterns, entry 1, within: must be a whole number from 1 to 10')).toBeInTheDocument();
    expect(
      within(alert).getByText('Shipping patterns, entry 2, label: uses a capture name this field does not accept'),
    ).toBeInTheDocument();
    expect(within(alert).getByText('Record step 3, line: uses the same capture name twice')).toBeInTheDocument();
    expect(within(alert).getByText('Record step 1: has the wrong kind of value')).toBeInTheDocument();
    expect(within(alert).getByText('Record: must capture {name} in one of its steps')).toBeInTheDocument();
    expect(within(alert).getByText('Record: has too many entries (at most 6)')).toBeInTheDocument();
    expect(within(alert).getByText('Lines to skip: has too many entries (at most 10)')).toBeInTheDocument();
    expect(within(alert).getByText('Line to skip 4: uses a capture name this field does not accept')).toBeInTheDocument();
    expect(within(alert).getByText('Line items: has both patterns and a record. Use one of them.')).toBeInTheDocument();
    expect(
      within(alert).getByText('The definition: is a version this server does not read (use version 2)'),
    ).toBeInTheDocument();
  });

  it('says where the guards, the single item, the alternatives and a rule field are', () => {
    render(
      <ParserProblems
        problems={[
          { path: 'requireLine', code: 'too_many' },
          { path: 'skipIfLine[1]', code: 'capture_not_allowed' },
          { path: 'waitIfLine[0]', code: 'empty' },
          { path: 'paid[0]', code: 'capture_missing' },
          { path: 'payee[2].label', code: 'too_long' },
          { path: 'items.single.name', code: 'capture_missing' },
          { path: 'items.single', code: 'invalid_type' },
          { path: 'items', code: 'items_single_conflict' },
          { path: 'items.joinWrapped', code: 'join_wrapped_needs_patterns' },
          { path: 'items.record[0].line', code: 'too_many' },
          { path: 'items.record[1].line[2]', code: 'capture_not_allowed' },
          { path: 'categoryRules[3].field', code: 'invalid_value' },
        ]}
      />,
    );
    const alert = screen.getByRole('alert');
    expect(within(alert).getByText('Required lines: has too many entries (at most 10)')).toBeInTheDocument();
    expect(
      within(alert).getByText('Lines that skip the email, line 2: uses a capture name this field does not accept'),
    ).toBeInTheDocument();
    expect(within(alert).getByText('Lines that hold the email, line 1: must not be empty')).toBeInTheDocument();
    expect(within(alert).getByText('Paid patterns, line 1: is missing a capture this field needs')).toBeInTheDocument();
    expect(within(alert).getByText('Merchant patterns, entry 3, label: is too long (at most 200 characters)')).toBeInTheDocument();
    expect(within(alert).getByText('Single item name: is missing a capture this field needs')).toBeInTheDocument();
    expect(within(alert).getByText('Single item: has the wrong kind of value')).toBeInTheDocument();
    expect(within(alert).getByText('Line items: has a single item beside patterns or a record. Use one of them.')).toBeInTheDocument();
    expect(within(alert).getByText('Join wrapped lines: only works with item patterns')).toBeInTheDocument();
    expect(within(alert).getByText('Record step 1, line: has too many entries (at most 5)')).toBeInTheDocument();
    expect(
      within(alert).getByText('Record step 2, alternative 3: uses a capture name this field does not accept'),
    ).toBeInTheDocument();
    expect(within(alert).getByText('Category rule 4, field: has a value this field does not accept')).toBeInTheDocument();
  });

  it('says where a bad lines source is', () => {
    render(<ParserProblems problems={[{ path: 'source', code: 'invalid_value' }]} />);
    expect(screen.getByText('Lines source: has a value this field does not accept')).toBeInTheDocument();
  });

  it('bounds a multi-line pattern by the line limit, and says where a pattern cannot span lines', () => {
    render(
      <ParserProblems
        problems={[
          { path: 'total[0]', code: 'too_many_lines' },
          { path: 'categoryRules[0].match', code: 'line_break_not_allowed' },
        ]}
      />,
    );
    expect(screen.getByText(/spans too many lines \(at most 5\)/)).toBeInTheDocument();
    expect(screen.getByText(/so it cannot span several lines/)).toBeInTheDocument();
  });

  it('bounds the number of category rules by the rule limit, not the pattern limit', () => {
    render(<ParserProblems problems={[{ path: 'categoryRules', code: 'too_many' }]} />);
    expect(screen.getByText('Category rules: has too many entries (at most 50)')).toBeInTheDocument();
  });

  it('names the fees patterns, the named categories and the balance tolerance in the words of the form', () => {
    render(
      <ParserProblems
        problems={[
          { path: 'fees[0]', code: 'capture_missing' },
          { path: 'defaultCategory', code: 'invalid_value' },
          { path: 'shippingCategory', code: 'invalid_value' },
          { path: 'feesCategory', code: 'invalid_value' },
          { path: 'balanceTolerance', code: 'out_of_range' },
        ]}
      />,
    );
    const text = screen.getAllByRole('listitem').map((item) => item.textContent ?? '');
    expect(text[0]).toMatch(/^Fees patterns, line 1: /);
    expect(text[1]).toMatch(/^Default category: /);
    expect(text[2]).toMatch(/^Shipping category: /);
    expect(text[3]).toMatch(/^Fees category: /);
    expect(text[4]).toMatch(/^Balance tolerance: /);
  });

  it('says where a trade profile problem is, with the bound and an account wording for an account id', () => {
    render(
      <ParserProblems
        problems={[
          { path: 'trade.symbol', code: 'empty' },
          { path: 'trade.quantity[1]', code: 'capture_missing' },
          { path: 'trade.date[0].label', code: 'too_long' },
          { path: 'trade.total', code: 'trade_amount_missing' },
          { path: 'trade.defaultAccountId', code: 'trade_account_missing' },
          { path: 'trade.accountRules', code: 'too_many' },
          { path: 'trade.accountRules[1].currency', code: 'invalid_currency' },
          { path: 'trade.accountRules[0].accountId', code: 'invalid_uuid' },
          { path: 'trade.defaultAccountId', code: 'invalid_uuid' },
          { path: 'trade.currencyMarkers', code: 'too_many' },
          { path: 'trade.currencyMarkers[2].match', code: 'capture_not_allowed' },
          { path: 'trade.currencyMarkers[0]', code: 'invalid_type' },
          { path: 'items', code: 'trade_conflict' },
        ]}
      />,
    );
    const text = screen.getAllByRole('listitem').map((item) => item.textContent ?? '');
    expect(text).toEqual([
      'Ticker patterns: must not be empty',
      'Share count patterns, line 2: is missing a capture this field needs',
      'Trade date patterns, entry 1, label: is too long (at most 200 characters)',
      'Trade total patterns: needs total or price patterns (at least one of the two)',
      'Default account: needs a default account, or account rules',
      'Account rules: has too many entries (at most 20)',
      'Account rule 2, currency: is not a 3-letter currency code, such as USD',
      'Account rule 1, account: is not a valid account',
      'Default account: is not a valid account',
      'Currency markers: has too many entries (at most 20)',
      'Currency marker 3, pattern: uses a capture name this field does not accept',
      'Currency marker 1: has the wrong kind of value',
      'Line items: cannot be in a brokerage trade profile, which reads only the trade',
    ]);
  });

  it('shows a path and a code this client has not heard of as they are, never drops them', () => {
    render(<ParserProblems problems={[{ path: 'somethingNew', code: 'brand_new_code' }]} />);
    expect(screen.getByText('somethingNew: brand_new_code')).toBeInTheDocument();
  });

  it('has a readable sentence for every code the server can report', () => {
    render(<ParserProblems problems={PARSER_VALIDATION_CODES.map((code) => ({ path: 'total', code }))} />);
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(PARSER_VALIDATION_CODES.length);
    for (const item of items) {
      // A missing message would render its key (`codes.xyz`) or the bare code.
      expect(item.textContent).toMatch(/^Total patterns: .+ .+/);
      expect(item.textContent).not.toMatch(/codes\./);
    }
  });
});
