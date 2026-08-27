import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ServiceUnavailableException } from "@nestjs/common";
import {
  resolveRestoreExpandedLimitBytes,
  restorePeakBytes,
  restoreProcessBaselineBytes,
} from "./backup-limits";
import {
  RestoreProcessingGate,
  RestoreQueueBusyException,
  RestoreWaitAbandonedException,
  computeRestoreProcessingSlots,
} from "./restore-processing-gate";
import {
  RESTORE_RETRY_AFTER_SECONDS,
  type RestoreQueueConfig,
} from "./restore-queue-config";

const MIB = 1024 * 1024;

/**
 * A queue small enough to fill in a test, with a deadline long enough that no
 * test depends on it firing. The two tests that are *about* those bounds set
 * their own.
 */
const SMALL_QUEUE: RestoreQueueConfig = {
  queueLimit: 4,
  waitTimeoutMs: 60_000,
};

/** A promise plus the function that settles it, so a test controls timing. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** Let all currently-queued microtasks run. */
const flush = () => new Promise<void>((r) => setImmediate(r));

describe("RestoreProcessingGate", () => {
  it("runs a single task immediately", async () => {
    const gate = new RestoreProcessingGate(1);
    const result = await gate.run(async () => 42);
    expect(result).toBe(42);
    expect(gate.activeCount).toBe(0);
  });

  /**
   * The point of the gate (F3R6-004): a second restore does not begin processing
   * while the first still holds its slot, so their expanded payloads never live at
   * the same time.
   */
  it("holds the second task until the first releases at capacity 1", async () => {
    const gate = new RestoreProcessingGate(1);
    const first = deferred();
    const started: string[] = [];

    const p1 = gate.run(async () => {
      started.push("a");
      await first.promise;
    });
    const p2 = gate.run(async () => {
      started.push("b");
    });

    await flush();
    // Only the first ran; the second is waiting for the slot.
    expect(started).toEqual(["a"]);
    expect(gate.waitingCount).toBe(1);

    first.resolve();
    await Promise.all([p1, p2]);
    expect(started).toEqual(["a", "b"]);
    expect(gate.activeCount).toBe(0);
  });

  it("allows exactly `capacity` tasks to run at once", async () => {
    const gate = new RestoreProcessingGate(2);
    const gates = [deferred(), deferred(), deferred()];
    const started: number[] = [];
    const runs = gates.map((g, i) =>
      gate.run(async () => {
        started.push(i);
        await g.promise;
      }),
    );

    await flush();
    // Two admitted, the third queued.
    expect(started).toEqual([0, 1]);
    expect(gate.waitingCount).toBe(1);

    gates[0].resolve();
    await flush();
    expect(started).toEqual([0, 1, 2]);

    gates[1].resolve();
    gates[2].resolve();
    await Promise.all(runs);
    expect(gate.activeCount).toBe(0);
  });

  it("releases the slot even when the task throws", async () => {
    const gate = new RestoreProcessingGate(1);
    await expect(
      gate.run(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    // A leaked slot would deadlock every later restore.
    expect(gate.activeCount).toBe(0);
    await expect(gate.run(async () => "ok")).resolves.toBe("ok");
  });

  it("wakes a waiter when capacity is raised at runtime", async () => {
    const gate = new RestoreProcessingGate(1);
    const first = deferred();
    const started: string[] = [];
    const p1 = gate.run(async () => {
      started.push("a");
      await first.promise;
    });
    const p2 = gate.run(async () => {
      started.push("b");
    });
    await flush();
    expect(started).toEqual(["a"]);

    gate.configure(2);
    await flush();
    // The raised capacity admits the waiter without the first finishing.
    expect(started).toEqual(["a", "b"]);

    first.resolve();
    await Promise.all([p1, p2]);
  });

  it("defaults an unconfigured gate to one slot, so a spec inherits a working gate", () => {
    // The CONSTRUCTOR floor stays: an unconfigured gate (every spec that builds
    // the service without bootstrap) must run work. It is `configure` -- the
    // path bootstrap uses with a computed capacity -- that must respect zero.
    const gate = new RestoreProcessingGate(0);
    expect(gate.activeCount).toBe(0);
    return expect(gate.run(async () => "ran")).resolves.toBe("ran");
  });

  it("treats a negative configured capacity as zero, not as one", async () => {
    // This test used to assert the opposite ("never drops below one slot") and
    // was what pinned F3RB-005 in place: it made the floor look deliberate.
    const gate = new RestoreProcessingGate(4);
    gate.configure(-5);
    await expect(gate.run(async () => "ran")).rejects.toThrow(
      ServiceUnavailableException,
    );
  });

  it("rejects waiters that were queued before capacity becomes zero", async () => {
    const gate = new RestoreProcessingGate(1);
    const first = deferred();
    const p1 = gate.run(async () => first.promise);
    const p2 = gate.run(async () => "must not run");
    const rejected = expect(p2).rejects.toThrow(ServiceUnavailableException);

    await flush();
    expect(gate.waitingCount).toBe(1);

    gate.configure(0);
    await rejected;
    expect(gate.waitingCount).toBe(0);

    first.resolve();
    await p1;
  });

  /**
   * DR-F3RB-002, the defect itself. The queue was an array of resolve callbacks
   * with no removal path, so a client could hang up while queued and its
   * **destructive** restore still ran when a slot freed -- replacing data of a
   * caller who was no longer there to see the result.
   */
  it("drops a queued waiter whose client disconnected, and never runs it", async () => {
    const gate = new RestoreProcessingGate(1, SMALL_QUEUE);
    const first = deferred();
    const abandoned = new AbortController();
    let secondRan = false;

    const p1 = gate.run(async () => {
      await first.promise;
    });
    const p2 = gate.run(
      async () => {
        secondRan = true;
      },
      { signal: abandoned.signal },
    );
    const rejected = expect(p2).rejects.toBeInstanceOf(
      RestoreWaitAbandonedException,
    );

    await flush();
    expect(gate.waitingCount).toBe(1);

    abandoned.abort();
    await rejected;
    // Left in the queue it would have swallowed the slot `drain` counts out.
    expect(gate.waitingCount).toBe(0);

    first.resolve();
    await p1;
    expect(secondRan).toBe(false);
    expect(gate.activeCount).toBe(0);
    // And the slot it never took is still there for the next caller.
    await expect(gate.run(async () => "ok")).resolves.toBe("ok");
  });

  /**
   * The other half of the asymmetry, and the more expensive one to get wrong: a
   * restore holding a slot is part-way through deleting and re-inserting the
   * user's data, so a socket event must not cancel it.
   */
  it("ignores an abort once the slot is granted", async () => {
    const gate = new RestoreProcessingGate(1, SMALL_QUEUE);
    const first = deferred();
    const second = deferred();
    const abandoned = new AbortController();
    let secondFinished = false;

    const p1 = gate.run(async () => {
      await first.promise;
    });
    const p2 = gate.run(
      async () => {
        await second.promise;
        secondFinished = true;
        return "completed";
      },
      { signal: abandoned.signal },
    );

    await flush();
    first.resolve();
    await flush();
    // The waiter has the slot now.
    expect(gate.activeCount).toBe(1);

    abandoned.abort();
    await flush();
    expect(secondFinished).toBe(false);

    second.resolve();
    await expect(p2).resolves.toBe("completed");
    await p1;
    expect(secondFinished).toBe(true);
    expect(gate.activeCount).toBe(0);
  });

  it("never queues a caller that is already gone", async () => {
    const gate = new RestoreProcessingGate(1, SMALL_QUEUE);
    const first = deferred();
    const p1 = gate.run(async () => first.promise);
    await flush();

    const abandoned = new AbortController();
    abandoned.abort();
    let ran = false;
    await expect(
      gate.run(
        async () => {
          ran = true;
        },
        { signal: abandoned.signal },
      ),
    ).rejects.toBeInstanceOf(RestoreWaitAbandonedException);
    expect(ran).toBe(false);
    expect(gate.waitingCount).toBe(0);

    first.resolve();
    await p1;
  });

  it("refuses with a retryable 503 once the queue is full", async () => {
    const gate = new RestoreProcessingGate(1, {
      ...SMALL_QUEUE,
      queueLimit: 2,
    });
    const first = deferred();
    const held = [
      gate.run(async () => first.promise),
      gate.run(async () => "queued one"),
      gate.run(async () => "queued two"),
    ];
    await flush();
    expect(gate.waitingCount).toBe(2);

    let ran = false;
    const refused = gate.run(async () => {
      ran = true;
    });
    await expect(refused).rejects.toBeInstanceOf(RestoreQueueBusyException);
    await expect(refused).rejects.toMatchObject({
      // Transient: capacity exists, this request could not have it now. The
      // controller turns this into the Retry-After header.
      retryAfterSeconds: RESTORE_RETRY_AFTER_SECONDS,
    });
    expect(ran).toBe(false);
    // The refusal did not join the queue it was refused for.
    expect(gate.waitingCount).toBe(2);

    first.resolve();
    await Promise.all(held);
    expect(gate.activeCount).toBe(0);
  });

  it("refuses with a retryable 503 when the wait runs out", async () => {
    // A real 5 ms deadline rather than fake timers: the assertion is on the
    // promise the timer settles, so there is nothing to poll and no flake.
    const gate = new RestoreProcessingGate(1, {
      queueLimit: 4,
      waitTimeoutMs: 5,
    });
    const first = deferred();
    const p1 = gate.run(async () => first.promise);
    await flush();

    let ran = false;
    await expect(
      gate.run(async () => {
        ran = true;
      }),
    ).rejects.toBeInstanceOf(RestoreQueueBusyException);
    expect(ran).toBe(false);
    expect(gate.waitingCount).toBe(0);

    first.resolve();
    await p1;
    expect(gate.activeCount).toBe(0);
  });

  it("keeps the order of the waiters an abort leaves behind", async () => {
    const gate = new RestoreProcessingGate(1, SMALL_QUEUE);
    const first = deferred();
    const started: string[] = [];
    const abandoned = new AbortController();

    const p1 = gate.run(async () => {
      started.push("first");
      await first.promise;
    });
    const pa = gate.run(async () => {
      started.push("a");
    });
    const pb = gate.run(
      async () => {
        started.push("b");
      },
      { signal: abandoned.signal },
    );
    const pc = gate.run(async () => {
      started.push("c");
    });
    const rejected = expect(pb).rejects.toBeInstanceOf(
      RestoreWaitAbandonedException,
    );

    await flush();
    expect(gate.waitingCount).toBe(3);
    abandoned.abort();
    await rejected;
    expect(gate.waitingCount).toBe(2);

    first.resolve();
    await Promise.all([p1, pa, pc]);
    // The middle waiter is gone; the two around it kept their places.
    expect(started).toEqual(["first", "a", "c"]);
    expect(gate.activeCount).toBe(0);
    expect(gate.waitingCount).toBe(0);
  });

  /**
   * The zero-capacity 503 must stay distinguishable from the transient ones: it
   * is a deployment to fix, and a client that retries it unchanged learns
   * nothing. The header is the difference, so the type carrying the header is
   * the thing to assert.
   */
  it("does not offer a retry for zero modeled capacity", async () => {
    const gate = new RestoreProcessingGate(4);
    gate.configure(0);
    const refused = gate.run(async () => "ran");
    await expect(refused).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(refused).rejects.not.toBeInstanceOf(RestoreQueueBusyException);
  });
});

describe("computeRestoreProcessingSlots", () => {
  it("serialises on the chart's default backend", () => {
    // One restore's processing peak leaves no room for a second on a 400 MiB pod.
    expect(computeRestoreProcessingSlots(400 * MIB)).toBeLessThanOrEqual(1);
  });

  /**
   * Since the expanded ceiling is solved out of the container's headroom (issue
   * #1073), one slot is the answer almost everywhere **by construction**: a bigger
   * pod buys a bigger artifact rather than a second concurrent restore. More slots
   * appear only once the ceiling hits `MAX_DERIVED_LIMIT_BYTES` and stops growing
   * with the pod -- or when an operator lowers `BACKUP_RESTORE_EXPANDED_LIMIT`,
   * which is the deliberate lever for trading artifact size for concurrency.
   */
  it("serialises by construction, and parallelises only once the cap binds", () => {
    expect(computeRestoreProcessingSlots(8192 * MIB)).toBe(1);
    expect(computeRestoreProcessingSlots(32768 * MIB)).toBeGreaterThan(1);
    // The operator's lever: a smaller artifact ceiling on the same pod. Each of
    // those restores still pays the fixed cost, so the slot count grows more
    // slowly than the ceiling shrinks -- which is the honest arithmetic, and was
    // not visible while the model scaled purely with the payload.
    expect(
      computeRestoreProcessingSlots(8192 * MIB, 128 * MIB),
    ).toBeGreaterThan(1);
  });

  /**
   * DOC-F3RB-R9-001, now the property rather than the defect.
   *
   * This test used to pin how thin the old model's margin was: on the default pod
   * it left 4 MiB of 400, and a true multiple 1.3% above the assumed 3 put a
   * single admitted restore over the container. The measurement (issue #1073) put
   * the real multiple near 8, so that margin was fiction -- four of five 96 MiB
   * artifacts could not be decoded inside the headroom the model was handing out.
   *
   * What has to hold now: the break-even multiple -- the one at which one admitted
   * restore stops fitting -- is above what was measured, with the margin the
   * derivation claims. The gate still bounds only concurrency; the difference is
   * that the ceiling it admits was solved out of the capacity instead of being a
   * share of it, so the two are no longer the same number in disguise.
   */
  it("admits one restore whose measured peak fits, with margin", () => {
    const container = 400 * MIB;
    const expanded = resolveRestoreExpandedLimitBytes(undefined, container);
    const baseline = restoreProcessBaselineBytes(container);

    expect(computeRestoreProcessingSlots(container)).toBe(1);
    // The measured cost of what is admitted, plus 15%, inside what is left after
    // the process baseline. Stated against `restorePeakBytes` rather than a
    // multiple because the cost has a fixed part: a model that scales entirely
    // with the payload is right at one artifact size and wrong at the others.
    expect(restorePeakBytes(expanded) * 1.15).toBeLessThanOrEqual(
      container - baseline,
    );
  });

  /**
   * The other half of the same fix: a container with no headroom admits nothing.
   * `computeRestoreProcessingSlots` used to return `1` for a non-positive
   * per-restore peak -- a guard against absurd input that, once the ceiling could
   * legitimately derive to zero, admitted a restore on exactly the deployments
   * that cannot run one.
   */
  it("admits nothing where the ceiling derives to zero", () => {
    expect(computeRestoreProcessingSlots(128 * MIB)).toBe(0);
    expect(computeRestoreProcessingSlots(400 * MIB, 0)).toBe(0);
    // And where the fixed cost alone exceeds the headroom, which is a bigger pod
    // than it sounds: 200 MiB leaves 60 MiB, against ~78 MiB of fixed cost.
    expect(computeRestoreProcessingSlots(200 * MIB)).toBe(0);
  });

  /**
   * The prose half of the same finding, scanned rather than trusted: a comment
   * asserting a property the code lacks is the defect this audit keeps finding.
   *
   * Two lessons are built into the shape of this guard, both from it failing to do
   * its job the first time. It scans **this file as well as the implementation** --
   * the previous version scanned only the source and so missed a stale zero-floor
   * sentence sitting a few lines below itself, which is the obvious blind spot of a
   * guard that exempts its own file. And the phrases are **assembled from
   * fragments**, because the first version tripped on its own quotations of the
   * wording it forbids; spelling them out means the guard cannot explain what it
   * rejects.
   *
   * Digits and words are both listed: "at 1" and "at one" are the same claim, and
   * the stale sentence used the spelling the pattern did not.
   */
  it("does not reintroduce a disproved memory or zero-capacity claim", () => {
    const files = [
      "restore-processing-gate.ts",
      "restore-processing-gate.spec.ts",
    ];
    const forbidden = [
      ["robust to the unmeasured", "multiple"].join(" "),
      ["does not itself depend on", "the multiple"].join(" "),
      ["gate itself", "floors capacity at 1"].join(" "),
      ["gate itself", "floors capacity at one"].join(" "),
      ["gate itself still", "floors capacity at one"].join(" "),
    ];

    for (const file of files) {
      const text = readFileSync(join(__dirname, file), "utf8");
      for (const claim of forbidden) {
        expect(text).not.toContain(claim);
      }
    }
  });

  it("serialises when the container limit is unknown", () => {
    // "Cannot tell how big the pod is" reads as "run them one at a time".
    expect(computeRestoreProcessingSlots(null)).toBe(1);
  });

  /**
   * F3R7-002 scenario A: the slot count must budget against the *resolved*
   * expanded limit, not a separately derived default. A 2 GiB override that lets
   * each restore decompress to 2 GiB must not still be modeled at the 1 GiB cap.
   */
  it("uses the passed expanded limit, not a re-derived default", () => {
    const container = 16 * 1024 * MIB;
    const withOverride = computeRestoreProcessingSlots(
      container,
      2 * 1024 * MIB, // resolved BACKUP_RESTORE_EXPANDED_LIMIT=2gb
    );
    // 5 was the pre-fix answer (16 / (3 * 1 GiB)); the honest answer with the
    // real 2 GiB limit and a baseline is far smaller.
    expect(withOverride).toBeLessThan(5);
    // And every admitted restore's peak fits, each paying the fixed cost:
    // baseline + slots * restorePeakBytes(2 GiB) <= container.
    expect(
      restoreProcessBaselineBytes(container) +
        withOverride * restorePeakBytes(2 * 1024 * MIB),
    ).toBeLessThanOrEqual(container);
  });

  /**
   * F3R7-002 scenario B: a container where one modeled restore does not fit
   * returns 0 -- an honest signal the caller surfaces -- rather than forcing an
   * unsafe slot. `configure` preserves that zero and `acquire` refuses with a 503
   * before the work callback runs -- there is no floor left to undo it (F3RB-005).
   */
  it("returns zero when one restore does not fit, rather than forcing one", () => {
    // 256 MiB container, ~96 MiB baseline, 3 * 64 MiB expanded peak = 192 MiB,
    // which does not fit the ~160 MiB left.
    expect(computeRestoreProcessingSlots(256 * MIB, 64 * MIB, 96 * MIB)).toBe(
      0,
    );
  });

  it("subtracts the baseline before dividing", () => {
    // Without a baseline, container/peak would give one more slot than is safe.
    const withBaseline = computeRestoreProcessingSlots(
      1200 * MIB,
      100 * MIB,
      600 * MIB,
    );
    const withoutBaseline = computeRestoreProcessingSlots(
      1200 * MIB,
      100 * MIB,
      0,
    );
    expect(withBaseline).toBeLessThan(withoutBaseline);
  });

  describe("zero honest capacity (F3RB-005)", () => {
    it("refuses rather than admitting one restore its model says cannot fit", async () => {
      // Flooring zero to one turned a fixable misconfiguration into an OOM kill
      // mid-restore. The refusal is a 503 the operator can act on.
      const gate = new RestoreProcessingGate(4);
      gate.configure(0);

      await expect(gate.run(async () => "restored")).rejects.toThrow(
        ServiceUnavailableException,
      );
      expect(gate.activeCount).toBe(0);
      expect(gate.waitingCount).toBe(0);
    });

    it("does not run the work at all", async () => {
      const gate = new RestoreProcessingGate(1);
      gate.configure(0);
      const work = jest.fn().mockResolvedValue("restored");

      await expect(gate.run(work)).rejects.toThrow(ServiceUnavailableException);
      expect(work).not.toHaveBeenCalled();
    });

    it("names the two knobs an operator can turn", async () => {
      const gate = new RestoreProcessingGate(1);
      gate.configure(0);

      await expect(gate.run(async () => 1)).rejects.toThrow(
        /container memory limit or lower BACKUP_RESTORE_EXPANDED_LIMIT/,
      );
    });

    it("serves again once capacity is restored", async () => {
      // The refusal must not be sticky: fixing the limit and reconfiguring is
      // the documented remedy, so it has to actually work.
      const gate = new RestoreProcessingGate(1);
      gate.configure(0);
      await expect(gate.run(async () => 1)).rejects.toThrow();

      gate.configure(2);
      await expect(gate.run(async () => "ok")).resolves.toBe("ok");
    });
  });
});
