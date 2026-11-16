import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from '@testing-library/react';
import { render } from '@/test/render';
import { Modal, __resetModalStateForTesting } from '@/components/ui/Modal';
import { afterModalHistoryPop } from './after-modal-history-pop';

/** Waits for jsdom's queued history traversal and the tasks after it. */
async function settle(ms = 50) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

describe('afterModalHistoryPop', () => {
  beforeEach(() => {
    __resetModalStateForTesting();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await settle();
  });

  // The defect: a navigation out of a closing modal was pushed after a fixed
  // 100 ms, and on a slow render the modal's history.back() landed after it
  // and undid it, leaving the reader on the page they meant to leave.
  it('waits for the closed modal to pop its entry, however late that is', async () => {
    const realBack = window.history.back.bind(window.history);
    const backSpy = vi.spyOn(window.history, 'back');
    const { rerender } = render(<Modal isOpen pushHistory>Content</Modal>);
    expect(window.history.state?.modal).toBe(true);

    const callback = vi.fn();
    afterModalHistoryPop(callback);
    await settle(150);
    // The close has not rendered yet: the modal's entry is still current.
    expect(callback).not.toHaveBeenCalled();

    // Delay the pop the way a slow device does.
    backSpy.mockImplementation(() => {
      setTimeout(realBack, 300);
    });
    rerender(<Modal isOpen={false} pushHistory>Content</Modal>);
    expect(backSpy).toHaveBeenCalledTimes(1);

    await settle(150);
    expect(callback).not.toHaveBeenCalled();

    await settle(300);
    expect(window.history.state?.modal).not.toBe(true);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('runs on the next task when no modal entry is current', async () => {
    const callback = vi.fn();
    afterModalHistoryPop(callback);
    expect(callback).not.toHaveBeenCalled();
    await settle();
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('runs once the ceiling passes when the entry is never popped', async () => {
    window.history.pushState({ modal: true }, '');
    const callback = vi.fn();
    afterModalHistoryPop(callback, 100);
    await settle(50);
    expect(callback).not.toHaveBeenCalled();
    await settle(100);
    expect(callback).toHaveBeenCalledTimes(1);
    // A pop after the ceiling does not run it a second time.
    window.history.back();
    await settle();
    expect(callback).toHaveBeenCalledTimes(1);
  });
});
