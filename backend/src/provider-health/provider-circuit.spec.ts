import {
  FAILURE_THRESHOLD,
  FAILURE_WINDOW_MS,
  MAX_OPEN_WINDOW_MS,
  OPEN_WINDOW_MS,
  PROBE_TIMEOUT_MS,
  ProviderCircuit,
} from "./provider-circuit";

/** A circuit whose clock the test moves, so no window has to be waited out. */
function circuitAt(start = 1_000_000): {
  circuit: ProviderCircuit;
  advance: (ms: number) => void;
} {
  let now = start;
  const circuit = new ProviderCircuit(() => now);
  return {
    circuit,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

/** Drive it to the open state the cheap way. */
function open(circuit: ProviderCircuit, reason = "ECONNREFUSED"): void {
  for (let i = 0; i < FAILURE_THRESHOLD; i++) {
    circuit.recordTransportFailure(reason);
  }
}

describe("ProviderCircuit", () => {
  it("lets everything through while the provider answers", () => {
    const { circuit } = circuitAt();
    for (let i = 0; i < 50; i++) {
      expect(circuit.beforeRequest().allowed).toBe(true);
      circuit.recordSuccess();
    }
  });

  it("opens on the threshold and reports it exactly once", () => {
    const { circuit } = circuitAt();
    const transitions: Array<string | null> = [];
    for (let i = 0; i < FAILURE_THRESHOLD + 3; i++) {
      transitions.push(
        circuit.recordTransportFailure("ECONNREFUSED").transition,
      );
    }
    expect(transitions.filter((t) => t === "opened")).toHaveLength(1);
    expect(transitions[FAILURE_THRESHOLD - 1]).toBe("opened");
  });

  it("refuses calls while open, and counts what it refused", () => {
    const { circuit } = circuitAt();
    open(circuit);

    // This is the flood the breaker exists to stop: 24 indexes x 11 chunks.
    let refused = 0;
    for (let i = 0; i < 264; i++) {
      const decision = circuit.beforeRequest();
      if (!decision.allowed) refused++;
    }
    expect(refused).toBe(264);
    expect(circuit.snapshot().suppressedCalls).toBe(264);
  });

  it("tells a refused caller how long to wait and what went wrong", () => {
    const { circuit, advance } = circuitAt();
    open(circuit, "ENOTFOUND api.example");
    advance(10_000);
    const decision = circuit.beforeRequest();
    expect(decision.allowed).toBe(false);
    expect(decision.retryAfterMs).toBe(OPEN_WINDOW_MS - 10_000);
    expect(decision.lastFailureReason).toBe("ENOTFOUND api.example");
  });

  it("admits exactly one probe when the window elapses", () => {
    const { circuit, advance } = circuitAt();
    open(circuit);
    advance(OPEN_WINDOW_MS);

    const first = circuit.beforeRequest();
    expect(first.allowed).toBe(true);
    expect(first.state).toBe("half-open");
    // Everyone else still waits: one socket per window, not a herd.
    expect(circuit.beforeRequest().allowed).toBe(false);
    expect(circuit.beforeRequest().allowed).toBe(false);
  });

  it("closes on a successful probe and reports the recovery once", () => {
    const { circuit, advance } = circuitAt();
    open(circuit);
    advance(OPEN_WINDOW_MS);
    circuit.beforeRequest();

    const outcome = circuit.recordSuccess();
    expect(outcome.transition).toBe("recovered");
    expect(outcome.snapshot.state).toBe("closed");
    expect(circuit.beforeRequest().allowed).toBe(true);
    expect(circuit.recordSuccess().transition).toBeNull();
  });

  it("reports how many calls were refused during the outage", () => {
    const { circuit, advance } = circuitAt();
    open(circuit);
    for (let i = 0; i < 7; i++) circuit.beforeRequest();
    advance(OPEN_WINDOW_MS);
    circuit.beforeRequest();
    expect(circuit.recordSuccess().suppressedCalls).toBe(7);
  });

  it("doubles the window when the probe fails, and never reports again", () => {
    const { circuit, advance } = circuitAt();
    open(circuit);

    for (const expected of [
      OPEN_WINDOW_MS * 2,
      OPEN_WINDOW_MS * 4,
      OPEN_WINDOW_MS * 8,
    ]) {
      advance(circuit.beforeRequest().retryAfterMs || 0);
      advance(1);
      expect(circuit.beforeRequest().state).toBe("half-open");
      // A failed probe is the same episode continuing, so it is not a second
      // "opened" -- one alert per outage, not one per window (issue #1265).
      expect(
        circuit.recordTransportFailure("still down").transition,
      ).toBeNull();
      expect(circuit.beforeRequest().retryAfterMs).toBe(expected);
    }
  });

  it("re-arms the window when a failure lands after it elapsed", () => {
    // A caller can reach the provider without taking the probe slot (a gate
    // that only read the state used to allow exactly that). Its failure is the
    // same evidence a probe's is, and leaving `retryAt` in the past made every
    // later check see an elapsed window -- a breaker that protected for one
    // minute and then never again.
    const { circuit, advance } = circuitAt();
    open(circuit);
    advance(OPEN_WINDOW_MS + 1);

    circuit.recordTransportFailure("still down");

    const decision = circuit.beforeRequest();
    expect(decision.allowed).toBe(false);
    expect(decision.retryAfterMs).toBe(OPEN_WINDOW_MS * 2);
  });

  it("does not escalate on failures that were already in flight", () => {
    // Requests admitted just before the breaker opened land afterwards. They
    // are not new evidence, and doubling the window per straggler would push a
    // brief outage to the cap.
    const { circuit, advance } = circuitAt();
    open(circuit);
    advance(5_000);
    for (let i = 0; i < 10; i++) circuit.recordTransportFailure("in flight");
    expect(circuit.beforeRequest().retryAfterMs).toBe(OPEN_WINDOW_MS - 5_000);
  });

  it("caps the window so a day-long outage still gets probed", () => {
    const { circuit, advance } = circuitAt();
    open(circuit);
    for (let i = 0; i < 20; i++) {
      advance(MAX_OPEN_WINDOW_MS + 1);
      circuit.beforeRequest();
      circuit.recordTransportFailure("still down");
    }
    expect(circuit.beforeRequest().retryAfterMs).toBe(MAX_OPEN_WINDOW_MS);
  });

  it("resets the escalation after a recovery", () => {
    const { circuit, advance } = circuitAt();
    open(circuit);
    advance(OPEN_WINDOW_MS + 1);
    circuit.beforeRequest();
    circuit.recordTransportFailure("still down");
    advance(OPEN_WINDOW_MS * 2 + 1);
    circuit.beforeRequest();
    circuit.recordSuccess();

    open(circuit);
    // A fresh outage starts at the first window, not where the last one ended.
    expect(circuit.beforeRequest().retryAfterMs).toBe(OPEN_WINDOW_MS);
  });

  it("forgets a failure run the window has moved past", () => {
    // Four failures, then quiet, then one more a week later. Counting those
    // together would open the breaker on a provider that is working -- and a
    // success cannot be what clears them, because the failure mode this window
    // exists for (headers answered, body stalled) interleaves one success per
    // failure forever.
    const { circuit, advance } = circuitAt();
    for (let i = 0; i < FAILURE_THRESHOLD - 1; i++) {
      circuit.recordTransportFailure("blip");
    }
    expect(circuit.snapshot().recentFailures).toBe(FAILURE_THRESHOLD - 1);

    advance(FAILURE_WINDOW_MS + 1);

    expect(circuit.recordTransportFailure("blip").transition).toBeNull();
    expect(circuit.snapshot().recentFailures).toBe(1);
    expect(circuit.beforeRequest().allowed).toBe(true);
  });

  it("opens on failures a success cannot cancel", () => {
    // A provider that answers headers and then stalls the body: one success and
    // one failure per request, forever. A consecutive-run breaker never reaches
    // two, and the flood this whole change exists to stop comes straight back.
    const { circuit, advance } = circuitAt();
    let transitions = 0;
    for (let i = 0; i < FAILURE_THRESHOLD; i++) {
      circuit.recordSuccess();
      advance(1_000);
      if (
        circuit.recordTransportFailure("body timeout").transition === "opened"
      ) {
        transitions++;
      }
    }
    expect(transitions).toBe(1);
    expect(circuit.beforeRequest().allowed).toBe(false);
  });

  it("keeps the first failure of the run as the outage start", () => {
    const { circuit, advance } = circuitAt(5_000_000);
    circuit.recordTransportFailure("one");
    advance(30_000);
    for (let i = 1; i < FAILURE_THRESHOLD; i++) {
      circuit.recordTransportFailure("more");
    }
    expect(circuit.snapshot().failingSince).toBe(5_000_000);
    expect(circuit.snapshot().lastFailureAt).toBe(5_030_000);
  });

  it("re-admits a probe whose caller never reported an outcome", () => {
    const { circuit, advance } = circuitAt();
    open(circuit);
    advance(OPEN_WINDOW_MS + 1);
    expect(circuit.beforeRequest().state).toBe("half-open");

    // The probe's caller threw between being admitted and recording anything.
    // The slot is exclusive, so without a bound on it the provider would never
    // be called again for the life of the process.
    advance(PROBE_TIMEOUT_MS - 1);
    expect(circuit.beforeRequest().allowed).toBe(false);
    advance(1);
    expect(circuit.beforeRequest().allowed).toBe(true);
  });

  it("tells a caller refused during a probe to wait for that probe", () => {
    const { circuit, advance } = circuitAt();
    open(circuit);
    advance(OPEN_WINDOW_MS + 1);
    circuit.beforeRequest();
    advance(5_000);
    expect(circuit.beforeRequest().retryAfterMs).toBe(PROBE_TIMEOUT_MS - 5_000);
  });
});
