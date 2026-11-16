import { describe, it, expect } from 'vitest';
import { render } from '@/test/render';
import { TaggedBalanceTooltip, orderBalanceEntries } from './TaggedBalanceTooltip';

const row = { fullName: 'Aug 2026', BalancePercent: -8.86 };
const entry = (dataKey: string, value: number) => ({ dataKey, name: dataKey, value, color: '#000', payload: row });

describe('orderBalanceEntries', () => {
  it('orders Income, Tagged inflows, Expenses, Tagged outflows, Balance whatever the bars were declared in', () => {
    const ordered = orderBalanceEntries([
      entry('Balance', -691),
      entry('TaggedOutflows', 10),
      entry('TaggedInflows', 4516),
      entry('Expenses', 8486),
      entry('Income', 3279),
    ]);
    expect(ordered.map((e) => e.dataKey)).toEqual([
      'Income',
      'TaggedInflows',
      'Expenses',
      'TaggedOutflows',
      'Balance',
    ]);
  });

  it('drops a zero Tagged outflows row and any series it does not know', () => {
    const ordered = orderBalanceEntries([
      entry('Income', 1),
      entry('TaggedOutflows', 0),
      entry('Savings', 5),
    ]);
    expect(ordered.map((e) => e.dataKey)).toEqual(['Income']);
  });
});

describe('TaggedBalanceTooltip', () => {
  const format = (v: number) => `$${v}`;
  const percent = (p: number) => `${p}%`;

  it('shows Balance % from the hovered row', () => {
    const { container } = render(
      <TaggedBalanceTooltip active payload={[entry('Balance', -691)]} formatValue={format} formatPercent={percent} />,
    );
    expect(container.textContent).toContain('Aug 2026');
    expect(container.textContent).toContain('Balance %: -8.86%');
  });

  it('shows a dash, not zero, when the row has no percentage', () => {
    const noBase = { fullName: 'Sep 2026', BalancePercent: null };
    const { container } = render(
      <TaggedBalanceTooltip
        active
        payload={[{ dataKey: 'Balance', name: 'Balance', value: -40, color: '#000', payload: noBase }]}
        formatValue={format}
        formatPercent={percent}
      />,
    );
    expect(container.textContent).toContain('Balance %: —');
  });

  it('renders nothing while inactive', () => {
    const { container } = render(
      <TaggedBalanceTooltip active={false} payload={[entry('Balance', 1)]} formatValue={format} formatPercent={percent} />,
    );
    expect(container.textContent).toBe('');
  });
});
