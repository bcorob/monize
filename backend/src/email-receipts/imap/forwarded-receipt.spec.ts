import {
  effectiveReceiptDate,
  normalizeOwnAddress,
  resolveForwardedIdentity,
  sameIdentity,
  type ReceiptIdentity,
} from "./forwarded-receipt";

const FORWARD = [
  "Please look at this order.",
  "",
  "---------- Forwarded message ---------",
  "From: Example Shop <Orders@Shop.Example.COM>",
  "Date: Mon, Aug 31, 2026 at 10:15 AM",
  "Subject: Order #A-1001 confirmed",
  "To: <alice.example@example.com>",
  "",
  "Order total: 49.99",
].join("\n");

const FORWARDER: ReceiptIdentity = {
  fromAddress: "alice.example@gmail.example.com",
  fromDomain: "gmail.example.com",
  subject: "Fwd: Order #A-1001 confirmed",
  forwardedBy: null,
  originalSentAt: null,
};
const RECEIVED = new Date("2026-10-01T09:00:00Z");
/** The owner's own addresses, as `loadOwnAddresses` returns them. */
const OWN: ReadonlySet<string> = new Set([
  "alice.example@gmail.example.com",
  "receipts@example.com",
]);

describe("resolveForwardedIdentity", () => {
  it("replaces the forwarder with the shop and keeps the forwarder as forwardedBy", () => {
    expect(resolveForwardedIdentity(FORWARDER, FORWARD, RECEIVED, OWN)).toEqual(
      {
        fromAddress: "orders@shop.example.com",
        fromDomain: "shop.example.com",
        subject: "Order #A-1001 confirmed",
        forwardedBy: "alice.example@gmail.example.com",
        originalSentAt: new Date("2026-08-31T10:15:00.000Z"),
      },
    );
  });

  it("is null for an email that is not a forward: nothing changes", () => {
    expect(
      resolveForwardedIdentity(FORWARDER, "Order total: 49.99", RECEIVED, OWN),
    ).toBeNull();
  });

  it("keeps the forwarder's own subject when the block has none", () => {
    const text = [
      "---------- Forwarded message ---------",
      "From: Shop <orders@shop.example.com>",
      "Date: Mon, Aug 31, 2026 at 10:15 AM",
    ].join("\n");

    expect(
      resolveForwardedIdentity(FORWARDER, text, RECEIVED, OWN)?.subject,
    ).toBe("Fwd: Order #A-1001 confirmed");
  });

  it("is idempotent: a healed row heals to itself and keeps the original forwarder", () => {
    const first = resolveForwardedIdentity(FORWARDER, FORWARD, RECEIVED, OWN);
    expect(first).not.toBeNull();
    const second = resolveForwardedIdentity(
      first as ReceiptIdentity,
      FORWARD,
      RECEIVED,
      OWN,
    );

    expect(second).toEqual(first);
    expect(
      sameIdentity(first as ReceiptIdentity, second as ReceiptIdentity),
    ).toBe(true);
    expect(second?.forwardedBy).toBe("alice.example@gmail.example.com");
  });

  it("drops an original date later than the day the forward arrived", () => {
    const text = [
      "---------- Forwarded message ---------",
      "From: Shop <orders@shop.example.com>",
      "Date: Mon, Dec 7, 2026 at 10:15 AM",
      "Subject: Order",
    ].join("\n");

    const resolved = resolveForwardedIdentity(FORWARDER, text, RECEIVED, OWN);

    expect(resolved?.fromAddress).toBe("orders@shop.example.com");
    expect(resolved?.originalSentAt).toBeNull();
  });

  it("keeps a date up to a day after the arrival (a clock a little ahead)", () => {
    const text = [
      "---------- Forwarded message ---------",
      "From: Shop <orders@shop.example.com>",
      "Date: Thu, Oct 1, 2026 at 11:00 PM",
      "Subject: Order",
    ].join("\n");

    expect(
      resolveForwardedIdentity(FORWARDER, text, RECEIVED, OWN)?.originalSentAt,
    ).toEqual(new Date("2026-10-01T23:00:00.000Z"));
  });

  it("bounds the stored values to their columns", () => {
    const text = [
      "---------- Forwarded message ---------",
      "From: Shop <orders@shop.example.com>",
      `Subject: ${"word ".repeat(300)}`,
    ].join("\n");

    const resolved = resolveForwardedIdentity(FORWARDER, text, RECEIVED, OWN);

    expect(resolved?.subject.length).toBeLessThanOrEqual(500);
    expect(resolved?.subject).not.toMatch(/\s{2}/);
  });
});

