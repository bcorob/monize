/**
 * One outbound provider's circuit breaker: the thing that stops a dead upstream
 * from being asked again a thousand times a minute.
 *
 * Issue #1265: Yahoo became unreachable from the container, and every code path
 * that wanted a price kept calling `fetch` anyway. A bootstrap market-index
 * refresh alone is 24 indexes x up to 11 yearly chunks, each waiting out its
 * own timeout and each logging a stack; the register, the dashboard and the
 * chart endpoints added theirs on every render. The result was a log nobody
 * could read, an event loop with hundreds of doomed sockets on it, and a
 * container the operator restarted -- which ran the bootstrap refresh again.
 *
 * The breaker turns "the provider is down" from a per-call discovery into a
 * fact the process holds:
 *
 * - **closed** -- normal. Transport failures are counted inside a sliding
 *   *time* window (`FAILURE_WINDOW_MS`), not as a consecutive run. A run is
 *   what a breaker usually counts, and it is wrong for the failure mode that
 *   matters here: a provider that accepts the connection and then stalls the
 *   body answers its *headers* every time, so a success landed on every request
 *   and the run never reached two. Time is what bounds the count in the other
 *   direction -- five failures a week apart are not an outage, and now they age
 *   out instead of needing a success to clear them.
 * - **open** -- `FAILURE_THRESHOLD` failures inside that window. No request
 *   leaves the process until the window elapses; callers get
 *   `ProviderUnavailableError` immediately instead of a 10-60s timeout. Each
 *   consecutive open window is twice as long as the last, capped, so an outage
 *   that lasts an hour costs a handful of probes rather than one per minute.
 * - **half-open** -- the window elapsed and exactly one probe is admitted. Its
 *   outcome decides: success closes the breaker and clears the escalation,
 *   failure re-opens it for the next (longer) window. One probe, not a
 *   thundering herd: the whole point is that a still-dead provider costs one
 *   socket per window.
 *
 * Only *transport* failures count (see `isTransportFailure`). An HTTP 404 or a
 * body that will not parse is this request's problem; the server answered.
 *
 * State is per process and deliberately in memory: it describes what *this*
 * replica just experienced with its own sockets and DNS, which is exactly the
 * thing a shared table could not tell it. What is durable is the *notification*
 * state (`provider_health`), so the alert survives the restart loop the outage
 * causes.
 */

/**
 * How far back the open decision looks.
 *
 * Long enough that a provider failing every few seconds reaches the threshold,
 * short enough that yesterday's blip is not evidence about now.
 */
export const FAILURE_WINDOW_MS = 5 * 60_000;

/** Transport failures within that window that open the breaker. */
export const FAILURE_THRESHOLD = 5;

/** How long the first open window lasts. */
export const OPEN_WINDOW_MS = 60_000;

/** Ceiling for the doubling. Twenty minutes of a dead provider costs 5 probes. */
export const MAX_OPEN_WINDOW_MS = 15 * 60_000;

/**
 * How long a half-open probe may be in flight before another is admitted.
 *
 * The probe slot is exclusive, so a caller that neither succeeds nor reports a
 * failure -- one that throws between `beforeRequest` and `record*`, or awaits a
 * promise that never settles -- would otherwise hold it for the life of the
 * process and the provider would never be called again. Comfortably longer than
 * the longest request timeout in the clients (60s), so a slow-but-live probe is
 * not raced.
 */
export const PROBE_TIMEOUT_MS = 2 * 60_000;

export type ProviderCircuitState = "closed" | "open" | "half-open";

/** What the breaker did, if anything, as a result of one recorded outcome. */
export type ProviderCircuitTransition = "opened" | "recovered" | null;

export interface ProviderCircuitSnapshot {
  readonly state: ProviderCircuitState;
  /** Transport failures inside the last `FAILURE_WINDOW_MS`. */
  readonly recentFailures: number;
  /** First failure of the current run of failures, null when there is none. */
  readonly failingSince: number | null;
  readonly lastFailureAt: number | null;
  readonly lastFailureReason: string | null;
  readonly lastSuccessAt: number | null;
  /** Calls refused since the breaker last opened. */
  readonly suppressedCalls: number;
  /** When the current open window ends; null unless the state is `open`. */
  readonly retryAt: number | null;
}

