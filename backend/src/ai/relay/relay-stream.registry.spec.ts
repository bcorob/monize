import { RelayStreamRegistry } from "./relay-stream.registry";

const USER = "user-1";
const OTHER = "user-2";

describe("RelayStreamRegistry", () => {
  let registry: RelayStreamRegistry;

  beforeEach(() => {
    registry = new RelayStreamRegistry();
  });

  it("delivers to the stream registered for the turn", () => {
    const emit = jest.fn();
    registry.register("p1", USER, emit);

    expect(registry.emit(USER, "p1", { type: "tool_start", name: "x" })).toBe(
      true,
    );
    expect(emit).toHaveBeenCalledWith({ type: "tool_start", name: "x" });
  });

  it("refuses a turn held for another user", () => {
    const emit = jest.fn();
    registry.register("p1", OTHER, emit);

    // The owner check is what keeps a guessed prompt id from writing into
    // somebody else's open chat.
    expect(registry.emit(USER, "p1", { type: "assistant_text" })).toBe(false);
    expect(emit).not.toHaveBeenCalled();
  });

  it("reports no stream for a turn this process is not holding", () => {
    expect(registry.emit(USER, "absent", { type: "assistant_text" })).toBe(
      false,
    );
  });

  it("stops delivering once released, and keeps no entry behind", () => {
    const emit = jest.fn();
    const release = registry.register("p1", USER, emit);

    release();

    expect(registry.emit(USER, "p1", { type: "done" })).toBe(false);
    expect(registry.activeCount()).toBe(0);
  });

  it("does not let a repeated release drop a later stream for the same turn", () => {
    const first = jest.fn();
    const release = registry.register("p1", USER, first);
    release();

    const second = jest.fn();
    registry.register("p1", USER, second);
    // A waiter releases on both the disconnect and the deadline path; the
    // second call must not take the reconnected stream off the turn.
    release();

    expect(registry.emit(USER, "p1", { type: "done" })).toBe(true);
    expect(second).toHaveBeenCalled();
  });
});