describe("resolveForwardedIdentity: only the owner's forward is re-identified (A26-H02)", () => {
  const OUTSIDER: ReceiptIdentity = {
    fromAddress: "someone@evil.example",
    fromDomain: "evil.example",
    subject: "Fwd: Order #A-1001 confirmed",
    forwardedBy: null,
    originalSentAt: null,
  };

  it("is null for anyone else's pasted block: the email stays the outer sender's", () => {
    expect(
      resolveForwardedIdentity(OUTSIDER, FORWARD, RECEIVED, OWN),
    ).toBeNull();
  });

  it("is null when the owner has no address at all", () => {
    expect(
      resolveForwardedIdentity(FORWARDER, FORWARD, RECEIVED, new Set()),
    ).toBeNull();
  });

  it("compares the outer sender without regard to case or spaces", () => {
    const shouting = {
      ...FORWARDER,
      fromAddress: " Alice.Example@GMAIL.example.com ",
    };
    expect(
      resolveForwardedIdentity(shouting, FORWARD, RECEIVED, OWN)?.fromAddress,
    ).toBe("orders@shop.example.com");
  });

  it("puts a row another sender's block re-identified back under that sender", () => {
    const forged: ReceiptIdentity = {
      fromAddress: "orders@shop.example.com",
      fromDomain: "shop.example.com",
      subject: "Order #A-1001 confirmed",
      forwardedBy: "Someone@Evil.example",
      originalSentAt: new Date("2026-08-31T10:15:00.000Z"),
    };

    const restored = resolveForwardedIdentity(forged, FORWARD, RECEIVED, OWN);

    expect(restored).toEqual({
      fromAddress: "Someone@Evil.example",
      fromDomain: "evil.example",
      subject: "Order #A-1001 confirmed",
      forwardedBy: null,
      originalSentAt: null,
    });
    // and the restored row is left alone on the next pass
    expect(
      resolveForwardedIdentity(
        restored as ReceiptIdentity,
        FORWARD,
        RECEIVED,
        OWN,
      ),
    ).toBeNull();
  });

  it("keeps a healed owner's forward as it is", () => {
    const healed = resolveForwardedIdentity(FORWARDER, FORWARD, RECEIVED, OWN);
    expect(healed?.forwardedBy).toBe("alice.example@gmail.example.com");
    expect(
      resolveForwardedIdentity(
        healed as ReceiptIdentity,
        FORWARD,
        RECEIVED,
        OWN,
      ),
    ).toEqual(healed);
  });
});

describe("normalizeOwnAddress", () => {
  it("trims and lower-cases an address, and refuses what is no address", () => {
    expect(normalizeOwnAddress("  Alice@Example.COM ")).toBe(
      "alice@example.com",
    );
    expect(normalizeOwnAddress("alice")).toBeNull();
    expect(normalizeOwnAddress("")).toBeNull();
    expect(normalizeOwnAddress(null)).toBeNull();
    expect(normalizeOwnAddress(undefined)).toBeNull();
  });
});

describe("sameIdentity", () => {
  it("compares every identity column, dates by instant", () => {
    const a: ReceiptIdentity = {
      ...FORWARDER,
      originalSentAt: new Date("2026-08-31T10:15:00Z"),
    };

    expect(
      sameIdentity(a, {
        ...a,
        originalSentAt: new Date(a.originalSentAt as Date),
      }),
    ).toBe(true);
    expect(sameIdentity(a, { ...a, originalSentAt: null })).toBe(false);
    expect(sameIdentity(a, { ...a, subject: "x" })).toBe(false);
    expect(sameIdentity(a, { ...a, fromAddress: "x@y.example" })).toBe(false);
    expect(sameIdentity(a, { ...a, fromDomain: "y.example" })).toBe(false);
    expect(sameIdentity(a, { ...a, forwardedBy: "z@y.example" })).toBe(false);
  });
});

describe("effectiveReceiptDate", () => {
  const receivedAt = new Date("2026-10-01T09:00:00Z");

  it("is the shop's day when a forward carried it", () => {
    const originalSentAt = new Date("2026-08-31T10:15:00Z");
    expect(effectiveReceiptDate({ originalSentAt, receivedAt })).toBe(
      originalSentAt,
    );
  });

  it("is the arrival day otherwise", () => {
    expect(effectiveReceiptDate({ originalSentAt: null, receivedAt })).toBe(
      receivedAt,
    );
  });
});