/** Whether a call may go out, and what to tell the caller when it may not. */
export interface ProviderCircuitDecision {
  readonly allowed: boolean;
  readonly state: ProviderCircuitState;
  /** Milliseconds until the next probe is admitted. 0 when allowed. */
  readonly retryAfterMs: number;
  /** Refused calls including this one; 0 when allowed. */
  readonly suppressedCalls: number;
  readonly lastFailureReason: string | null;
}

/** The outcome of recording a success or a failure. */
export interface ProviderCircuitOutcome {
  readonly transition: ProviderCircuitTransition;
  readonly snapshot: ProviderCircuitSnapshot;
  /**
   * Calls the breaker refused during the window that just ended. Reported on a
   * transition so one line can say how much noise was suppressed rather than
   * the noise itself being the report.
   */
  readonly suppressedCalls: number;
}

export class ProviderCircuit {
  private state: ProviderCircuitState = "closed";
  /**
   * When each transport failure still inside the window happened, oldest first.
   * Rebuilt rather than mutated, like every other array in this codebase.
   *
   * Successes are not recorded here at all, which is the point: a provider that
   * answers headers and stalls bodies interleaves them one for one, and any
   * scheme where a success cancels a failure never reaches the threshold.
   */
  private failures: readonly number[] = [];
  private failingSince: number | null = null;
  private lastFailureAt: number | null = null;
  private lastFailureReason: string | null = null;
  private lastSuccessAt: number | null = null;
  private retryAt: number | null = null;
  private openWindowMs = OPEN_WINDOW_MS;
  private suppressedCalls = 0;
  /** When the in-flight `half-open` probe was admitted; null when none is. */
  private probeStartedAt: number | null = null;

  /**
   * @param now injected clock. Every test in this repo that reads the wall
   *   clock is a test about today's date (root `CLAUDE.md`); a breaker whose
   *   windows could only be tested by waiting them out would not be tested.
   */
  constructor(private readonly now: () => number = Date.now) {}

  /**
   * What `beforeRequest` would do, computed once so the read-only predicate and
   * the mutating gate cannot drift apart.
   */
  private admission(now: number): "open-gate" | "probe" | "refuse" {
    if (this.state === "closed") return "open-gate";
    if (this.state === "open" && this.retryAt !== null && now >= this.retryAt) {
      return "probe";
    }
    if (
      this.state === "half-open" &&
      (this.probeStartedAt === null ||
        now - this.probeStartedAt >= PROBE_TIMEOUT_MS)
    ) {
      return "probe";
    }
    return "refuse";
  }

  /**
   * Whether a request would be refused right now, taking nothing.
   *
   * For a caller deciding whether to *skip work*, never as the gate before a
   * request: a gate has to take the slot. Notably true only while there is
   * genuinely no way through -- a half-open state whose probe was handed back
   * admits the next caller, and reporting that as "refused" would strand a
   * deployment whose only Yahoo caller is the one asking.
   */
  wouldRefuse(): boolean {
    return this.admission(this.now()) === "refuse";
  }

  /** Failures still inside the window, dropping the ones that have aged out. */
  private failureCount(): number {
    const cutoff = this.now() - FAILURE_WINDOW_MS;
    return this.failures.filter((at) => at > cutoff).length;
  }

  /** Record a failure, and forget the ones the window has moved past. */
  private pushFailure(at: number): void {
    const cutoff = at - FAILURE_WINDOW_MS;
    this.failures = [...this.failures.filter((t) => t > cutoff), at];
  }

  snapshot(): ProviderCircuitSnapshot {
    return {
      state: this.state,
      recentFailures: this.failureCount(),
      failingSince: this.failingSince,
      lastFailureAt: this.lastFailureAt,
      lastFailureReason: this.lastFailureReason,
      lastSuccessAt: this.lastSuccessAt,
      suppressedCalls: this.suppressedCalls,
      retryAt: this.state === "open" ? this.retryAt : null,
    };
  }

