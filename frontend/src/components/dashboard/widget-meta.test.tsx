import { describe, it, expect } from 'vitest';
import { render } from '@/test/render';
import { WIDGET_ICONS, WidgetIconPuck, WidgetHeading } from './widget-meta';
import { DASHBOARD_WIDGETS } from './widget-registry';

describe('widget-meta', () => {
  it('gives every registered widget an icon', () => {
    // A widget added to the registry without an entry here would render a
    // bare header beside decorated ones.
    const missing = DASHBOARD_WIDGETS.map((w) => w.id).filter((id) => !WIDGET_ICONS[id]);
    expect(missing).toEqual([]);
  });

  it('renders the puck as decoration', () => {
    const { container } = render(<WidgetIconPuck id="top-movers" />);
    const puck = container.firstElementChild as HTMLElement;
    expect(puck.getAttribute('aria-hidden')).toBe('true');
    expect(puck.querySelector('svg')).toBeTruthy();
  });

  it('renders the heading as a button when clickable and a heading otherwise', () => {
    const { getByRole, rerender, queryByRole } = render(
      <WidgetHeading id="net-worth" onClick={() => {}}>Net Worth</WidgetHeading>,
    );
    expect(getByRole('button', { name: 'Net Worth' })).toBeInTheDocument();
    rerender(<WidgetHeading id="net-worth">Net Worth</WidgetHeading>);
    expect(queryByRole('button')).toBeNull();
    expect(getByRole('heading', { name: 'Net Worth' })).toBeInTheDocument();
  });
});
