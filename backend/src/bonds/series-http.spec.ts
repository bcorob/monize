import { ProviderHealthService } from "../provider-health/provider-health.service";
import { ProviderUnavailableError } from "../provider-health/provider-unavailable.error";
import {
  FETCH_MAX_REDIRECTS,
  FetchRefusedError,
  readCapped,
  SERIES_FETCH_TIMEOUT_MS,
  SERIES_MAX_BODY_BYTES,
  SeriesBodyTooLargeError,
  SeriesHttp,
} from "./series-http";

const URL_ = "https://www.obligacjeskarbowe.pl/oferta-obligacji/x/";

function setup(admission: "open-gate" | "probe" = "open-gate") {
  const health = {
    assertAvailable: jest.fn().mockReturnValue(admission),
    recordSuccess: jest.fn(),
    recordFailure: jest.fn().mockReturnValue(false),
    releaseProbe: jest.fn(),
  };
  const http = jest.fn();
  const gated = new SeriesHttp(
    health as unknown as ProviderHealthService,
  ).gated("obligacjeskarbowe", http);
  return { health, http, gated };
}

/** A response whose body is `chunks`, read as a stream that records its cancel. */
function streamed(chunks: Uint8Array[], init: ResponseInit = {}) {
  let cancelled = false;
  let next = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (next < chunks.length) controller.enqueue(chunks[next++]);
      else controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  return {
    response: new Response(body, init),
    wasCancelled: () => cancelled,
  };
}

describe("readCapped", () => {
  it("returns every byte of a body under the cap, across chunks", async () => {
    const { response } = streamed([
      new Uint8Array([1, 2]),
      new Uint8Array([3]),
    ]);
    await expect(readCapped(response, 10)).resolves.toEqual(
      new Uint8Array([1, 2, 3]),
    );
  });

  it("returns an empty body for a response with none", async () => {
    await expect(
      readCapped(new Response(null, { status: 302 }), 10),
    ).resolves.toEqual(new Uint8Array());
  });

  it("accepts a body of exactly the cap", async () => {
    const { response } = streamed([new Uint8Array(10)]);
    await expect(readCapped(response, 10)).resolves.toHaveLength(10);
  });

  it("aborts the stream and throws when the running total passes the cap", async () => {
    const { response, wasCancelled } = streamed([
      new Uint8Array(6),
      new Uint8Array(6),
      new Uint8Array(6),
    ]);
    await expect(readCapped(response, 10)).rejects.toBeInstanceOf(
      SeriesBodyTooLargeError,
    );
    expect(wasCancelled()).toBe(true);
  });

  it("refuses a declared length over the cap before reading a byte", async () => {
    const { response, wasCancelled } = streamed([new Uint8Array(1)], {
      headers: { "content-length": "11" },
    });
    await expect(readCapped(response, 10)).rejects.toBeInstanceOf(
      SeriesBodyTooLargeError,
    );
    expect(wasCancelled()).toBe(true);
  });

  it("does not trust a declared length that is under the cap when the body is not", async () => {
    const { response } = streamed([new Uint8Array(20)], {
      headers: { "content-length": "5" },
    });
    await expect(readCapped(response, 10)).rejects.toBeInstanceOf(
      SeriesBodyTooLargeError,
    );
  });
});

