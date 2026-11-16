import {
  PG_WAKEUP_CHANNEL,
  PgListener,
  PgNotificationHandler,
} from "../cluster/pg-listener.provider";
import { MAX_WAKEUP_BYTES, PostgresEventBus } from "./postgres-event-bus";

/**
 * A `PgListener` double that delivers what a real one would.
 *
 * Only the three members the bus touches, and `emit` to play the connection's
 * side: what goes over the wire is a string on one fixed channel, so the double
 * has to carry it as a string or the JSON round trip -- where a malformed
 * payload and the size limit live -- would not be exercised at all.
 */
class FakeListener {
  readonly notified: { channel: string; payload: string }[] = [];
  readonly listened: string[] = [];
  notifyError: Error | null = null;
  private handlers: PgNotificationHandler[] = [];

  async listen(channel: string): Promise<void> {
    this.listened.push(channel);
  }

  async notify(channel: string, payload: string): Promise<void> {
    if (this.notifyError) throw this.notifyError;
    this.notified.push({ channel, payload });
  }

  onNotification(handler: PgNotificationHandler): () => void {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter((h) => h !== handler);
    };
  }

  /** Play a notification arriving on the connection. */
  emit(channel: string, payload: string): void {
    for (const handler of [...this.handlers]) handler(channel, payload);
  }

  /** Deliver what this bus itself published, as a second replica would see it. */
  deliverLast(): void {
    const last = this.notified[this.notified.length - 1];
    this.emit(last.channel, last.payload);
  }
}

const asListener = (fake: FakeListener) => fake as unknown as PgListener;

