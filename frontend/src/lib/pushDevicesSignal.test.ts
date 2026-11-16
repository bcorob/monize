import { describe, it, expect, vi } from 'vitest';
import {
  subscribePushDevices,
  notifyPushDevicesChanged,
} from './pushDevicesSignal';

describe('pushDevicesSignal', () => {
  it('tells every subscriber, not only the one that wrote', () => {
    // The whole point: the panel and the matrix each hold their own copy of the
    // device list, and whichever one performed the write is not the only one
    // that has to reload.
    const panel = vi.fn();
    const matrix = vi.fn();
    const stopPanel = subscribePushDevices(panel);
    const stopMatrix = subscribePushDevices(matrix);

    notifyPushDevicesChanged();

    expect(panel).toHaveBeenCalledTimes(1);
    expect(matrix).toHaveBeenCalledTimes(1);
    stopPanel();
    stopMatrix();
  });

  it('stops telling an unsubscribed listener', () => {
    const listener = vi.fn();
    subscribePushDevices(listener)();

    notifyPushDevicesChanged();

    expect(listener).not.toHaveBeenCalled();
  });

  it('notifies nobody when nothing is listening', () => {
    expect(() => notifyPushDevicesChanged()).not.toThrow();
  });
});
