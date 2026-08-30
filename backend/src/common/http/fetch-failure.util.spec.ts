import {
  MAX_FETCH_FAILURE_LENGTH,
  describeFetchFailure,
  fetchFailureCode,
  isTransportFailure,
} from "./fetch-failure.util";

/** The exact shape undici rejects with when DNS cannot resolve the host. */
function undiciFetchFailed(
  cause: Record<string, unknown> = {
    name: "Error",
    message: "getaddrinfo EAI_AGAIN query1.finance.yahoo.com",
    code: "EAI_AGAIN",
    errno: -3001,
    syscall: "getaddrinfo",
    hostname: "query1.finance.yahoo.com",
  },
): Error {
  const error = new TypeError("fetch failed");
  Object.assign(error, { cause: Object.assign(new Error(), cause) });
  return error;
}

describe("describeFetchFailure", () => {
  it("names the cause the bare message hides", () => {
    // The log in issue #1265 was exactly `TypeError: fetch failed` and a stack
    // of undici frames -- true, and useless. This is the regression: the line
    // has to carry what actually failed.
    const line = describeFetchFailure(undiciFetchFailed());

    expect(line).toContain("fetch failed");
    expect(line).toContain("EAI_AGAIN");
    expect(line).toContain("syscall=getaddrinfo");
    expect(line).toContain("hostname=query1.finance.yahoo.com");
  });

  it("keeps the chain in order, outermost first", () => {
    const line = describeFetchFailure(undiciFetchFailed());
    expect(line.indexOf("fetch failed")).toBeLessThan(
      line.indexOf("getaddrinfo EAI_AGAIN"),
    );
  });

  it("does not repeat a cause that only echoes its parent", () => {
    const inner = new Error("socket hang up");
    const outer = new Error("socket hang up");
    Object.assign(outer, { cause: inner });
    expect(describeFetchFailure(outer)).toBe("socket hang up");
  });

  it("reports an AbortSignal.timeout rejection as a timeout", () => {
    const error = new Error("The operation was aborted due to timeout");
    error.name = "TimeoutError";
    expect(describeFetchFailure(error)).toContain("TimeoutError");
  });

  it("survives a cause cycle", () => {
    const a = new Error("a");
    const b = new Error("b");
    Object.assign(a, { cause: b });
    Object.assign(b, { cause: a });
    expect(describeFetchFailure(a)).toBe("a <- b");
  });

  it("handles a thrown non-error", () => {
    expect(describeFetchFailure("boom")).toBe("boom");
    expect(describeFetchFailure(null)).toBe("unknown error");
    expect(describeFetchFailure(undefined)).toBe("unknown error");
  });

  it("stays short enough for a database column and an email", () => {
    // The reason is stored and rendered, so an upstream that nests a page of
    // causes must not become the body of an alert.
    let error = new Error("x".repeat(400));
    for (let depth = 0; depth < 6; depth++) {
      const next = new Error("y".repeat(400));
      Object.assign(next, { cause: error });
      error = next;
    }
    const line = describeFetchFailure(error);
    expect(line.length).toBeLessThanOrEqual(MAX_FETCH_FAILURE_LENGTH);
    expect(line.endsWith("...")).toBe(true);
  });

  it("collapses newlines so one failure is one log line", () => {
    expect(describeFetchFailure(new Error("first\nsecond"))).toBe(
      "first second",
    );
  });
});

describe("fetchFailureCode", () => {
  it("reads the code from the cause, not the outer TypeError", () => {
    expect(fetchFailureCode(undiciFetchFailed())).toBe("EAI_AGAIN");
  });

  it("is null when nothing in the chain carries one", () => {
    expect(fetchFailureCode(new Error("nope"))).toBeNull();
  });
});

describe("isTransportFailure", () => {
  it("counts a fetch rejection: undici only rejects when nothing answered", () => {
    expect(isTransportFailure(undiciFetchFailed())).toBe(true);
  });

  it.each([
    "ECONNREFUSED",
    "ECONNRESET",
    "ENOTFOUND",
    "ETIMEDOUT",
    "UND_ERR_CONNECT_TIMEOUT",
    "CERT_HAS_EXPIRED",
  ])("counts %s", (code) => {
    expect(isTransportFailure(Object.assign(new Error("x"), { code }))).toBe(
      true,
    );
  });

  it("counts an aborted or timed-out request", () => {
    const aborted = new Error("aborted");
    aborted.name = "AbortError";
    expect(isTransportFailure(aborted)).toBe(true);
  });

  it("does not count a body that would not parse", () => {
    // The provider answered; this request is the problem. Counting it would
    // open the breaker on one malformed payload and take the provider down for
    // everything else.
    expect(
      isTransportFailure(new SyntaxError("Unexpected token < in JSON")),
    ).toBe(false);
  });

  it("does not count an application error carrying no network code", () => {
    expect(isTransportFailure(new Error("no history returned"))).toBe(false);
  });
});