describe("SeriesHttp.gated", () => {
  it("never follows a redirect, and bounds the call by a timeout", async () => {
    const { http, gated } = setup();
    http.mockResolvedValue(new Response("ok", { status: 200 }));
    await gated(URL_);
    const [url, init] = http.mock.calls[0];
    expect(url).toBe(URL_);
    expect(init.redirect).toBe("manual");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(SERIES_FETCH_TIMEOUT_MS).toBe(30_000);
  });

  it("aborts a call that outlives the 30 s timeout and counts it as a failure", async () => {
    const { http, gated, health } = setup();
    const controller = new AbortController();
    const timeout = jest
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(controller.signal);
    http.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) =>
          init.signal?.addEventListener("abort", () =>
            reject(init.signal?.reason),
          ),
        ),
    );
    const pending = gated(URL_);
    controller.abort(new DOMException("timed out", "TimeoutError"));
    await expect(pending).rejects.toMatchObject({ name: "TimeoutError" });
    expect(timeout).toHaveBeenCalledWith(30_000);
    expect(health.recordFailure).toHaveBeenCalled();
    timeout.mockRestore();
  });

  it("returns a 3xx as its status, with the address that was asked", async () => {
    const { http, gated } = setup();
    http.mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "https://evil.example/" },
      }),
    );
    await expect(gated(URL_)).resolves.toEqual({
      status: 302,
      body: new Uint8Array(),
      url: URL_,
    });
  });

  it("returns the status, the body and the response's url", async () => {
    const { http, gated, health } = setup();
    http.mockResolvedValue(new Response("hello", { status: 200 }));
    const result = await gated(URL_);
    expect(result.status).toBe(200);
    expect(new TextDecoder().decode(result.body)).toBe("hello");
    expect(result.url).toBe(URL_);
    expect(health.assertAvailable).toHaveBeenCalledWith("obligacjeskarbowe");
    expect(health.recordSuccess).toHaveBeenCalledWith("obligacjeskarbowe");
  });

  it("caps the body at 5 MB and records no success for it", async () => {
    expect(SERIES_MAX_BODY_BYTES).toBe(5 * 1024 * 1024);
    const { http, gated, health } = setup();
    http.mockResolvedValue(
      new Response(new Uint8Array(SERIES_MAX_BODY_BYTES + 1), { status: 200 }),
    );
    await expect(gated(URL_)).rejects.toBeInstanceOf(SeriesBodyTooLargeError);
    expect(health.recordSuccess).not.toHaveBeenCalled();
    expect(health.recordFailure).toHaveBeenCalled();
  });

  it("refuses before any socket when the breaker is open", async () => {
    const { http, gated, health } = setup();
    health.assertAvailable.mockImplementation(() => {
      throw new ProviderUnavailableError("Obligacje", 1000, null);
    });
    await expect(gated(URL_)).rejects.toBeInstanceOf(ProviderUnavailableError);
    expect(http).not.toHaveBeenCalled();
  });

  it("counts a transport failure and gives back an unused probe slot", async () => {
    const { http, gated, health } = setup("probe");
    const failure = new Error("fetch failed");
    http.mockRejectedValue(failure);
    await expect(gated(URL_)).rejects.toBe(failure);
    expect(health.recordFailure).toHaveBeenCalledWith(
      "obligacjeskarbowe",
      failure,
    );
    expect(health.releaseProbe).toHaveBeenCalledWith("obligacjeskarbowe");
  });

  it("keeps the probe slot when the breaker counted the failure", async () => {
    const { http, gated, health } = setup("probe");
    health.recordFailure.mockReturnValue(true);
    http.mockRejectedValue(new Error("fetch failed"));
    await expect(gated(URL_)).rejects.toThrow();
    expect(health.releaseProbe).not.toHaveBeenCalled();
  });
});

