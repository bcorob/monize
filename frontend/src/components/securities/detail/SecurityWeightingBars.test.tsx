import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '@/test/render';
import { SecurityWeightingBars } from './SecurityWeightingBars';

const EMPTY = 'No breakdown stored';

function renderCard(
  slices: { name: string; weight: number }[] | null | undefined,
  remainderLabel?: (percent: string) => string,
) {
  return render(
    <SecurityWeightingBars
      slices={slices}
      emptyMessage={EMPTY}
      remainderLabel={remainderLabel}
    />,
  );
}

/** The fill element of each row, in DOM order. */
function bars(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll('li > div[role="img"] > div'),
  ) as HTMLElement[];
}

/** Eight slices, more than fit the card's bounded height at once. */
const MANY = Array.from({ length: 8 }, (_, i) => ({
  name: `Slice ${i + 1}`,
  weight: (8 - i) / 40,
}));

describe('SecurityWeightingBars', () => {
  describe('a long breakdown', () => {
    it('renders every share, reachable by scrolling', () => {
      renderCard(MANY);
      // No expander and no cut: the card is beside the price chart, so its
      // height must not depend on how many sectors a fund reports, and the
      // answer to "what is it mostly" should not need a click.
      expect(screen.getAllByRole('listitem')).toHaveLength(8);
      expect(screen.queryByRole('button', { name: /Show/ })).toBeNull();
    });

    it('caps its height and scrolls, rather than growing the card', () => {
      // The cap is what actually bounds it. `flex-1` on its own cannot: the
      // column takes its height from the grid row, the row takes its height from
      // its tallest item, and a list sized that way is sizing itself against
      // itself -- which is how the scrollbar went missing once already.
      const { container } = renderCard(MANY);
      const list = container.querySelector('ul')!;
      expect(list.className).toContain('overflow-y-auto');
      expect(list.className).toMatch(/max-h-/);
      expect(list.className).toContain('flex-1');
    });

    it('uses the slim scrollbar, not the native one', () => {
      // The complaint that started this was the bar's appearance, not its
      // presence: the native control is wide, arrowed, and drawn against the
      // figures, which reads as a rendering fault inside a small card.
      const { container } = renderCard(MANY);
      expect(container.querySelector('ul')!.className).toContain(
        'scrollbar-slim',
      );
      expect(container.querySelector('ul')!.className).not.toContain(
        'scrollbar-hide',
      );
    });

    it('draws each bar against the whole, not against the largest share', () => {
      const { container } = renderCard([
        { name: 'Technology', weight: 0.32 },
        { name: 'Financials', weight: 0.16 },
      ]);
      // A 32% share fills a third of its track. Scaling against the largest
      // slice drew this one full width, which contradicted the 32% printed
      // beside it -- a bar that restates a number has to restate that number.
      expect(bars(container)[0].style.width).toBe('32%');
      expect(bars(container)[1].style.width).toBe('16%');
    });

    it('still draws something for a share that rounds to nothing', () => {
      const { container } = renderCard([
        { name: 'Big', weight: 0.99 },
        { name: 'Trace', weight: 0.0001 },
      ]);
      expect(bars(container)[1].style.width).toBe('0.5%');
    });
  });

  it('lists each share with its percentage', () => {
    renderCard([
      { name: 'Technology', weight: 0.324 },
      { name: 'Financials', weight: 0.181 },
    ]);

    expect(screen.getByText('Technology')).toBeInTheDocument();
    expect(screen.getByText('32.40%')).toBeInTheDocument();
    expect(screen.getByText('Financials')).toBeInTheDocument();
    expect(screen.getByText('18.10%')).toBeInTheDocument();
  });

  it('orders the shares largest first', () => {
    renderCard([
      { name: 'Small', weight: 0.1 },
      { name: 'Biggest', weight: 0.6 },
      { name: 'Middle', weight: 0.3 },
    ]);

    const names = screen
      .getAllByRole('listitem')
      .map((row) => row.textContent?.split(/\d/)[0]);
    expect(names).toEqual(['Biggest', 'Middle', 'Small']);
  });

  it('labels every bar for assistive tech, so colour is never the only signal', () => {
    renderCard([{ name: 'Technology', weight: 0.324 }]);
    expect(
      screen.getByRole('img', { name: 'Technology: 32.40%' }),
    ).toBeInTheDocument();
  });

  describe('missing data', () => {
    it('says so rather than drawing empty bars', () => {
      const { container } = renderCard(null);
      expect(screen.getByText(EMPTY)).toBeInTheDocument();
      // A security with no sector data is not one with zero-length bars.
      expect(bars(container)).toHaveLength(0);
    });

    it('treats an empty list the same as no list', () => {
      renderCard([]);
      expect(screen.getByText(EMPTY)).toBeInTheDocument();
    });

    it('drops unusable rows instead of plotting them', () => {
      const { container } = renderCard([
        { name: 'Real', weight: 0.5 },
        { name: 'Zero', weight: 0 },
        { name: '', weight: 0.2 },
        { name: 'NaN', weight: Number.NaN },
      ]);
      expect(bars(container)).toHaveLength(1);
      expect(screen.getByText('Real')).toBeInTheDocument();
    });

    it('falls back to the empty state when every row is unusable', () => {
      renderCard([{ name: 'Zero', weight: 0 }]);
      expect(screen.getByText(EMPTY)).toBeInTheDocument();
    });
  });

  describe('phone tiles vs desktop bars', () => {
    it('draws each row as a bordered tile on a phone and drops the bar there', () => {
      const { container } = renderCard([
        { name: 'Technology', weight: 0.32 },
        { name: 'Financials', weight: 0.16 },
      ]);
      // One `<li>` per share at every width -- the name and its percentage each
      // appear exactly once, whichever presentation the width chooses.
      const rows = Array.from(container.querySelectorAll('li'));
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        // A bordered card below `sm`, stripped back to a plain list row from
        // `sm` up.
        expect(row.className).toContain('border');
        expect(row.className).toContain('sm:border-0');
        expect(row.className).toContain('rounded-lg');
        expect(row.className).toContain('sm:p-0');
        // The full-width horizontal bar is hidden on the phone tile and returns
        // from `sm` up -- a bar per share is the vertical space this capped card
        // is trying to save.
        const bar = row.querySelector('div[role="img"]')!;
        expect(bar.className).toContain('hidden');
        expect(bar.className).toContain('sm:block');
      }
    });

    it('lays the tiles out in a grid on a phone and a list from sm up', () => {
      const { container } = renderCard([{ name: 'Technology', weight: 0.5 }]);
      const list = container.querySelector('ul')!;
      // Two columns of tiles below `sm`, the single-column bar list from `sm`.
      expect(list.className).toContain('grid-cols-2');
      expect(list.className).toContain('sm:block');
      // The height cap and scroll are unchanged, so the card still cannot grow
      // with the number of sectors a fund reports.
      expect(list.className).toContain('overflow-y-auto');
      expect(list.className).toMatch(/max-h-/);
    });
  });

  describe('unclassified remainder', () => {
    it('names the gap when the shares do not reach 100%', () => {
      renderCard(
        [
          { name: 'Technology', weight: 0.6 },
          { name: 'Financials', weight: 0.25 },
        ],
        (percent) => `${percent} unclassified`,
      );
      // Providers report the classified part only; saying so beats letting the
      // reader assume the rest is missing.
      expect(screen.getByText('15.00% unclassified')).toBeInTheDocument();
    });

    it('stays quiet when the shares add up', () => {
      renderCard(
        [
          { name: 'Technology', weight: 0.6 },
          { name: 'Financials', weight: 0.4 },
        ],
        (percent) => `${percent} unclassified`,
      );
      expect(screen.queryByText(/unclassified/)).toBeNull();
    });

    it('ignores a rounding-sized gap', () => {
      renderCard(
        [{ name: 'Technology', weight: 0.998 }],
        (percent) => `${percent} unclassified`,
      );
      expect(screen.queryByText(/unclassified/)).toBeNull();
    });

    it('says nothing about a remainder when not asked to', () => {
      renderCard([{ name: 'Technology', weight: 0.5 }]);
      expect(screen.queryByText(/unclassified/)).toBeNull();
    });
  });
});
