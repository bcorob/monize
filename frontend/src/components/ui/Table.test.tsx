import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import {
  SortableTh,
  Th,
  Td,
  CellLabel,
  TABLE_CLASS,
  TABLE_BODY_CLASS,
  TH_CLASS,
  TD_CLASS,
  PHONE_HEADER_CLASS,
  CAPTION_CLASS,
} from './Table';

function renderCell(cell: React.ReactNode) {
  return render(
    <table>
      <tbody>
        <tr>{cell}</tr>
      </tbody>
    </table>,
  );
}

describe('CellLabel', () => {
  it('wraps even inside a nowrap money cell, and stays on the gray ramp', () => {
    // `white-space` is inherited: a caption inside a `whitespace-nowrap` cell
    // that did not take `whitespace-normal` back could not wrap, and an
    // unbreakable caption overflowed its grid track at 320px.
    renderCell(
      <Td className="whitespace-nowrap">
        <CellLabel className="sm:hidden">Expenses</CellLabel>
        1 234 zł
      </Td>,
    );
    const caption = screen.getByText('Expenses');
    expect(caption.tagName).toBe('SPAN');
    expect(caption.className).toContain('whitespace-normal');
    expect(caption.className).toContain('sm:hidden');
    expect(caption.className).toMatch(/text-gray-/);
    expect(caption.className).not.toMatch(/#[0-9a-f]{3,6}/i);
  });
});

describe('Table chrome', () => {
  // The VALUES of the shared chrome classes belong here, next to the component
  // that exports them. Where they may be DECLARED does not: that scan lives
  // once, in `src/test/ui-conventions.test.ts`, and this file used to
  // re-implement it -- with its own `readdirSync` walk over `src/components`
  // alone (so `src/app` and `src/lib` were unscanned), including `*.test.tsx`,
  // and matching raw bytes rather than comment-stripped source. That last one
  // is the reason it is gone rather than merged: the surviving scan's own
  // explanation has to NAME the pattern it bans, and a guard that reads its
  // explanation as a violation invites somebody to weaken the explanation.
  it('owns the shared phone header and caption breakpoint classes', () => {
    expect(PHONE_HEADER_CLASS).toContain('uppercase');
    expect(PHONE_HEADER_CLASS).toContain('dark:bg-gray-800');
    expect(CAPTION_CLASS).toBe('sm:hidden');
  });

  it('rules rows on the gray ramp, so the colour themes re-skin them', () => {
    for (const value of [TABLE_CLASS, TABLE_BODY_CLASS, TH_CLASS, TD_CLASS]) {
      expect(value).not.toMatch(/#[0-9a-f]{3,6}/i);
      expect(value).toMatch(/gray-/);
    }
  });

  it('gives the table and its body the same rules', () => {
    // A table that divides at one level and not the other draws a stray line
    // under the header, or none at all.
    expect(TABLE_CLASS).toContain(TABLE_BODY_CLASS);
  });

  it('renders Th with the shared header styling', () => {
    renderCell(<Th>Amount</Th>);
    const th = screen.getByText('Amount');
    expect(th.tagName).toBe('TH');
    expect(th.className).toContain('uppercase');
    expect(th.className).toContain('text-xs');
  });

  it('aligns left by default and right on request', () => {
    // `<th>` is centred by the UA stylesheet, so a numeric column that does
    // not say `right` lands in the middle of its cell.
    const { unmount } = renderCell(<Th>Name</Th>);
    expect(screen.getByText('Name').className).toContain('text-left');
    unmount();

    renderCell(<Th align="right">Balance</Th>);
    expect(screen.getByText('Balance').className).toContain('text-right');
  });

  it('renders Td with body styling and passes attributes through', () => {
    renderCell(<Td colSpan={3}>Nothing yet</Td>);
    const td = screen.getByText('Nothing yet');
    expect(td.tagName).toBe('TD');
    expect(td).toHaveAttribute('colspan', '3');
    expect(td.className).toContain('text-sm');
  });

  it('lets a call site override padding without losing the rest', () => {
    renderCell(<Th className="px-6">Wide</Th>);
    const th = screen.getByText('Wide');
    expect(th.className).toContain('px-6');
    expect(th.className).not.toContain('px-4');
    expect(th.className).toContain('uppercase');
  });
});

describe('SortableTh', () => {
  const renderHeader = (field: 'code' | 'name', onSort = vi.fn()) =>
    render(
      <table>
        <thead>
          <tr>
            <SortableTh field={field} sortField="code" sortDirection="desc" onSort={onSort} align="right">
              Label
            </SortableTh>
          </tr>
        </thead>
      </table>,
    );

  it('is a th in TH_CLASS holding a button, so the keyboard reaches the sort', () => {
    const onSort = vi.fn();
    renderHeader('name', onSort);
    const button = screen.getByRole('button', { name: /Label/ });
    const th = button.closest('th')!;
    expect(th.className).toContain(TH_CLASS);
    expect(th.className).toContain('text-right');
    expect(th).not.toHaveAttribute('onclick');
    fireEvent.click(button);
    expect(onSort).toHaveBeenCalledWith('name');
  });

  it('announces the direction on the sorted column only', () => {
    const { unmount } = renderHeader('code');
    expect(screen.getByRole('columnheader')).toHaveAttribute('aria-sort', 'descending');
    unmount();
    renderHeader('name');
    expect(screen.getByRole('columnheader')).toHaveAttribute('aria-sort', 'none');
  });
});
