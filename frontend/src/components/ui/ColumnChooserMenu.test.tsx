import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { ColumnChooserMenu } from './ColumnChooserMenu';
import { LIST_TOOLBAR_BUTTON_CLASS } from './ListTopToolbar';

type Col = 'refNumber' | 'tags' | 'status';

const COLUMNS = [
  { id: 'refNumber', label: 'Ref #' },
  { id: 'tags', label: 'Tags' },
  { id: 'status', label: 'Status' },
] as const;

function setup(hidden: readonly Col[] = []) {
  const onHide = vi.fn();
  const onShow = vi.fn();
  const onShowAll = vi.fn();
  const utils = render(
    <ColumnChooserMenu<Col>
      columns={COLUMNS}
      hidden={new Set(hidden)}
      onHide={onHide}
      onShow={onShow}
      onShowAll={onShowAll}
    />,
  );
  const trigger = () => screen.getByRole('button', { name: /^Columns/ });
  return { ...utils, onHide, onShow, onShowAll, trigger };
}

describe('ColumnChooserMenu', () => {
  it('is a menu trigger in the toolbar-button style, closed until pressed', () => {
    const { trigger } = setup();

    expect(trigger()).toHaveAttribute('aria-haspopup', 'menu');
    expect(trigger()).toHaveAttribute('aria-expanded', 'false');
    expect(trigger()).toHaveClass(...LIST_TOOLBAR_BUTTON_CLASS.split(' '));
    expect(screen.queryByRole('menu')).toBeNull();

    fireEvent.click(trigger());

    expect(trigger()).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('menu', { name: 'Show or hide columns' })).toBeInTheDocument();
  });

  it('lists one checkbox per column, checked while the column is shown', () => {
    const { trigger } = setup(['tags']);
    fireEvent.click(trigger());

    const rows = screen.getAllByRole('menuitemcheckbox');
    expect(rows.map((row) => row.textContent)).toEqual(['Ref #', 'Tags', 'Status']);
    expect(screen.getByRole('menuitemcheckbox', { name: 'Ref #' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('menuitemcheckbox', { name: 'Tags' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('menuitemcheckbox', { name: 'Status' })).toHaveAttribute('aria-checked', 'true');
  });

  it('hides a shown column and shows a hidden one, staying open', () => {
    const { trigger, onHide, onShow } = setup(['tags']);
    fireEvent.click(trigger());

    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Status' }));
    expect(onHide).toHaveBeenCalledExactlyOnceWith('status');
    expect(screen.getByRole('menu')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Tags' }));
    expect(onShow).toHaveBeenCalledExactlyOnceWith('tags');
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(trigger()).toHaveAttribute('aria-expanded', 'true');
  });

  it('puts "Show all" last, disabled while nothing is hidden', () => {
    const { trigger } = setup();
    fireEvent.click(trigger());

    const items = screen.getByRole('menu').querySelectorAll('[role^="menuitem"]');
    const showAll = screen.getByRole('menuitem', { name: 'Show all' });
    expect(items[items.length - 1]).toBe(showAll);
    expect(showAll).toBeDisabled();
  });

  it('shows everything from "Show all", then closes and refocuses the trigger', () => {
    const { trigger, onShowAll } = setup(['refNumber', 'status']);
    fireEvent.click(trigger());

    const showAll = screen.getByRole('menuitem', { name: 'Show all' });
    expect(showAll).toBeEnabled();
    fireEvent.click(showAll);

    expect(onShowAll).toHaveBeenCalledOnce();
    expect(screen.queryByRole('menu')).toBeNull();
    expect(trigger()).toHaveFocus();
  });

  it('closes on Escape and hands focus back to the trigger', () => {
    const { trigger } = setup();
    fireEvent.click(trigger());

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByRole('menu')).toBeNull();
    expect(trigger()).toHaveAttribute('aria-expanded', 'false');
    expect(trigger()).toHaveFocus();
  });

  it('closes on a click outside, without toggling anything', () => {
    const { trigger, onHide, onShow } = setup();
    fireEvent.click(trigger());

    fireEvent.mouseDown(document.body);

    expect(screen.queryByRole('menu')).toBeNull();
    expect(onHide).not.toHaveBeenCalled();
    expect(onShow).not.toHaveBeenCalled();
  });

  it('stays open on a press inside the menu', () => {
    const { trigger } = setup();
    fireEvent.click(trigger());

    fireEvent.mouseDown(screen.getByRole('menuitemcheckbox', { name: 'Tags' }));

    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  it('carries no count while nothing is hidden', () => {
    const { trigger } = setup();
    expect(screen.queryByTestId('column-chooser-count')).toBeNull();
    expect(trigger()).toHaveAccessibleName('Columns');
  });

  it('counts the hidden columns on the trigger, in its accessible name too', () => {
    const { trigger } = setup(['refNumber', 'status']);
    expect(screen.getByTestId('column-chooser-count')).toHaveTextContent('2');
    expect(screen.getByTestId('column-chooser-count')).toHaveClass('tabular-nums');
    expect(trigger()).toHaveAccessibleName('Columns, 2 hidden');
  });

  it('counts only the columns it lists', () => {
    // A hidden set from a newer client could name a column this menu does not
    // offer; it is not one the reader can bring back here, so it is not counted.
    render(
      <ColumnChooserMenu<string>
        columns={COLUMNS}
        hidden={new Set(['tags', 'somethingElse'])}
        onHide={vi.fn()}
        onShow={vi.fn()}
        onShowAll={vi.fn()}
      />,
    );
    expect(screen.getByTestId('column-chooser-count')).toHaveTextContent('1');
  });

  it('opens from the trigger with ArrowDown into the first row, then moves with the arrows, Home and End', () => {
    const { trigger } = setup();
    trigger().focus();

    fireEvent.keyDown(trigger(), { key: 'ArrowDown' });

    expect(screen.getByRole('menu')).toBeInTheDocument();
    const ref = screen.getByRole('menuitemcheckbox', { name: 'Ref #' });
    const tags = screen.getByRole('menuitemcheckbox', { name: 'Tags' });
    const status = screen.getByRole('menuitemcheckbox', { name: 'Status' });
    expect(ref).toHaveFocus();

    fireEvent.keyDown(ref, { key: 'ArrowDown' });
    expect(tags).toHaveFocus();
    fireEvent.keyDown(tags, { key: 'End' });
    // "Show all" is disabled with nothing hidden, so the last row is Status.
    expect(status).toHaveFocus();
    fireEvent.keyDown(status, { key: 'ArrowDown' });
    expect(ref).toHaveFocus();
    fireEvent.keyDown(ref, { key: 'ArrowUp' });
    expect(status).toHaveFocus();
    fireEvent.keyDown(status, { key: 'Home' });
    expect(ref).toHaveFocus();
  });

  it('opens from the trigger with ArrowUp into the last enabled row', () => {
    const { trigger } = setup(['tags']);
    trigger().focus();

    fireEvent.keyDown(trigger(), { key: 'ArrowUp' });

    expect(screen.getByRole('menuitem', { name: 'Show all' })).toHaveFocus();
  });

  it('moves from the trigger into an already open menu', () => {
    const { trigger } = setup();
    fireEvent.click(trigger());
    trigger().focus();

    fireEvent.keyDown(trigger(), { key: 'ArrowDown' });

    expect(screen.getByRole('menuitemcheckbox', { name: 'Ref #' })).toHaveFocus();
  });
});
