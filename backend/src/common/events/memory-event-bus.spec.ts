import { MemoryEventBus } from "./memory-event-bus";

describe("MemoryEventBus", () => {
  let bus: MemoryEventBus;

  beforeEach(() => {
    bus = new MemoryEventBus();
  });

  it("names itself, because the bound implementation is a fact worth asserting", () => {
    expect(bus.name).toBe("memory");
  });

  it("delivers to every subscriber of the channel and to no other channel", async () => {
    const relayA = jest.fn();
    const relayB = jest.fn();
    const other = jest.fn();
    bus.subscribe("relay:user-1", relayA);
    bus.subscribe("relay:user-1", relayB);
    bus.subscribe("relay:user-2", other);

    await bus.publish("relay:user-1", { promptId: "p1" });

    expect(relayA).toHaveBeenCalledWith({ promptId: "p1" });
    expect(relayB).toHaveBeenCalledWith({ promptId: "p1" });
    expect(other).not.toHaveBeenCalled();
  });

  it("delivers after the publisher's stack unwinds, never inside it", async () => {
    const order: string[] = [];
    bus.subscribe("c", () => order.push("handler"));

    const published = bus.publish("c", {});
    order.push("publish returned");
    await published;

    // Synchronous delivery would put "handler" first, and a caller that only
    // works under that ordering breaks the day RedisEventBus is bound instead.
    expect(order).toEqual(["publish returned", "handler"]);
  });

  it("stops delivering once the returned function is called", async () => {
    const handler = jest.fn();
    const unsubscribe = bus.subscribe("c", handler);

    unsubscribe();
    await bus.publish("c", {});

    expect(handler).not.toHaveBeenCalled();
    expect(bus.activeChannels()).toEqual([]);
  });

  it("does not let a repeated unsubscribe remove a later subscription", async () => {
    const first = jest.fn();
    const unsubscribe = bus.subscribe("c", first);
    unsubscribe();

    // The same handler resubscribes -- a reconnecting waiter, which is the
    // ordinary case. A second call to the stale unsubscribe must not take it
    // off the channel it has just rejoined.
    bus.subscribe("c", first);
    unsubscribe();
    await bus.publish("c", { second: true });

    expect(first).toHaveBeenCalledWith({ second: true });
  });

  it("keeps one throwing handler from costing the others their wake-up", async () => {
    const warn = jest
      .spyOn(
        (bus as unknown as { logger: { warn: () => void } }).logger,
        "warn",
      )
      .mockImplementation();
    const boom = jest.fn(() => {
      throw new Error("handler exploded");
    });
    const after = jest.fn();
    bus.subscribe("c", boom);
    bus.subscribe("c", after);

    await expect(bus.publish("c", {})).resolves.toBeUndefined();

    expect(after).toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      'Event handler for "c" threw: handler exploded',
    );
  });

  it("delivers to the subscribers present at publish time, whoever unsubscribes mid-delivery", async () => {
    const second = jest.fn();
    // A handler that tears down its neighbour is the SSE case: one request
    // ending closes the waiter it shares a user channel with. Iterating the
    // live Set would then skip a handler that was subscribed when the message
    // was published.
    bus.subscribe("c", () => unsubscribeSecond());
    const unsubscribeSecond = bus.subscribe("c", second);

    await bus.publish("c", { id: 1 });

    expect(second).toHaveBeenCalledWith({ id: 1 });
  });

  it("is a no-op on a channel nobody is listening to", async () => {
    await expect(bus.publish("nobody-here", {})).resolves.toBeUndefined();
  });
});
