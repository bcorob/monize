import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/render';
import { AccountBalancesControls } from './AccountBalancesControls';
import { DEFAULT_FILTERS } from './grouping';

// The two shared fields carry machinery this component does not own (locale
// date parsing, a portalled option list); stubbing them keeps the test about
// the layout the controls are responsible for.
vi.mock('@/components/ui/DateInput', () => ({
  DateInput: ({ label }: any) => (
    <div className="w-full">
      <label>{label}</label>
      <input aria-label={label} />
    </div>
  ),
}));

vi.mock('@/components/ui/MultiSelect', () => ({
  MultiSelect: ({ label }: any) => <div data-testid={`multiselect-${label}`}>{label}</div>,
}));

vi.mock('@/components/ui/ExportDropdown', () => ({
  ExportDropdown: ({ className }: any) => (
    <button data-testid="export-dropdown" className={className}>
      Export
    </button>
  ),
}));

function renderControls() {
  return render(
    <AccountBalancesControls
      asOfDate="2026-08-18"
      onAsOfDateChange={vi.fn()}
      filters={DEFAULT_FILTERS}
      onFiltersChange={vi.fn()}
      institutionOptions={[{ value: 'inst-1', label: 'Big Bank' }]}
      accountTypeOptions={[{ value: 'CHEQUING', label: 'Chequing' }]}
      groupBy="type"
      onGroupByChange={vi.fn()}
      sortBy="balance"
      onSortByChange={vi.fn()}
      sortDirection="desc"
      onSortDirectionToggle={vi.fn()}
      viewMode="table"
      onViewModeChange={vi.fn()}
      onExportPdf={vi.fn()}
      onExportCsv={vi.fn()}
    />,
  );
}

/** The sort-direction toggle, found by the label it carries in either state. */
function directionToggle(): HTMLElement {
  return screen.getByTitle(/Sorted (highest|lowest) first/);
}

/** The table/chart view toggle's "Table" button, from `ChartViewToggle`. */
function tableViewButton(): HTMLElement {
  return screen.getByTitle('Table');
}

