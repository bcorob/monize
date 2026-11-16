import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@/test/render';
import toast from 'react-hot-toast';
import { DefaultViewsGroup } from './DefaultViewsGroup';
import { useDensityStore } from '@/store/densityStore';
import { useDateDisplayStore } from '@/store/dateDisplayStore';
import { useHiddenColumnsStore } from '@/store/hiddenColumnsStore';
import { TRANSACTIONS_PANEL_STORAGE_KEYS } from '@/hooks/useTransactionsPanelCollapsed';
import type { UpdatePreferencesData } from '@/types/auth';

describe('DefaultViewsGroup', () => {
  const commit = vi.fn<(patch: UpdatePreferencesData, revert: () => void) => void>();

  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
  });

  it('shows the built-in defaults when the account sets none', () => {
    render(<DefaultViewsGroup initial={undefined} commit={commit} />);

    expect(screen.getByText('Default Views')).toBeInTheDocument();
    expect(screen.getByLabelText('Row density')).toHaveValue('normal');
    expect(screen.getByRole('switch', { name: 'Hide the year in register dates' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
    expect(
      screen.getByRole('switch', { name: 'Start with the chart on the Transactions page collapsed' }),
    ).toHaveAttribute('aria-checked', 'false');
    expect(
      screen.getByRole('switch', { name: 'Start with the account, payee and category info collapsed' }),
    ).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByLabelText('Default Account View')).toHaveValue('register');
  });

  it("shows the account's stored defaults, ignoring anything malformed", () => {
    render(
      <DefaultViewsGroup
        initial={{ density: 'dense', chartCollapsed: true, accountOpenTarget: 'nowhere' }}
        commit={commit}
      />,
    );

    expect(screen.getByLabelText('Row density')).toHaveValue('dense');
    expect(
      screen.getByRole('switch', { name: 'Start with the chart on the Transactions page collapsed' }),
    ).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByLabelText('Default Account View')).toHaveValue('register');
  });

  it('sends only the key that changed, for the server to merge', () => {
    // Sending the whole map from this screen's copy would erase a default
    // another device saved after the screen opened.
    render(<DefaultViewsGroup initial={{ chartCollapsed: true }} commit={commit} />);

    fireEvent.change(screen.getByLabelText('Row density'), { target: { value: 'compact' } });

    expect(commit).toHaveBeenCalledWith(
      { viewDefaults: { density: 'compact' } },
      expect.any(Function),
    );
  });

  it('saves a flag and where an account opens', () => {
    render(<DefaultViewsGroup initial={{}} commit={commit} />);

    fireEvent.click(screen.getByRole('switch', { name: 'Hide the year in register dates' }));
    expect(commit).toHaveBeenLastCalledWith(
      { viewDefaults: { hideRegisterYear: true } },
      expect.any(Function),
    );

    fireEvent.change(screen.getByLabelText('Default Account View'), {
      target: { value: 'dashboard' },
    });
    expect(commit).toHaveBeenLastCalledWith(
      { viewDefaults: { accountOpenTarget: 'dashboard' } },
      expect.any(Function),
    );
  });

  it('saves nothing when the value already shown is picked again', () => {
    render(<DefaultViewsGroup initial={{}} commit={commit} />);

    fireEvent.change(screen.getByLabelText('Row density'), { target: { value: 'normal' } });

    expect(commit).not.toHaveBeenCalled();
  });

  it('puts the previous value back when the save fails', () => {
    render(<DefaultViewsGroup initial={{ density: 'compact' }} commit={commit} />);

    fireEvent.change(screen.getByLabelText('Row density'), { target: { value: 'dense' } });
    expect(screen.getByLabelText('Row density')).toHaveValue('dense');

    const revert = commit.mock.calls[0][1];
    act(() => revert());

    expect(screen.getByLabelText('Row density')).toHaveValue('compact');
  });

  it('does not let an earlier failed save undo a later change still in flight', () => {
    const chartSwitch = () =>
      screen.getByRole('switch', { name: 'Start with the chart on the Transactions page collapsed' });
    render(<DefaultViewsGroup initial={{}} commit={commit} />);

    fireEvent.click(chartSwitch());
    fireEvent.change(screen.getByLabelText('Row density'), { target: { value: 'dense' } });

    // The chart save fails after the density change went out.
    act(() => commit.mock.calls[0][1]());

    expect(chartSwitch()).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByLabelText('Row density')).toHaveValue('dense');
  });

  it('leaves a key alone when its own failed save has since been superseded', () => {
    render(<DefaultViewsGroup initial={{}} commit={commit} />);

    fireEvent.change(screen.getByLabelText('Row density'), { target: { value: 'compact' } });
    fireEvent.change(screen.getByLabelText('Row density'), { target: { value: 'dense' } });

    act(() => commit.mock.calls[0][1]());

    expect(screen.getByLabelText('Row density')).toHaveValue('dense');
  });

  it("clears this browser's saved choices so the defaults apply here", () => {
    useDensityStore.setState({ densities: { transactions: 'dense' } });
    useDateDisplayStore.setState({ compactMobileDates: true });
    window.localStorage.setItem(TRANSACTIONS_PANEL_STORAGE_KEYS.chart, 'false');
    useHiddenColumnsStore.setState({ columns: { transactions: ['tags'] } });
    const success = vi.spyOn(toast, 'success');
    render(<DefaultViewsGroup initial={{}} commit={commit} />);

    fireEvent.click(screen.getByRole('button', { name: 'Use these defaults in this browser' }));

    expect(useDensityStore.getState().densities).toEqual({});
    expect(useDateDisplayStore.getState().compactMobileDates).toBeNull();
    expect(window.localStorage.getItem(TRANSACTIONS_PANEL_STORAGE_KEYS.chart)).toBeNull();
    expect(useHiddenColumnsStore.getState().columns).toEqual({});
    expect(success).toHaveBeenCalledWith('This browser now uses your default views');
    // Clearing the browser writes nothing to the account.
    expect(commit).not.toHaveBeenCalled();
  });
});
