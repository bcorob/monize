import { describe, it, expect, vi } from 'vitest';
import { act, render, screen, fireEvent } from '@/test/render';
import { ActionMenu } from './ActionMenu';
import { SortableHeader } from './SortableHeader';
import { useLongPress } from '@/hooks/useLongPress';

function renderHeader(props: Partial<Parameters<typeof SortableHeader>[0]> = {}) {
  const onSort = vi.fn();
  const utils = render(
    <table>
      <thead>
        <tr>
          <SortableHeader<'name' | 'amount'>
            field="name"
            sortField="name"
            sortDirection="asc"
            onSort={onSort}
            {...(props as any)}
          >
            Name
          </SortableHeader>
        </tr>
      </thead>
    </table>,
  );
  return { ...utils, onSort };
}

describe('SortableHeader', () => {
  it('renders the children label', () => {
    renderHeader();
    expect(screen.getByText('Name')).toBeInTheDocument();
  });

  it('shows ascending indicator when sorted asc on this field', () => {
    renderHeader({ sortDirection: 'asc' });
    expect(screen.getByText('↑')).toBeInTheDocument();
  });

  it('shows descending indicator when sorted desc on this field', () => {
    renderHeader({ sortDirection: 'desc' });
    expect(screen.getByText('↓')).toBeInTheDocument();
  });

  it('shows neutral indicator when sorted by a different field', () => {
    renderHeader({ sortField: 'amount' });
    expect(screen.getByText('↕')).toBeInTheDocument();
  });

  it('exposes only the active direction and hides the visual glyph', () => {
    const { rerender } = renderHeader({ sortDirection: 'desc' });
    const header = screen.getByRole('columnheader', { name: 'Name' });
    expect(header).toHaveAttribute('aria-sort', 'descending');
    expect(screen.getByText('↓')).toHaveAttribute('aria-hidden', 'true');

    rerender(
      <table>
        <thead>
          <tr>
            <SortableHeader<'name' | 'amount'>
              field="name"
              sortField="amount"
              sortDirection="asc"
              onSort={vi.fn()}
            >
              Name
            </SortableHeader>
          </tr>
        </thead>
      </table>,
    );
    expect(screen.getByRole('columnheader', { name: 'Name' })).toHaveAttribute('aria-sort', 'none');
  });

  it('calls onSort with this field when clicked', () => {
    const { onSort } = renderHeader();
    fireEvent.click(screen.getByText('Name'));
    expect(onSort).toHaveBeenCalledWith('name');
  });

  it.each(['Enter', ' '])('sorts from the keyboard with %j', (key) => {
    const { onSort } = renderHeader();
    const header = screen.getByRole('columnheader', { name: 'Name' });
    expect(header).toHaveAttribute('tabindex', '0');

    fireEvent.keyDown(header, { key });

    expect(onSort).toHaveBeenCalledOnce();
    expect(onSort).toHaveBeenCalledWith('name');
  });

  it('ignores unrelated keys', () => {
    const { onSort } = renderHeader();
    fireEvent.keyDown(screen.getByRole('columnheader', { name: 'Name' }), { key: 'ArrowDown' });
    expect(onSort).not.toHaveBeenCalled();
  });
});

describe('SortableHeader controls slot', () => {
  it('does not sort when the control inside the header is used', () => {
    // The register's Date header hosts the year toggle. Before the slot
    // existed, every use of that toggle also re-sorted the column.
    const onSort = vi.fn();
    const onToggle = vi.fn();
    render(
      <table>
        <thead>
          <tr>
            <SortableHeader
              field="date"
              sortField="date"
              sortDirection="desc"
              onSort={onSort}
              controls={
                <button type="button" onClick={onToggle}>
                  Hide the year
                </button>
              }
            >
              Date
            </SortableHeader>
          </tr>
        </thead>
      </table>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Hide the year' }));
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onSort).not.toHaveBeenCalled();
    expect(screen.getByRole('columnheader')).toHaveAttribute('aria-sort', 'descending');

    // Keyboard activation of the control is the same decision.
    fireEvent.keyDown(screen.getByRole('button', { name: 'Hide the year' }), { key: 'Enter' });
    expect(onSort).not.toHaveBeenCalled();

    // The header itself still sorts.
    fireEvent.click(screen.getByRole('columnheader'));
    expect(onSort).toHaveBeenCalledWith('date');
  });
});