describe('AccountBalancesControls layout', () => {
  /**
   * A control standing beside a labelled field is the height of the *field*,
   * not of the field plus its label.
   *
   * The toggle first carried `self-stretch` in a row that also contained the
   * label, so it stretched over both and stood a label taller than the select
   * next to it -- which is what a human had to point out. The fix has two
   * halves and either alone leaves it wrong, so both are asserted: the row
   * stretches its columns, and the toggle's column reserves the same label
   * space above the button as `Select` renders above its input. What is left
   * to stretch into is then exactly the input's height, with no magic number
   * that a font or padding change would silently invalidate.
   */
  it('gives the sort-direction toggle the height of the field beside it', () => {
    renderControls();
    const toggle = directionToggle();

    const column = toggle.parentElement!;
    const row = column.parentElement!;
    expect(row.className).toContain('items-stretch');
    expect(toggle.className).toContain('flex-1');

    // The spacer stands in for `Select`'s label, so the button's stretch
    // region starts where the select's does.
    const spacer = column.firstElementChild!;
    expect(spacer).not.toBe(toggle);
    expect(spacer.getAttribute('aria-hidden')).toBe('true');
    expect(spacer.className).toContain('mb-1');
    expect(spacer.className).toContain('text-sm');

    // Stretching from the top of the label is the defect, not the fix.
    expect(toggle.className).not.toContain('self-stretch');
  });

  it('leaves the reserved label space out of the accessible name', () => {
    renderControls();
    // The spacer is a non-breaking space; announcing it would put a stray
    // blank between the two real controls.
    expect(
      screen.queryByText(' ', { ignore: '[aria-hidden="true"]' }),
    ).toBeNull();
  });

  /**
   * A `<select>` clips its text rather than ellipsing it, so a fixed width is
   * a promise about the longest option in every language -- one the
   * translations break, and the reason a word was being chopped off. The
   * controls take the full row and share it evenly instead.
   */
  it('sizes every control from the row rather than from a fixed width', () => {
    const { container } = renderControls();

    // The controls are the grids' own children. Read `class` as an attribute
    // rather than `className`, which is an SVGAnimatedString on the icons and
    // would quietly stringify to something that never matches.
    const controls = [...container.querySelectorAll('div.grid > *')];
    expect(controls.length).toBeGreaterThanOrEqual(8);

    const FIXED_WIDTH = /(?:^|\s)(?:sm:|md:|lg:|xl:|2xl:)?w-(?:\d|\[)/;
    const fixedWidth = controls
      .map((element) => element.getAttribute('class') ?? '')
      .filter((className) => FIXED_WIDTH.test(className));
    expect(
      fixedWidth,
      'A control sized in rem cannot fit copy it has not seen; let the grid size it.',
    ).toEqual([]);

    // The two bands that hold the actual controls (the date/group/sort row and
    // the filters row) are grids that start at one column and widen with the
    // viewport, so a narrow screen stacks rather than squeezing.
    const grids = [...container.querySelectorAll<HTMLElement>('.grid')];
    expect(grids.length).toBeGreaterThanOrEqual(2);
    const fieldGrids = grids.filter((grid) => grid.className.includes('sm:grid-cols-2'));
    expect(fieldGrids.length).toBeGreaterThanOrEqual(2);
    for (const grid of fieldGrids) {
      expect(grid.className).toContain('grid-cols-1');
      expect(grid.className).toMatch(/sm:grid-cols-2/);
    }
  });

  /**
   * The outermost grid is structural -- it places the fields band and the
   * actions column side by side rather than sizing repeated same-shape
   * controls -- so it earns its own assertion instead of being swept into the
   * field-sizing one above. It still starts single-column (stacked, actions
   * below the fields on a narrow screen) and widens at a breakpoint, which is
   * what makes `align-items: stretch` -- grid's default -- give the actions
   * column the fields band's own row height with no number written down
   * anywhere for it.
   */
  it('splits into fields and actions only once there is room for both', () => {
    const { container } = renderControls();
    const outer = container.querySelector<HTMLElement>('.grid')!;
    expect(outer.className).toContain('grid-cols-1');
    expect(outer.className).toContain('items-stretch');
    expect(outer.className).toMatch(/lg:grid-cols-\[.*\]/);
    // Not the field-sizing breakpoint -- this grid has exactly two cells and
    // widens once, not once per extra control.
    expect(outer.className).not.toMatch(/sm:grid-cols-2/);
  });

  /**
   * The view toggle and the export button sit on the same row as the labelled
   * fields (the date, group-by, sort-by), and used to be a hand-rolled pair of
   * icon buttons centred against that row -- shorter than every field beside
   * them, because nothing reserved the label space above them the way `Select`
   * does above its own input. `ChartViewToggle`/`ExportDropdown` now sit in a
   * column shaped exactly like the sort-direction toggle's: same spacer, same
   * `items-stretch` row, so what is left to stretch into is the field height.
   */
  it('gives the view toggle and export button the height of the fields beside them', () => {
    renderControls();
    const tableButton = tableViewButton();
    const exportButton = screen.getByTestId('export-dropdown');

    // Both controls share one stretched row, inside a column that reserves a
    // label spacer above them -- the same shape the sort-direction toggle uses.
    // `ChartViewToggle` wraps its own buttons in a `flex gap-2` div, so the
    // shared row is one level up from the button itself.
    const row = tableButton.parentElement!.parentElement!;
    expect(row).toBe(exportButton.parentElement);
    expect(row.className).toContain('items-stretch');

    const column = row.parentElement!;
    const spacer = column.firstElementChild!;
    expect(spacer).not.toBe(row);
    expect(spacer.getAttribute('aria-hidden')).toBe('true');
    expect(spacer.className).toContain('mb-1');
    expect(spacer.className).toContain('text-sm');

    // The export button is told to fill that stretched height; a plain toggle
    // button already does via ChartViewToggle's own `p-2` sizing plus the
    // stretched flex row.
    expect(exportButton.className).toContain('h-full');
  });

  it('renders every filter the report offers', () => {
    renderControls();
    expect(screen.getByLabelText('Show')).toBeInTheDocument();
    expect(screen.getByLabelText('Status')).toBeInTheDocument();
    expect(screen.getByLabelText('Favourites')).toBeInTheDocument();
    expect(screen.getByLabelText('Group by')).toBeInTheDocument();
    expect(screen.getByLabelText('Sort by')).toBeInTheDocument();
    expect(screen.getByTestId('multiselect-Institutions')).toBeInTheDocument();
    expect(screen.getByTestId('multiselect-Account types')).toBeInTheDocument();
  });
});