  /**
   * Ask whether one request may go out, and take the probe slot if it may.
   *
   * Called immediately before the request. A refusal is not an error condition
   * here -- the caller decides whether to throw, return null or skip.
   */
  beforeRequest(): ProviderCircuitDecision {
    const now = this.now();
    const decision = this.admission(now);

    if (decision === "open-gate") {
      return {
        allowed: true,
        state: "closed",
        retryAfterMs: 0,
        suppressedCalls: 0,
        lastFailureReason: this.lastFailureReason,
      };
    }

    if (decision === "probe") {
      // Either the window elapsed and this caller becomes the probe, or the
      // previous probe never reported an outcome and its slot has timed out --
      // holding the exclusive slot forever would leave the provider uncalled
      // for the life of the process.
      this.state = "half-open";
      this.probeStartedAt = now;
      return {
        allowed: true,
        state: "half-open",
        retryAfterMs: 0,
        suppressedCalls: 0,
        lastFailureReason: this.lastFailureReason,
      };
    }

    this.suppressedCalls++;
    // While a probe is in flight there is no window to wait out, so the wait is
    // however long that probe may still hold the slot.
    const waitUntil =
      this.state === "half-open"
        ? (this.probeStartedAt ?? now) + PROBE_TIMEOUT_MS
        : this.retryAt;
    return {
      allowed: false,
      state: this.state,
      retryAfterMs: waitUntil !== null ? Math.max(0, waitUntil - now) : 0,
      suppressedCalls: this.suppressedCalls,
      lastFailureReason: this.lastFailureReason,
    };
  }

  /**
   * Hand back a probe slot without claiming to have learned anything.
   *
   * For a caller that took the slot and then could not reach the provider's own
   * host at all -- the Yahoo crumb handshake gives up before it ever calls the
   * API host if no cookie source answers with a cookie. Reporting that as a
   * success would close the breaker on evidence about a different host;
   * reporting nothing would hold the exclusive slot until it times out.
   */
  releaseProbe(): void {
    if (this.state === "half-open") this.probeStartedAt = null;
  }

  /** Record a request that got an answer. Closes the breaker if it was not. */
  recordSuccess(): ProviderCircuitOutcome {
    const suppressed = this.suppressedCalls;
    const wasOpen = this.state !== "closed";
    this.state = "closed";
    this.probeStartedAt = null;
    // A recovery clears the window; an ordinary success does not touch it. That
    // is what makes a half-answering provider reach the threshold at all -- it
    // answers headers on every request, so cancelling a failure with a success
    // would leave the count pinned at one forever.
    if (wasOpen) {
      this.failures = [];
      this.failingSince = null;
    } else if (this.failureCount() === 0) {
      this.failures = [];
      this.failingSince = null;
    }
    this.lastSuccessAt = this.now();
    this.retryAt = null;
    this.openWindowMs = OPEN_WINDOW_MS;
    this.suppressedCalls = 0;
    return {
      transition: wasOpen ? "recovered" : null,
      snapshot: this.snapshot(),
      suppressedCalls: suppressed,
    };
  }

  /**
   * Record a transport failure. Opens the breaker on the threshold, and
   * re-opens it (for twice as long) when the probe was the one that failed.
   */
  recordTransportFailure(reason: string): ProviderCircuitOutcome {
    const now = this.now();
    const wasProbe = this.state === "half-open";
    this.probeStartedAt = null;
    this.pushFailure(now);
    // The oldest failure still inside the window is when this episode began.
    this.failingSince = this.failures[0] ?? now;
    this.lastFailureAt = now;
    this.lastFailureReason = reason;

    // A failed probe -- or a failure recorded after the window elapsed without
    // one, which is the same evidence from a caller that reached the provider
    // by another door -- re-opens the same episode with a longer window.
    //
    // The second half is load-bearing: without it a post-window failure left
    // `retryAt` in the past, so every later gate check saw an elapsed window
    // and admitted the call. The breaker protected for exactly one minute and
    // was then a permanent no-op, which is the defect it exists to prevent.
    const windowElapsed =
      this.state === "open" && this.retryAt !== null && now >= this.retryAt;
    if (wasProbe || windowElapsed) {
      // Not a new "opened" transition: the provider never came back, and
      // reporting one per probe would be the log flood again, one window apart.
      this.openWindowMs = Math.min(this.openWindowMs * 2, MAX_OPEN_WINDOW_MS);
      this.state = "open";
      this.retryAt = now + this.openWindowMs;
      return {
        transition: null,
        snapshot: this.snapshot(),
        suppressedCalls: this.suppressedCalls,
      };
    }

    if (this.state === "closed" && this.failureCount() >= FAILURE_THRESHOLD) {
      this.state = "open";
      this.openWindowMs = OPEN_WINDOW_MS;
      this.retryAt = now + this.openWindowMs;
      this.suppressedCalls = 0;
      return {
        transition: "opened",
        snapshot: this.snapshot(),
        suppressedCalls: 0,
      };
    }

    return {
      transition: null,
      snapshot: this.snapshot(),
      suppressedCalls: this.suppressedCalls,
    };
  }
}
