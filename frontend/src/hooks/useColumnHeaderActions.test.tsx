import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, render, renderHook, screen, fireEvent } from '@/test/render';
import { useColumnHeaderActions } from './useColumnHeaderActions';
import { SortableHeader } from '@/components/ui/SortableHeader';

type Col = 'refNumber' | 'status';

const COLUMNS = [
  { id: 'refNumber', label: 'Ref #' },
  { id: 'status', label: 'Status' },
] as const;

function Harness({
  onHide,
  onHeaderClick,
}: {
  onHide: (id: Col) => void;
  onHeaderClick: (id: string) => void;
}) {
  const { headerHandlers, sheet } = useColumnHeaderActions<Col>({
    columns: COLUMNS,
    onHide,
    onHeaderClick,
  });
  return (
    <>
      <table>
        <thead>
          <tr>
            {(['date', 'refNumber', 'status'] as const).map((id) => (
              <SortableHeader
                key={id}
                field={id}
                sortField="date"
                sortDirection="desc"
                onSort={onHeaderClick}
                pressHandlers={headerHandlers(id)}
              >
                {id === 'date' ? 'Date' : COLUMNS.find((c) => c.id === id)!.label}
              </SortableHeader>
            ))}
          </tr>
        </thead>
      </table>
      {sheet}
    </>
  );
}

function setup() {
  const onHide = vi.fn();
  const onHeaderClick = vi.fn();
  render(<Harness onHide={onHide} onHeaderClick={onHeaderClick} />);
  const header = (name: string) => screen.getByRole('columnheader', { name: new RegExp(name) });
  return { onHide, onHeaderClick, header };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('useColumnHeaderActions', () => {
  it('opens the sheet titled with the column on a right-click of a hideable header', () => {
    const { header, onHeaderClick } = setup();

    fireEvent.contextMenu(header('Status'));

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('Status');
    expect(dialog).toHaveTextContent('Bring it back from the Columns menu.');
    expect(screen.getByRole('button', { name: 'Hide column' })).toBeInTheDocument();
    expect(onHeaderClick).not.toHaveBeenCalled();
  });

  it('hides the column from the sheet and closes it', () => {
    const { header, onHide } = setup();

    fireEvent.contextMenu(header('Ref #'));
    fireEvent.click(screen.getByRole('button', { name: 'Hide column' }));

    expect(onHide).toHaveBeenCalledExactlyOnceWith('refNumber');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens the sheet on a press held past the long-press delay, without sorting', () => {
    vi.useFakeTimers();
    const { header, onHeaderClick } = setup();

    fireEvent.mouseDown(header('Status'), { button: 0 });
    act(() => {
      vi.advanceTimersByTime(800);
    });
    fireEvent.mouseUp(header('Status'));
    // The click that trails the release is the long-press's, not a sort.
    fireEvent.click(header('Status'));

    expect(screen.getByRole('dialog')).toHaveTextContent('Status');
    expect(onHeaderClick).not.toHaveBeenCalled();
  });

  it('passes a plain click on a hideable header through as a sort, once', () => {
    const { header, onHeaderClick } = setup();

    fireEvent.click(header('Status'));

    expect(onHeaderClick).toHaveBeenCalledExactlyOnceWith('status');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('gives a structural column no handlers, so its header sorts as before', () => {
    const { result } = renderHook(() =>
      useColumnHeaderActions<Col>({ columns: COLUMNS, onHide: vi.fn(), onHeaderClick: vi.fn() }),
    );
    expect(result.current.headerHandlers('date')).toBeUndefined();
    expect(result.current.headerHandlers('payee')).toBeUndefined();
    expect(result.current.headerHandlers('status')).toBeDefined();

    const { header, onHeaderClick } = setup();

    fireEvent.contextMenu(header('Date'));
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(header('Date'));
    expect(onHeaderClick).toHaveBeenCalledExactlyOnceWith('date');
  });

  it('takes no click handler for headers that do not sort, and a plain click does nothing', () => {
    // The investment register's headers do not sort: a plain click must
    // neither throw nor open the sheet, while a right-click still does.
    function Plain() {
      const { headerHandlers, sheet } = useColumnHeaderActions<Col>({ columns: COLUMNS, onHide: vi.fn() });
      return (
        <>
          <table>
            <thead>
              <tr>
                <th {...headerHandlers('status')}>Status</th>
              </tr>
            </thead>
          </table>
          {sheet}
        </>
      );
    }
    render(<Plain />);

    fireEvent.click(screen.getByRole('columnheader', { name: 'Status' }));
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.contextMenu(screen.getByRole('columnheader', { name: 'Status' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});
