import { describe, it, expect, vi } from 'vitest';
import type { KeyboardEvent } from 'react';
import { INTERACTIVE_ROW_FOCUS_CLASS, activateOnKey } from './interactive-row';

/** A synthetic keyboard event with just the two fields the helper touches. */
function keyEvent(key: string): KeyboardEvent<Element> & { preventDefault: ReturnType<typeof vi.fn> } {
  return { key, preventDefault: vi.fn() } as unknown as KeyboardEvent<Element> & {
    preventDefault: ReturnType<typeof vi.fn>;
  };
}

describe('activateOnKey', () => {
  it.each(['Enter', ' '])('activates on %j and swallows the key', (key) => {
    const handler = vi.fn();
    const event = keyEvent(key);

    activateOnKey(handler)(event);

    expect(handler).toHaveBeenCalledTimes(1);
    // Space would otherwise scroll the page under the row it just activated.
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
  });

  it.each(['Tab', 'ArrowDown', 'a', 'Escape', 'Spacebar'])(
    'ignores %j and leaves its default alone',
    (key) => {
      const handler = vi.fn();
      const event = keyEvent(key);

      activateOnKey(handler)(event);

      expect(handler).not.toHaveBeenCalled();
      expect(event.preventDefault).not.toHaveBeenCalled();
    },
  );

  it('hands the event to the handler', () => {
    const handler = vi.fn();
    const event = keyEvent('Enter');

    activateOnKey(handler)(event);

    expect(handler).toHaveBeenCalledWith(event);
  });

  it('returns a fresh handler per call, so no state leaks between rows', () => {
    const first = vi.fn();
    const second = vi.fn();

    activateOnKey(first)(keyEvent('Enter'));
    activateOnKey(second)(keyEvent(' '));

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe('INTERACTIVE_ROW_FOCUS_CLASS', () => {
  it('is the inset focus ring the converted call sites spelled out', () => {
    // Pinned by value: this string replaced four utilities written out verbatim
    // in three files, and the refactor's claim is that it renders identically.
    expect(INTERACTIVE_ROW_FOCUS_CLASS).toBe(
      'focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-blue-600 dark:focus-visible:outline-blue-400',
    );
  });

  it('paints on Tab only -- every utility is focus-visible', () => {
    // `focus:` paints on a mouse click as well as a Tab (frontend/CLAUDE.md).
    const utilities = INTERACTIVE_ROW_FOCUS_CLASS.split(/\s+/);
    expect(utilities.length).toBeGreaterThan(0);
    for (const utility of utilities) {
      expect(utility).toMatch(/^(dark:)?focus-visible:/);
    }
  });
});
