import { Test } from "@nestjs/testing";

import { MemoryEventBus } from "../common/events/memory-event-bus";
import { EventBus } from "../common/events/event-bus.interface";
import { PortfolioSummaryInvalidationBridge } from "./portfolio-summary-invalidation.bridge";
import {
  PORTFOLIO_SUMMARY_INVALIDATION_CHANNEL,
  invalidateAllPortfolioSummaries,
  invalidatePortfolioSummary,
  portfolioSummaryMemo,
  setPortfolioSummaryBroadcast,
} from "./portfolio-summary-memo";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";

/**
 * Issue #1409: the memo was invalidated only on the replica that served the
 * write, so the next read -- round-robined to another replica -- answered from
 * a valuation taken before the trade. These cases are the two ends of the
 * repair: what this replica announces, and what it does with an announcement.
 *
 * `MemoryEventBus` is the real bus rather than a mock: it defers delivery to a
 * later tick exactly as the PostgreSQL one does, so a bridge that only worked
 * because delivery was synchronous fails here too.
 */
describe("PortfolioSummaryInvalidationBridge", () => {
  let bus: MemoryEventBus;
  let bridge: PortfolioSummaryInvalidationBridge;
  /** What another replica would have received, in order. */
  let received: Array<Record<string, unknown>>;
  let unsubscribeObserver: () => void;

  beforeEach(() => {
    portfolioSummaryMemo.clearAll();
    bus = new MemoryEventBus();
    received = [];
    unsubscribeObserver = bus.subscribe(
      PORTFOLIO_SUMMARY_INVALIDATION_CHANNEL,
      (payload) => received.push(payload),
    );
    bridge = new PortfolioSummaryInvalidationBridge(bus);
    bridge.onModuleInit();
  });

  afterEach(() => {
    bridge.onModuleDestroy();
    unsubscribeObserver();
    setPortfolioSummaryBroadcast(null);
    portfolioSummaryMemo.clearAll();
  });

  /** Delivery is a microtask on both buses; this is where it lands. */
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

  it("announces the user whose valuations a write invalidated", async () => {
    invalidatePortfolioSummary(UUID_A);
    await settle();

    expect(received).toEqual([{ userId: UUID_A }]);
  });

  it("announces a whole-dataset invalidation with no user", async () => {
    invalidateAllPortfolioSummaries();
    await settle();

    expect(received).toEqual([{}]);
  });

  it("drops the named user's entries when another replica announces one", async () => {
    const a = jest.fn(async () => "a");
    const b = jest.fn(async () => "b");
    await portfolioSummaryMemo.run(UUID_A, "ka", a);
    await portfolioSummaryMemo.run(UUID_B, "kb", b);

    await bus.publish(PORTFOLIO_SUMMARY_INVALIDATION_CHANNEL, {
      userId: UUID_A,
    });
    await settle();

    await portfolioSummaryMemo.run(UUID_A, "ka", a);
    await portfolioSummaryMemo.run(UUID_B, "kb", b);
    expect(a).toHaveBeenCalledTimes(2);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("does not answer an announcement with another announcement", async () => {
    // A bus whose messages each produce a message does not converge: every
    // replica would answer the first one, and answer each other's answers.
    await bus.publish(PORTFOLIO_SUMMARY_INVALIDATION_CHANNEL, {
      userId: UUID_A,
    });
    await settle();
    await settle();

    expect(received).toEqual([{ userId: UUID_A }]);
  });

  it("keeps the local drop when the bus refuses the announcement", async () => {
    const refusing: EventBus = {
      name: "memory",
      publish: () => Promise.reject(new Error("connection is down")),
      subscribe: () => () => undefined,
    };
    const isolated = new PortfolioSummaryInvalidationBridge(refusing);
    isolated.onModuleInit();
    const compute = jest.fn(async () => "v");
    await portfolioSummaryMemo.run(UUID_A, "ka", compute);

    expect(() => invalidatePortfolioSummary(UUID_A)).not.toThrow();
    await settle();

    // The write has already committed; the other replicas keep their entry
    // until it expires, and this one recomputes.
    await portfolioSummaryMemo.run(UUID_A, "ka", compute);
    expect(compute).toHaveBeenCalledTimes(2);
    isolated.onModuleDestroy();
  });

  it("compiles, and stays local, in a graph with no bus bound", async () => {
    // The integration harness builds a testing module from the feature modules
    // alone, and `EventBusModule` is `@Global()` rather than imported by each
    // of them -- so a bridge that REQUIRED the bus failed every integration
    // suite that touches securities at module compile. A graph with no bus has
    // no other replica to tell.
    bridge.onModuleDestroy();

    const isolated = await Test.createTestingModule({
      providers: [PortfolioSummaryInvalidationBridge],
    }).compile();
    await isolated.init();

    const compute = jest.fn(async () => "v");
    await portfolioSummaryMemo.run(UUID_A, "ka", compute);
    invalidatePortfolioSummary(UUID_A);
    await settle();

    // Local drop, no announcement, no throw.
    expect(received).toEqual([]);
    await portfolioSummaryMemo.run(UUID_A, "ka", compute);
    expect(compute).toHaveBeenCalledTimes(2);
    await isolated.close();
  });

  it("stops announcing and listening at shutdown", async () => {
    bridge.onModuleDestroy();

    invalidatePortfolioSummary(UUID_A);
    await settle();
    expect(received).toEqual([]);

    const compute = jest.fn(async () => "v");
    await portfolioSummaryMemo.run(UUID_B, "kb", compute);
    await bus.publish(PORTFOLIO_SUMMARY_INVALIDATION_CHANNEL, {
      userId: UUID_B,
    });
    await settle();
    await portfolioSummaryMemo.run(UUID_B, "kb", compute);
    expect(compute).toHaveBeenCalledTimes(1);
  });
});
