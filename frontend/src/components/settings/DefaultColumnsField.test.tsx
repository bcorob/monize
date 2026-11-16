import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, within } from '@/test/render';
import { DefaultColumnsField } from './DefaultColumnsField';
import { useHiddenColumnsStore } from '@/store/hiddenColumnsStore';
import type { UpdatePreferencesData } from '@/types/auth';

describe('DefaultColumnsField', () => {
  const commit = vi.fn<(patch: UpdatePreferencesData, revert: () => void) => void>();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  const group = (name: string) => within(screen.getByRole('group', { name }));

  it('ticks every column when the account hides none', () => {
    render(<DefaultColumnsField initial={undefined} commit={commit} />);

    for (const name of ['Transactions', 'Investment holdings', 'Investment transactions']) {
      const boxes = group(name).getAllByRole('checkbox');
      expect(boxes.length).toBeGreaterThan(0);
      for (const box of boxes) expect(box).toBeChecked();
    }
    expect(group('Transactions').getAllByRole('checkbox')).toHaveLength(5);
    expect(group('Investment holdings').getAllByRole('checkbox')).toHaveLength(7);
    expect(group('Investment transactions').getAllByRole('checkbox')).toHaveLength(3);
  });

  it("unticks the account's hidden columns, ignoring unknown ids", () => {
    render(
      <DefaultColumnsField
        initial={{ transactions: ['tags', 'bogus'], investmentRegister: ['price'] }}
        commit={commit}
      />,
    );

    expect(group('Transactions').getByRole('checkbox', { name: 'Tags' })).not.toBeChecked();
    expect(group('Transactions').getByRole('checkbox', { name: 'Status' })).toBeChecked();
    expect(group('Investment transactions').getByRole('checkbox', { name: 'Price' })).not.toBeChecked();
  });

  it('sends only the table kind that changed, canonicalised, for the server to merge', () => {
    render(
      <DefaultColumnsField
        initial={{ transactions: ['status'], investmentHoldings: ['avgCost'] }}
        commit={commit}
      />,
    );

    fireEvent.click(group('Transactions').getByRole('checkbox', { name: 'Tags' }));
    expect(commit).toHaveBeenLastCalledWith(
      { hiddenTableColumns: { transactions: ['tags', 'status'] } },
      expect.any(Function),
    );

    fireEvent.click(group('Transactions').getByRole('checkbox', { name: 'Status' }));
    expect(commit).toHaveBeenLastCalledWith(
      { hiddenTableColumns: { transactions: ['tags'] } },
      expect.any(Function),
    );
  });

  it('does not touch this browser’s own column choices', () => {
    useHiddenColumnsStore.setState({ columns: { transactions: ['description'] } });
    render(<DefaultColumnsField initial={{}} commit={commit} />);

    fireEvent.click(group('Transactions').getByRole('checkbox', { name: 'Tags' }));

    expect(useHiddenColumnsStore.getState().columns).toEqual({ transactions: ['description'] });
  });

  it('puts the previous set back when the save fails', () => {
    render(<DefaultColumnsField initial={{ investmentHoldings: ['shares'] }} commit={commit} />);

    fireEvent.click(group('Investment holdings').getByRole('checkbox', { name: 'Price' }));
    expect(group('Investment holdings').getByRole('checkbox', { name: 'Price' })).not.toBeChecked();

    act(() => commit.mock.calls[0][1]());
    expect(group('Investment holdings').getByRole('checkbox', { name: 'Price' })).toBeChecked();
    expect(group('Investment holdings').getByRole('checkbox', { name: 'Shares' })).not.toBeChecked();
  });

  it('does not let an earlier failed save undo a later change still in flight', () => {
    render(<DefaultColumnsField initial={{}} commit={commit} />);

    fireEvent.click(group('Transactions').getByRole('checkbox', { name: 'Tags' }));
    fireEvent.click(group('Transactions').getByRole('checkbox', { name: 'Status' }));

    act(() => commit.mock.calls[0][1]());
    expect(group('Transactions').getByRole('checkbox', { name: 'Tags' })).not.toBeChecked();
    expect(group('Transactions').getByRole('checkbox', { name: 'Status' })).not.toBeChecked();
  });
});
