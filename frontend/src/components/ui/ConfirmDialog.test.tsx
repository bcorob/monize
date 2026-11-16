import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@/test/render';
import { ConfirmDialog } from './ConfirmDialog';
import { buttonClassName } from './Button';
import { __resetModalStateForTesting } from './Modal';

const originalRAF = globalThis.requestAnimationFrame;
const originalCAF = globalThis.cancelAnimationFrame;

describe('ConfirmDialog', () => {
  const defaultProps = {
    isOpen: true,
    title: 'Delete Item',
    message: 'Are you sure?',
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
  };

  it('renders title and message', () => {
    render(<ConfirmDialog {...defaultProps} />);
    expect(screen.getByText('Delete Item')).toBeInTheDocument();
    expect(screen.getByText('Are you sure?')).toBeInTheDocument();
  });

  it('wraps a long unbroken word instead of widening the dialog', () => {
    const longName = `${'scan-of-the-original-receipt-'.repeat(6)}2026.pdf`;
    render(<ConfirmDialog {...defaultProps} message={`"${longName}" will be permanently deleted.`} />);
    // The text column may shrink inside its flex row (min-w-0) and breaks a
    // word with no spaces (break-words), so a long file name wraps rather than
    // pushing the dialog into a horizontal scroll.
    const column = screen.getByTestId('confirm-dialog-text');
    expect(column).toHaveClass('min-w-0', 'flex-1', 'break-words');
    expect(column).toHaveTextContent(longName);
  });

  it('renders default button labels', () => {
    render(<ConfirmDialog {...defaultProps} />);
    expect(screen.getByText('Confirm')).toBeInTheDocument();
    expect(screen.getByText('Cancel')).toBeInTheDocument();
  });

  it('renders custom button labels', () => {
    render(<ConfirmDialog {...defaultProps} confirmLabel="Delete" cancelLabel="Keep" />);
    expect(screen.getByText('Delete')).toBeInTheDocument();
    expect(screen.getByText('Keep')).toBeInTheDocument();
  });

  it('calls onConfirm when confirm clicked', () => {
    const onConfirm = vi.fn();
    render(<ConfirmDialog {...defaultProps} onConfirm={onConfirm} />);
    fireEvent.click(screen.getByText('Confirm'));
    expect(onConfirm).toHaveBeenCalled();
  });

  it('calls onCancel when cancel clicked', () => {
    const onCancel = vi.fn();
    render(<ConfirmDialog {...defaultProps} onCancel={onCancel} />);
    fireEvent.click(screen.getByText('Cancel'));
    expect(onCancel).toHaveBeenCalled();
  });

  it('confirms with the shared danger Button for a destructive action', () => {
    render(<ConfirmDialog {...defaultProps} />);
    expect(screen.getByRole('button', { name: 'Confirm' }).className).toContain(
      buttonClassName('danger'),
    );
  });

  it('confirms with the shared primary Button otherwise', () => {
    // A warning is not a destructive action; hand-written yellow classes were
    // a second colour for the same meaning.
    for (const variant of ['warning', 'info'] as const) {
      const { unmount } = render(<ConfirmDialog {...defaultProps} variant={variant} />);
      expect(screen.getByRole('button', { name: 'Confirm' }).className).toContain(
        buttonClassName('primary'),
      );
      unmount();
    }
  });

  it('renders nothing when not open', () => {
    const { container } = render(<ConfirmDialog {...defaultProps} isOpen={false} />);
    expect(container.firstChild).toBeNull();
  });

  describe('pushHistory', () => {
    beforeEach(() => {
      globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => {
        cb(0);
        return 0;
      };
      globalThis.cancelAnimationFrame = vi.fn();
      __resetModalStateForTesting();
    });

    afterEach(() => {
      globalThis.requestAnimationFrame = originalRAF;
      globalThis.cancelAnimationFrame = originalCAF;
      document.body.style.overflow = '';
    });

    it('does not push a history entry by default', async () => {
      const before = window.history.state;
      await act(async () => {
        render(<ConfirmDialog {...defaultProps} />);
      });
      expect(window.history.state).toEqual(before);
    });

    it('pushes a history entry when pushHistory is true', async () => {
      await act(async () => {
        render(<ConfirmDialog {...defaultProps} pushHistory />);
      });
      expect(window.history.state).toMatchObject({ modal: true });
    });
  });
});
