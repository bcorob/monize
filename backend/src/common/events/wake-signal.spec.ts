import { WakeSignal } from "./wake-signal";

describe("WakeSignal", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it("returns on its own ceiling when no signal arrives", async () => {
    const signal = new WakeSignal();
    const settled = jest.fn();
    const waited = signal.wait(5000).then(settled);

    await jest.advanceTimersByTimeAsync(4999);
    expect(settled).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1);
    await waited;
    expect(settled).toHaveBeenCalled();
  });

  it("returns early on a signal, without waiting out the ceiling", async () => {
    const signal = new WakeSignal();
    const settled = jest.fn();
    const waited = signal.wait(60_000).then(settled);

    signal.signal();
    await waited;

    expect(settled).toHaveBeenCalled();
    // The ceiling's timer is cleared, not left to fire into a finished request.
    expect(jest.getTimerCount()).toBe(0);
  });

  it("remembers a signal that arrives between two waits", async () => {
    const signal = new WakeSignal();
    const first = signal.wait(10);
    await jest.advanceTimersByTimeAsync(10);
    await first;

    // The wake-up lands while the caller is re-reading its row, with nobody
    // parked. Dropping it here would cost a whole poll interval of latency.
    signal.signal();

    const settled = jest.fn();
    await signal.wait(60_000).then(settled);
    expect(settled).toHaveBeenCalled();
  });

  it("owes a remembered signal to exactly one wait", async () => {
    const signal = new WakeSignal();
    signal.signal();
    await signal.wait(60_000);

    const settled = jest.fn();
    void signal.wait(60_000).then(settled);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
  });
});
