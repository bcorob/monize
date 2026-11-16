import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useRouter } from 'next/navigation';
import { render, screen, fireEvent, within } from '@/test/render';
import { useDensityStore } from '@/store/densityStore';
import { RulesList } from './RulesList';
import { makeRule } from './rules-test-fixtures';

/**
 * The rules list follows the reference lists: a density toggle above the
 * table and, on a phone at Normal density, one card per rule. The headers do
 * not sort, because the order on screen is the order the rules run in.
 */

const PHONE_QUERY = '(max-width: 639px)';
const originalMatchMedia = window.matchMedia;

function setPhoneViewport(isPhone: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: isPhone && query === PHONE_QUERY,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

const handlers = {
  onToggle: vi.fn(),
  onDuplicate: vi.fn(),
  onRun: vi.fn(),
  onMove: vi.fn(),
  onDelete: vi.fn(),
};

function renderList() {
  return render(
    <RulesList
      rules={[
        makeRule({ id: 'a', name: 'Coffee shops' }),
        makeRule({ id: 'b', name: 'Salary', enabled: false, triggers: ['create', 'import'] }),
      ]}
      pendingIds={new Set()}
      reordering={false}
      {...handlers}
    />,
  );
}

function bodyRows(container: HTMLElement): HTMLTableRowElement[] {
  return Array.from(container.querySelectorAll<HTMLTableRowElement>('tbody tr'));
}

describe('the rules list layout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    useDensityStore.setState({ densities: {} });
  });

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
  });

  it('offers the density toggle and pads the rows by the chosen density', () => {
    useDensityStore.setState({ densities: { rules: 'dense' } });
    const { container } = renderList();
    expect(screen.getByTitle('Toggle row density')).toBeInTheDocument();
    const nameCell = bodyRows(container)[0].querySelectorAll('td')[2];
    expect(nameCell).toHaveClass('py-1');
  });

  it('keeps the evaluation order: no header offers a sort', () => {
    const { container } = renderList();
    expect(container.querySelectorAll('th[aria-sort]')).toHaveLength(0);
    expect(within(container.querySelector('thead') as HTMLElement).queryAllByRole('button')).toHaveLength(0);
  });

  it('renders each rule as one card on a phone at Normal density, its switch named beside it', () => {
    setPhoneViewport(true);
    const { container } = renderList();

    const rows = bodyRows(container);
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelectorAll('td')).toHaveLength(1);
    expect(container.querySelector('thead')).toBeNull();

    const text = rows[1].textContent ?? '';
    expect(text).toContain('Salary');
    expect(text).toContain('2');
    expect(text).toContain('When created or imported');
    // The actions are the long-press sheet's on a phone.
    expect(within(rows[1]).queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();

    const toggle = within(rows[1]).getByRole('switch', { name: 'Enable Salary' });
    expect(toggle.parentElement).toHaveTextContent('Enabled');
    fireEvent.click(toggle);
    expect(handlers.onToggle).toHaveBeenCalledWith(expect.objectContaining({ id: 'b' }), true);
    expect(useRouter().push).not.toHaveBeenCalled();
  });

  it('opens the editor from the card and the action sheet from a long press', () => {
    setPhoneViewport(true);
    const { container } = renderList();
    const card = bodyRows(container)[0];

    fireEvent.click(within(card).getByText('Coffee shops'));
    expect(useRouter().push).toHaveBeenCalledWith('/rules/a');

    fireEvent.contextMenu(card);
    const sheet = screen.getByRole('dialog');
    fireEvent.click(within(sheet).getByRole('button', { name: /Delete/ }));
    expect(handlers.onDelete).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }));
  });

  it('keeps the table on a phone at Compact density', () => {
    setPhoneViewport(true);
    useDensityStore.setState({ densities: { rules: 'compact' } });
    const { container } = renderList();
    expect(container.querySelector('thead')).not.toBeNull();
    expect(bodyRows(container)[0].querySelectorAll('td').length).toBeGreaterThan(1);
  });
});