describe("SeriesHttp.gated with a fetch policy (benchmark fetches)", () => {
  const HOST_URL = "https://static.nbp.pl/dane/a.xml";
  const policy = { allowedHosts: ["static.nbp.pl"] };
  const redirect = (location: string, status = 302) =>
    new Response(null, { status, headers: { location } });

  function policed(admission: "open-gate" | "probe" = "open-gate") {
    const { health, http } = setup(admission);
    const gated = new SeriesHttp(
      health as unknown as ProviderHealthService,
    ).gated("nbp", http, policy);
    return { health, http, gated };
  }

  it("serves an answer from an allowed host, never letting fetch follow a redirect itself", async () => {
    const { http, gated, health } = policed();
    http.mockResolvedValue(new Response("<x/>", { status: 200 }));
    const result = await gated(HOST_URL);
    expect(result.status).toBe(200);
    expect(http.mock.calls[0][1].redirect).toBe("manual");
    expect(http.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    expect(health.recordSuccess).toHaveBeenCalledWith("nbp");
  });

  it.each([
    ["plain http", "http://static.nbp.pl/a.xml", "scheme"],
    ["another host", "https://evil.example/a.xml", "host"],
    ["a subdomain", "https://x.static.nbp.pl/a.xml", "host"],
    ["a port", "https://static.nbp.pl:8443/a.xml", "scheme"],
    ["credentials", "https://u:p@static.nbp.pl/a.xml", "scheme"],
  ])(
    "refuses %s before any socket or breaker admission",
    async (_n, url, reason) => {
      const { http, gated, health } = policed();
      await expect(gated(url)).rejects.toMatchObject({
        name: "FetchRefusedError",
        reason,
      });
      expect(http).not.toHaveBeenCalled();
      expect(health.assertAvailable).not.toHaveBeenCalled();
    },
  );

  it("follows a redirect that stays on an allowed https host and reports the final url", async () => {
    const { http, gated } = policed();
    http
      .mockResolvedValueOnce(redirect("/dane/b.xml", 301))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const result = await gated(HOST_URL);
    expect(http.mock.calls.map((c) => c[0])).toEqual([
      HOST_URL,
      "https://static.nbp.pl/dane/b.xml",
    ]);
    expect(result.url).toBe("https://static.nbp.pl/dane/b.xml");
    expect(new TextDecoder().decode(result.body)).toBe("ok");
  });

  it("refuses a redirect to another host without requesting it, and records no failure", async () => {
    const { http, gated, health } = policed("probe");
    http.mockResolvedValue(redirect("https://evil.example/a.xml"));
    await expect(gated(HOST_URL)).rejects.toBeInstanceOf(FetchRefusedError);
    expect(http).toHaveBeenCalledTimes(1);
    expect(health.recordFailure).not.toHaveBeenCalled();
    expect(health.recordSuccess).not.toHaveBeenCalled();
    expect(health.releaseProbe).toHaveBeenCalledWith("nbp");
  });

  it("refuses a redirect down to http", async () => {
    const { http, gated } = policed();
    http.mockResolvedValue(redirect("http://static.nbp.pl/a.xml"));
    await expect(gated(HOST_URL)).rejects.toMatchObject({ reason: "scheme" });
  });

  it("stops a redirect loop after the hop limit", async () => {
    const { http, gated } = policed();
    http.mockImplementation(async () => redirect(HOST_URL));
    await expect(gated(HOST_URL)).rejects.toMatchObject({
      reason: "redirects",
    });
    expect(http).toHaveBeenCalledTimes(FETCH_MAX_REDIRECTS + 1);
  });

  it("refuses an oversized body and records no success", async () => {
    const { http, gated, health } = policed();
    http.mockResolvedValue(
      new Response(new Uint8Array(SERIES_MAX_BODY_BYTES + 1), { status: 200 }),
    );
    await expect(gated(HOST_URL)).rejects.toBeInstanceOf(
      SeriesBodyTooLargeError,
    );
    expect(health.recordSuccess).not.toHaveBeenCalled();
    expect(health.recordFailure).toHaveBeenCalled();
  });

  it("aborts a call that outlives the 30 s timeout", async () => {
    const { http, gated, health } = policed();
    const controller = new AbortController();
    const timeout = jest
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(controller.signal);
    http.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) =>
          init.signal?.addEventListener("abort", () =>
            reject(init.signal?.reason),
          ),
        ),
    );
    const pending = gated(HOST_URL);
    controller.abort(new DOMException("timed out", "TimeoutError"));
    await expect(pending).rejects.toMatchObject({ name: "TimeoutError" });
    expect(timeout).toHaveBeenCalledWith(30_000);
    expect(health.recordFailure).toHaveBeenCalled();
    timeout.mockRestore();
  });
});