describe('SortableHeader pressHandlers', () => {
  function PressHeader({ onSort, onLongPress }: { onSort: (f: 'status') => void; onLongPress: () => void }) {
    const { getRowHandlers } = useLongPress<'status'>({ onLongPress, onClick: onSort });
    return (
      <table>
        <thead>
          <tr>
            <SortableHeader
              field="status"
              sortField="status"
              sortDirection="asc"
              onSort={onSort}
              pressHandlers={getRowHandlers('status')}
            >
              Status
            </SortableHeader>
          </tr>
        </thead>
      </table>
    );
  }

  it('sorts exactly once on a click, through the press handlers', () => {
    // The header's own onClick is dropped when handlers are given; spreading
    // both would sort twice per click.
    const onSort = vi.fn();
    render(<PressHeader onSort={onSort} onLongPress={vi.fn()} />);

    fireEvent.click(screen.getByRole('columnheader', { name: /Status/ }));

    expect(onSort).toHaveBeenCalledOnce();
    expect(onSort).toHaveBeenCalledWith('status');
  });

  it('does not sort on a right-click, which is the long-press', () => {
    const onSort = vi.fn();
    const onLongPress = vi.fn();
    render(<PressHeader onSort={onSort} onLongPress={onLongPress} />);

    fireEvent.contextMenu(screen.getByRole('columnheader', { name: /Status/ }));

    expect(onLongPress).toHaveBeenCalledOnce();
    expect(onSort).not.toHaveBeenCalled();
  });

  it.each(['Enter', ' '])('still sorts from the keyboard with %j', (key) => {
    const onSort = vi.fn();
    render(<PressHeader onSort={onSort} onLongPress={vi.fn()} />);

    fireEvent.keyDown(screen.getByRole('columnheader', { name: /Status/ }), { key });

    expect(onSort).toHaveBeenCalledOnce();
    expect(onSort).toHaveBeenCalledWith('status');
  });

  function WithControl({
    onSort,
    onLongPress,
    withPressHandlers = true,
  }: {
    onSort: (f: 'date') => void;
    onLongPress: () => void;
    withPressHandlers?: boolean;
  }) {
    const { getRowHandlers } = useLongPress<'date'>({ onLongPress, onClick: onSort });
    return (
      <>
        <ActionMenu label="Maintenance" items={[{ id: 'merge', label: 'Merge', onSelect: vi.fn() }]} />
        <table>
          <thead>
            <tr>
              <SortableHeader
                field="date"
                sortField="date"
                sortDirection="desc"
                onSort={onSort}
                pressHandlers={withPressHandlers ? getRowHandlers('date') : undefined}
                controls={<button type="button">Hide the year</button>}
              >
                Date
              </SortableHeader>
            </tr>
          </thead>
        </table>
      </>
    );
  }

  it('keeps a press on a header control from starting a long-press', () => {
    vi.useFakeTimers();
    try {
      const onSort = vi.fn();
      const onLongPress = vi.fn();
      render(<WithControl onSort={onSort} onLongPress={onLongPress} />);
      const control = screen.getByRole('button', { name: 'Hide the year' });

      fireEvent.contextMenu(control);
      fireEvent.mouseDown(control, { button: 0 });
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      fireEvent.mouseUp(control);
      fireEvent.click(control);

      expect(onLongPress).not.toHaveBeenCalled();
      expect(onSort).not.toHaveBeenCalled();

      // A press on the header itself still is one.
      fireEvent.contextMenu(screen.getByRole('columnheader'));
      expect(onLongPress).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([true, false])(
    'lets a press on a header control close a popover open elsewhere (pressHandlers: %s)',
    (withPressHandlers) => {
      // Click-outside listens for mousedown on the document; a control that
      // stopped its mousedown would leave every open menu open.
      render(<WithControl onSort={vi.fn()} onLongPress={vi.fn()} withPressHandlers={withPressHandlers} />);
      fireEvent.click(screen.getByRole('button', { name: 'Maintenance' }));
      expect(screen.getByRole('menu')).toBeInTheDocument();

      fireEvent.mouseDown(screen.getByRole('button', { name: 'Hide the year' }), { button: 0 });

      expect(screen.queryByRole('menu')).toBeNull();
    },
  );
});
