import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@/test/render';
import { DensityToggle, DensityToggleBar } from './DensityToggle';
import { useDensityStore } from '@/store/densityStore';
import commonNs from '@/i18n/messages/en/common.json';

function renderToggle(ui: React.ReactElement) {
  return render(ui);
}

describe('DensityToggle', () => {
  beforeEach(() => {
    useDensityStore.setState({ densities: { transactions: 'normal' } });
  });

  it('labels itself with the level the user is on', () => {
    renderToggle(<DensityToggle view="transactions" />);
    expect(screen.getByRole('button')).toHaveTextContent('Normal');

    act(() => useDensityStore.setState({ densities: { transactions: 'dense' } }));
    expect(screen.getByRole('button')).toHaveTextContent('Dense');
  });

  it('cycles the shared preference on click', () => {
    renderToggle(<DensityToggle view="transactions" />);
    const button = screen.getByTitle('Toggle row density');

    fireEvent.click(button);
    expect(useDensityStore.getState().densities.transactions).toBe('compact');
    fireEvent.click(button);
    expect(useDensityStore.getState().densities.transactions).toBe('dense');
    fireEvent.click(button);
    expect(useDensityStore.getState().densities.transactions).toBe('normal');
  });

  it('reads its copy from common, not from a caller namespace', () => {
    // The point of the shared component: one catalog entry, so the same words
    // appear on every surface. Fourteen of nineteen locales previously had at
    // least one density string that disagreed with itself across surfaces.
    renderToggle(<DensityToggle view="transactions" />);
    expect(screen.getByTitle(commonNs.density.title)).toBeInTheDocument();
    expect(screen.getByRole('button')).toHaveTextContent(commonNs.density.normal);
  });

  describe('sizing', () => {
    it('defaults to the small button a table header carries', () => {
      renderToggle(<DensityToggle view="transactions" />);
      const cls = screen.getByRole('button').className;
      expect(cls).toContain('px-2 py-1');
      expect(cls).toContain('text-xs');
    });

    it('matches its text-sm neighbours at md', () => {
      renderToggle(<DensityToggle view="transactions" size="md" />);
      const cls = screen.getByRole('button').className;
      expect(cls).toContain('py-1.5');
      expect(cls).toContain('text-sm');
    });

    it('draws a filled pill at chip, for a row of chips', () => {
      renderToggle(<DensityToggle view="transactions" size="chip" />);
      const cls = screen.getByRole('button').className;
      expect(cls).toContain('bg-gray-100');
      expect(cls).toContain('dark:bg-gray-700');
    });

    it('takes positioning from the caller without losing its own classes', () => {
      renderToggle(<DensityToggle view="transactions" className="ml-auto" />);
      const cls = screen.getByRole('button').className;
      expect(cls).toContain('ml-auto');
      expect(cls).toContain('inline-flex');
    });
  });

  describe('the mobile label', () => {
    it('keeps the label by default, because it names the current level', () => {
      renderToggle(<DensityToggle view="transactions" />);
      expect(screen.getByRole('button').querySelector('.hidden')).toBeNull();
    });

    it('hides it below sm only when asked', () => {
      renderToggle(<DensityToggle view="transactions" hideLabelOnMobile />);
      const label = screen.getByText('Normal');
      expect(label.className).toContain('hidden');
      expect(label.className).toContain('sm:inline');
    });
  });

  describe('DensityToggleBar', () => {
    it('right-aligns the toggle on a ruled-off header strip', () => {
      const { container } = renderToggle(<DensityToggleBar view="transactions" />);
      const bar = container.querySelector('div');

      expect(bar?.className).toContain('justify-end');
      expect(bar?.className).toContain('border-b');
      expect(bar?.querySelector('button')).toBeInTheDocument();
    });
  });
});