describe("PostgresEventBus", () => {
  let listener: FakeListener;
  let bus: PostgresEventBus;

  beforeEach(async () => {
    listener = new FakeListener();
    bus = new PostgresEventBus(asListener(listener));
    await bus.start();
  });

  it("identifies itself as the postgres implementation", () => {
    // The relay logs this, and a spec asserting behaviour in `multi` needs to
    // be able to tell which bus it got.
    expect(bus.name).toBe("postgres");
  });

  it("listens once, on the one deployment channel", async () => {
    await bus.start();
    bus.subscribe("relay:user-1", () => undefined);
    bus.subscribe("relay:user-2", () => undefined);

    // One LISTEN for the life of the process: a subscribe happens on every SSE
    // open, and UNLISTEN is global to the session, so per-subscriber channels
    // would let one request ending deafen every other request sharing it.
    expect(listener.listened).toEqual([PG_WAKEUP_CHANNEL, PG_WAKEUP_CHANNEL]);
  });

  describe("publish", () => {
    it("sends the logical channel inside the payload, not as the channel", async () => {
      await bus.publish("relay:user-1", { promptId: "p1" });

      expect(listener.notified).toEqual([
        {
          channel: PG_WAKEUP_CHANNEL,
          payload: JSON.stringify({
            channel: "relay:user-1",
            payload: { promptId: "p1" },
          }),
        },
      ]);
    });

    it("refuses a payload that is carrying data rather than a hint", async () => {
      const big = { answer: "x".repeat(MAX_WAKEUP_BYTES) };

      await expect(bus.publish("relay:user-1", big)).rejects.toThrow(
        /never carries the row/,
      );
      expect(listener.notified).toHaveLength(0);
    });

    it("measures the limit in bytes, not characters", async () => {
      // A multi-byte payload that passes a length check and fails the server's
      // byte limit is exactly the case a naive check misses.
      const wide = { note: "é".repeat(MAX_WAKEUP_BYTES - 40) };

      await expect(bus.publish("relay:user-1", wide)).rejects.toThrow(
        /bytes, over the/,
      );
    });

    it("rejects while the connection is down rather than reporting success", async () => {
      listener.notifyError = new Error("the notification connection is down");

      await expect(bus.publish("relay:user-1", {})).rejects.toThrow(
        /connection is down/,
      );
    });
  });

  describe("delivery", () => {
    it("routes to the subscribers of the channel named in the payload", async () => {
      const first: unknown[] = [];
      const second: unknown[] = [];
      bus.subscribe("relay:user-1", (p) => first.push(p));
      bus.subscribe("relay:user-2", (p) => second.push(p));

      await bus.publish("relay:user-1", { promptId: "p1" });
      listener.deliverLast();

      expect(first).toEqual([{ promptId: "p1" }]);
      expect(second).toEqual([]);
    });

    it("delivers to every subscriber of one channel", async () => {
      const seen: string[] = [];
      bus.subscribe("relay:user-1", () => seen.push("a"));
      bus.subscribe("relay:user-1", () => seen.push("b"));

      await bus.publish("relay:user-1", {});
      listener.deliverLast();

      expect(seen).toEqual(["a", "b"]);
    });

    it("drops a wake-up for a channel nobody here is listening on", async () => {
      // The ordinary case in `multi`: every replica hears every wake-up and
      // most are not theirs.
      expect(() =>
        listener.emit(
          PG_WAKEUP_CHANNEL,
          JSON.stringify({ channel: "relay:elsewhere", payload: {} }),
        ),
      ).not.toThrow();
    });

    it("ignores a notification on another channel entirely", async () => {
      const seen: unknown[] = [];
      bus.subscribe("relay:user-1", (p) => seen.push(p));

      // A future second channel family on the same connection must not be
      // parsed as a wake-up envelope.
      listener.emit("some_other_channel", "not json at all");

      expect(seen).toEqual([]);
    });

    it("drops an unparsable payload instead of throwing at the connection", async () => {
      const warn = jest
        .spyOn(
          (bus as unknown as { logger: { warn: (m: string) => void } }).logger,
          "warn",
        )
        .mockImplementation(() => undefined);

      // This runs on the connection's event handler, where a throw has no
      // caller to reach; the cost of dropping it is one waiter's poll interval.
      expect(() =>
        listener.emit(PG_WAKEUP_CHANNEL, "{ not json"),
      ).not.toThrow();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("Unparsable"));

      warn.mockRestore();
    });

    it("drops an envelope with no channel", () => {
      const warn = jest
        .spyOn(
          (bus as unknown as { logger: { warn: (m: string) => void } }).logger,
          "warn",
        )
        .mockImplementation(() => undefined);

      listener.emit(PG_WAKEUP_CHANNEL, JSON.stringify({ payload: { a: 1 } }));

      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("without a channel"),
      );
      warn.mockRestore();
    });

    it("keeps delivering after a handler throws", async () => {
      const warn = jest
        .spyOn(
          (bus as unknown as { logger: { warn: (m: string) => void } }).logger,
          "warn",
        )
        .mockImplementation(() => undefined);
      const seen: string[] = [];
      bus.subscribe("relay:user-1", () => {
        throw new Error("subscriber is broken");
      });
      bus.subscribe("relay:user-1", () => seen.push("second"));

      await bus.publish("relay:user-1", {});
      listener.deliverLast();

      // A wake-up is a hint, so a handler that throws has lost nothing its own
      // poll will not recover; swallowing the other deliveries would.
      expect(seen).toEqual(["second"]);
      warn.mockRestore();
    });

    it("delivers to a handler an earlier handler unsubscribed", async () => {
      const seen: string[] = [];
      let dropSecond = () => undefined as void;
      bus.subscribe("relay:user-1", () => {
        seen.push("first");
        dropSecond();
      });
      dropSecond = bus.subscribe("relay:user-1", () => seen.push("second"));

      await bus.publish("relay:user-1", {});
      listener.deliverLast();

      // One request ending closes a waiter it shares a user channel with, so
      // the snapshot is taken before delivery.
      expect(seen).toEqual(["first", "second"]);
    });
  });

  describe("subscribe", () => {
    it("stops delivering once unsubscribed", async () => {
      const seen: unknown[] = [];
      const off = bus.subscribe("relay:user-1", (p) => seen.push(p));

      off();
      await bus.publish("relay:user-1", {});
      listener.deliverLast();

      expect(seen).toEqual([]);
    });

    it("unsubscribes idempotently", async () => {
      const seen: string[] = [];
      const off = bus.subscribe("relay:user-1", () => seen.push("first"));
      bus.subscribe("relay:user-1", () => seen.push("second"));

      off();
      off();
      await bus.publish("relay:user-1", {});
      listener.deliverLast();

      expect(seen).toEqual(["second"]);
    });

    it("forgets a channel once its last subscriber leaves", () => {
      const off = bus.subscribe("relay:user-1", () => undefined);
      expect(bus.activeChannels()).toEqual(["relay:user-1"]);

      off();

      // Channels are per user; an empty Set left behind is a slow leak in a
      // process serving many of them.
      expect(bus.activeChannels()).toEqual([]);
    });
  });
});

/** The constructor's own requirement, separate from the shared `beforeEach`. */
describe("PostgresEventBus construction", () => {
  it("subscribes to the connection before anything can publish", () => {
    const listener = new FakeListener();
    const bus = new PostgresEventBus(asListener(listener));
    const seen: unknown[] = [];
    bus.subscribe("relay:user-1", (p) => seen.push(p));

    // No start() call: a notification arriving before the first LISTEN was
    // issued still has to reach a subscriber, because main.ts issues that
    // LISTEN itself and the bus must not depend on winning that race.
    listener.emit(
      PG_WAKEUP_CHANNEL,
      JSON.stringify({ channel: "relay:user-1", payload: { promptId: "p" } }),
    );

    expect(seen).toEqual([{ promptId: "p" }]);
  });
});
