import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@/test/render';
import { SEARCH_SYNTAX_EXAMPLES, SearchSyntaxHelp } from './SearchSyntaxHelp';

describe('SearchSyntaxHelp', () => {
  it('opens on a click and lists every example as a button', () => {
    render(<SearchSyntaxHelp onExample={vi.fn()} />);
    const trigger = screen.getByRole('button', { name: 'Search syntax' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    fireEvent.click(trigger);

    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('dialog', { name: 'Search syntax' })).toBeInTheDocument();
    for (const { example } of SEARCH_SYNTAX_EXAMPLES) {
      expect(screen.getByRole('button', { name: example })).toBeInTheDocument();
    }
    expect(screen.getByText('Cheque or reference number 10 exactly')).toBeInTheDocument();
  });

  it('moves focus into the panel, so the keyboard can reach the examples', () => {
    render(<SearchSyntaxHelp onExample={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Search syntax' }));
    expect(screen.getByRole('button', { name: SEARCH_SYNTAX_EXAMPLES[0].example })).toHaveFocus();
  });

  it('writes the chosen example and closes', () => {
    const onExample = vi.fn();
    render(<SearchSyntaxHelp onExample={onExample} />);
    fireEvent.click(screen.getByRole('button', { name: 'Search syntax' }));

    fireEvent.click(screen.getByRole('button', { name: '#10' }));

    expect(onExample).toHaveBeenCalledWith('#10');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('closes on Escape and returns focus to the trigger', () => {
    render(<SearchSyntaxHelp onExample={vi.fn()} />);
    const trigger = screen.getByRole('button', { name: 'Search syntax' });
    fireEvent.click(trigger);

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('lets Escape through while closed, so a surrounding dialog still closes', () => {
    const outer = vi.fn();
    render(
      <div onKeyDown={outer}>
        <SearchSyntaxHelp onExample={vi.fn()} />
      </div>,
    );
    fireEvent.keyDown(screen.getByRole('button', { name: 'Search syntax' }), { key: 'Escape' });
    expect(outer).toHaveBeenCalled();
  });

  it('closes on a press outside, but not on a press inside', () => {
    render(
      <>
        <SearchSyntaxHelp onExample={vi.fn()} />
        <p>elsewhere</p>
      </>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Search syntax' }));

    fireEvent.mouseDown(screen.getByText('Search syntax', { selector: 'div' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    fireEvent.mouseDown(screen.getByText('elsewhere'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('hands its panel to a parent that needs it for its own outside-press check', () => {
    const popoverRef = { current: null as HTMLDivElement | null };
    render(<SearchSyntaxHelp onExample={vi.fn()} popoverRef={popoverRef} />);
    fireEvent.click(screen.getByRole('button', { name: 'Search syntax' }));
    expect(popoverRef.current).toBe(screen.getByRole('dialog'));
  });
});
