import { describe, it, expect, vi } from 'vitest';
import {
  notifyReconciliationChanged,
  subscribeReconciliation,
} from './reconciliationSignal';

describe('reconciliationSignal', () => {
  it('calls every subscriber', () => {
    const a = vi.fn();
    const b = vi.fn();
    const offA = subscribeReconciliation(a);
    const offB = subscribeReconciliation(b);

    notifyReconciliationChanged();

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    offA();
    offB();
  });

  it('stops calling one that unsubscribed', () => {
    const fn = vi.fn();
    const off = subscribeReconciliation(fn);
    off();

    notifyReconciliationChanged();

    expect(fn).not.toHaveBeenCalled();
  });

  it('is a no-op with nobody listening', () => {
    expect(() => notifyReconciliationChanged()).not.toThrow();
  });
});
