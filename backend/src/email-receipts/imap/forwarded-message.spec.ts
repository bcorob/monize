import {
  detectForwardedOriginal,
  MAX_SCANNED_LINES,
  parseForwardedDate,
} from "./forwarded-message";

const lines = (...rows: string[]): string => rows.join("\n");

/** UTC calendar date and time of a parsed header, for readable expectations. */
const iso = (date: Date | null): string | null =>
  date === null ? null : date.toISOString().slice(0, 16);

describe("detectForwardedOriginal: Gmail", () => {
  it("reads an English Gmail forward", () => {
    const text = lines(
      "Please see below.",
      "",
      "---------- Forwarded message ---------",
      "From: Example Shop <orders@shop.example.com>",
      "Date: Mon, Aug 31, 2026 at 10:15 AM",
      "Subject: Order #A-1001 confirmed",
      "To: <alice.example@example.com>",
      "",
      "Order total: 49.99",
    );

    const found = detectForwardedOriginal(text);

    expect(found).toEqual({
      fromAddress: "orders@shop.example.com",
      fromName: "Example Shop",
      sentAt: new Date("2026-08-31T10:15:00.000Z"),
      subject: "Order #A-1001 confirmed",
      bodyStartLine: 8,
    });
  });

  it("joins a Subject that Gmail hard-wrapped at 76 columns onto an unindented line", () => {
    const text = lines(
      "---------- Forwarded message ---------",
      "Od: Allegro <powiadomienia@allegro.pl>",
      "Date: niedz., 23 sie 2026 o 21:40",
      "Subject: Kupiłeś i zapłaciłeś: Szukacz Par Przewodów Kabli Sonda Tester",
      "MS6812R",
      "To: <alice.example@example.com>",
      "",
      "Twój zakup: opłacony",
    );

    expect(detectForwardedOriginal(text)).toMatchObject({
      fromAddress: "powiadomienia@allegro.pl",
      subject:
        "Kupiłeś i zapłaciłeś: Szukacz Par Przewodów Kabli Sonda Tester MS6812R",
      sentAt: new Date("2026-08-23T21:40:00.000Z"),
      bodyStartLine: 7,
    });
  });

  it("does not take the first body line for the rest of a short Subject", () => {
    const text = lines(
      "---------- Forwarded message ---------",
      "From: Example Shop <orders@shop.example.com>",
      "Date: Mon, Aug 31, 2026 at 10:15 AM",
      "To: <alice.example@example.com>",
      "Subject: Order #A-1001 confirmed",
      "Order total: 49.99",
    );

    expect(detectForwardedOriginal(text)).toMatchObject({
      subject: "Order #A-1001 confirmed",
      bodyStartLine: 5,
    });
  });

  it("reads a Polish Gmail forward with a Polish date", () => {
    const text = lines(
      "---------- Wiadomość przekazana dalej ---------",
      "Od: Sklep Przykład <zamowienia@sklep.example.pl>",
      "Data: pon., 31 sie 2026 o 10:15",
      "Temat: Potwierdzenie zamówienia 1001",
      "Do: <ala.przyklad@example.pl>",
      "",
      "Razem: 49,99 zł",
    );

    const found = detectForwardedOriginal(text);

    expect(found?.fromAddress).toBe("zamowienia@sklep.example.pl");
    expect(found?.fromName).toBe("Sklep Przykład");
    expect(iso(found?.sentAt ?? null)).toBe("2026-08-31T10:15");
    expect(found?.subject).toBe("Potwierdzenie zamówienia 1001");
    expect(found?.bodyStartLine).toBe(6);
  });

  it("reads Gmail's bold sender name and bold labels", () => {
    const text = lines(
      "---------- Forwarded message ---------",
      "From: *Example Shop* <orders@shop.example.com>",
      "Date: Tue, Sep 1, 2026 at 3:05 PM",
      "Subject: Receipt",
      "To: Alice Example <alice.example@example.com>",
    );

    const found = detectForwardedOriginal(text);

    expect(found?.fromAddress).toBe("orders@shop.example.com");
    expect(found?.fromName).toBe("Example Shop");
    expect(iso(found?.sentAt ?? null)).toBe("2026-09-01T15:05");
  });

  it("reads a Gmail forward whose sender is a bare address", () => {
    const text = lines(
      "---------- Forwarded message ---------",
      "From: orders@shop.example.com",
      "Date: Mon, Aug 31, 2026 at 10:15 AM",
      "Subject: Order",
    );

    const found = detectForwardedOriginal(text);

    expect(found?.fromAddress).toBe("orders@shop.example.com");
    expect(found?.fromName).toBeUndefined();
  });

  it("lower-cases the address and strips a mailto: prefix", () => {
    const text = lines(
      "---------- Forwarded message ---------",
      "From: Shop <mailto:Orders@Shop.Example.COM>",
      "Subject: Order",
    );

    expect(detectForwardedOriginal(text)?.fromAddress).toBe(
      "orders@shop.example.com",
    );
  });

  it("reads a bold-label Gmail line (*From:*)", () => {
    const text = lines(
      "---------- Forwarded message ---------",
      "*From:* Shop <orders@shop.example.com>",
      "*Date:* Mon, Aug 31, 2026 at 10:15 AM",
      "*Subject:* Order 7",
    );

    const found = detectForwardedOriginal(text);

    expect(found?.fromAddress).toBe("orders@shop.example.com");
    expect(found?.subject).toBe("Order 7");
    expect(iso(found?.sentAt ?? null)).toBe("2026-08-31T10:15");
  });
});

describe("detectForwardedOriginal: Outlook", () => {
  it("reads the Original Message marker form", () => {
    const text = lines(
      "FYI",
      "",
      "-----Original Message-----",
      "From: Example Shop [mailto:orders@shop.example.com]",
      "Sent: Monday, August 31, 2026 10:15 AM",
      "To: Alice Example",
      "Subject: Your order A-1001",
      "",
      "Total 49.99",
    );

    const found = detectForwardedOriginal(text);

    expect(found?.fromAddress).toBe("orders@shop.example.com");
    expect(iso(found?.sentAt ?? null)).toBe("2026-08-31T10:15");
    expect(found?.subject).toBe("Your order A-1001");
    expect(found?.bodyStartLine).toBe(8);
  });

  it("reads an Outlook block with no marker line (Polish labels)", () => {
    const text = lines(
      "Przekazuję.",
      "",
      "________________________________",
      "Od: Sklep Przykład <zamowienia@sklep.example.pl>",
      "Wysłano: poniedziałek, 31 sierpnia 2026 10:15",
      "Do: Ala Przykład",
      "Temat: Zamówienie 1001",
      "",
      "Suma 49,99",
    );

    const found = detectForwardedOriginal(text);

    expect(found?.fromAddress).toBe("zamowienia@sklep.example.pl");
    expect(iso(found?.sentAt ?? null)).toBe("2026-08-31T10:15");
    expect(found?.subject).toBe("Zamówienie 1001");
  });

  it("reads a Polish marker (Wiadomość oryginalna)", () => {
    const text = lines(
      "-----Wiadomość oryginalna-----",
      "Od: Sklep <zamowienia@sklep.example.pl>",
      "Wysłano: wtorek, 1 września 2026 08:00",
      "Temat: Zamówienie",
    );

    const found = detectForwardedOriginal(text);

    expect(found?.fromAddress).toBe("zamowienia@sklep.example.pl");
    expect(iso(found?.sentAt ?? null)).toBe("2026-09-01T08:00");
  });

  it("does not take a lone From: line with no date for a forward", () => {
    const text = lines(
      "From: Alice Example <alice.example@example.com>",
      "Thanks for your help.",
    );

    expect(detectForwardedOriginal(text)).toBeNull();
  });

  it("does not take a From and Date with no recipient or subject for a forward", () => {
    const text = lines(
      "From: Alice Example <alice.example@example.com>",
      "Date: Mon, Aug 31, 2026 at 10:15 AM",
      "",
      "Hello",
    );

    expect(detectForwardedOriginal(text)).toBeNull();
  });
});

describe("detectForwardedOriginal: Apple Mail and Thunderbird", () => {
  it("reads Apple Mail's Begin forwarded message", () => {
    const text = lines(
      "Sent from my phone",
      "",
      "Begin forwarded message:",
      "",
      "From: Example Shop <orders@shop.example.com>",
      "Subject: Order A-1001",
      "Date: 31 August 2026 at 10:15:00 CEST",
      "To: Alice Example <alice.example@example.com>",
      "",
      "Total 49.99",
    );

    const found = detectForwardedOriginal(text);

    expect(found?.fromAddress).toBe("orders@shop.example.com");
    expect(found?.subject).toBe("Order A-1001");
    // 10:15 CEST is 08:15 UTC.
    expect(iso(found?.sentAt ?? null)).toBe("2026-08-31T08:15");
    expect(found?.bodyStartLine).toBe(9);
  });

  it("reads Thunderbird's Forwarded Message form", () => {
    const text = lines(
      "-------- Forwarded Message --------",
      "Subject: Order A-1001",
      "Date: Mon, 31 Aug 2026 10:15:00 +0200",
      "From: Example Shop <orders@shop.example.com>",
      "To: Alice Example <alice.example@example.com>",
      "",
      "Total 49.99",
    );

    const found = detectForwardedOriginal(text);

    expect(found?.fromAddress).toBe("orders@shop.example.com");
    expect(found?.subject).toBe("Order A-1001");
    expect(iso(found?.sentAt ?? null)).toBe("2026-08-31T08:15");
  });

  it("reads Thunderbird's Polish marker", () => {
    const text = lines(
      "-------- Przekazana wiadomość --------",
      "Temat: Zamówienie 1001",
      "Data: Mon, 31 Aug 2026 10:15:00 +0200",
      "Od: Sklep <zamowienia@sklep.example.pl>",
      "Do: ala@example.pl",
    );

    const found = detectForwardedOriginal(text);

    expect(found?.fromAddress).toBe("zamowienia@sklep.example.pl");
    expect(found?.subject).toBe("Zamówienie 1001");
  });

  it("reads a German Gmail forward", () => {
    const text = lines(
      "---------- Weitergeleitete Nachricht ---------",
      "Von: Beispiel Shop <bestellung@shop.example.de>",
      "Datum: Mo., 31. Aug. 2026 um 10:15",
      "Betreff: Ihre Bestellung 1001",
      "An: <anna@example.de>",
    );

    const found = detectForwardedOriginal(text);

    expect(found?.fromAddress).toBe("bestellung@shop.example.de");
    expect(found?.subject).toBe("Ihre Bestellung 1001");
    expect(iso(found?.sentAt ?? null)).toBe("2026-08-31T10:15");
  });
});

describe("detectForwardedOriginal: edges", () => {
  it("returns null for text with no forwarded block", () => {
    expect(
      detectForwardedOriginal("Order total: 49.99\nThanks for shopping"),
    ).toBeNull();
  });

  it("returns null for empty text", () => {
    expect(detectForwardedOriginal("")).toBeNull();
  });

  it("returns null for a marker whose block names no readable address", () => {
    const text = lines(
      "---------- Forwarded message ---------",
      "From: Example Shop",
      "Date: Mon, Aug 31, 2026 at 10:15 AM",
    );

    expect(detectForwardedOriginal(text)).toBeNull();
  });

  it("returns null for a marker with no header lines after it", () => {
    expect(
      detectForwardedOriginal(
        lines("---------- Forwarded message ---------", "", "just prose"),
      ),
    ).toBeNull();
  });

  it("keeps the facts it found when the date is unreadable (null date)", () => {
    const text = lines(
      "---------- Forwarded message ---------",
      "From: Shop <orders@shop.example.com>",
      "Date: sometime last week",
      "Subject: Order",
    );

    const found = detectForwardedOriginal(text);

    expect(found?.fromAddress).toBe("orders@shop.example.com");
    expect(found?.sentAt).toBeNull();
  });

  it("returns subject null when the block has none", () => {
    const text = lines(
      "---------- Forwarded message ---------",
      "From: Shop <orders@shop.example.com>",
      "Date: Mon, Aug 31, 2026 at 10:15 AM",
      "To: <a@example.com>",
    );

    expect(detectForwardedOriginal(text)?.subject).toBeNull();
  });

  it("returns sentAt null when the block has no date line", () => {
    const text = lines(
      "---------- Forwarded message ---------",
      "From: Shop <orders@shop.example.com>",
      "Subject: Order",
    );

    expect(detectForwardedOriginal(text)?.sentAt).toBeNull();
  });

  it("joins a wrapped header value onto its line", () => {
    const text = lines(
      "---------- Forwarded message ---------",
      "From: Shop <orders@shop.example.com>",
      "Subject: A very long subject that the mail client",
      "  wrapped onto a second line",
      "Date: Mon, Aug 31, 2026 at 10:15 AM",
    );

    expect(detectForwardedOriginal(text)?.subject).toBe(
      "A very long subject that the mail client wrapped onto a second line",
    );
  });

  it("reads a CRLF message", () => {
    const text = [
      "---------- Forwarded message ---------",
      "From: Shop <orders@shop.example.com>",
      "Date: Mon, Aug 31, 2026 at 10:15 AM",
      "Subject: Order",
    ].join("\r\n");

    expect(detectForwardedOriginal(text)?.fromAddress).toBe(
      "orders@shop.example.com",
    );
  });

  it("reads a quoted block (> prefixes)", () => {
    const text = lines(
      "> ---------- Forwarded message ---------",
      "> From: Shop <orders@shop.example.com>",
      "> Date: Mon, Aug 31, 2026 at 10:15 AM",
      "> Subject: Order",
    );

    expect(detectForwardedOriginal(text)?.fromAddress).toBe(
      "orders@shop.example.com",
    );
  });

  it("follows a forward of a forward to the innermost sender", () => {
    const text = lines(
      "---------- Forwarded message ---------",
      "From: Bob Example <bob.example@example.com>",
      "Date: Tue, Sep 1, 2026 at 9:00 AM",
      "Subject: Fwd: Order",
      "To: <alice.example@example.com>",
      "",
      "---------- Forwarded message ---------",
      "From: Shop <orders@shop.example.com>",
      "Date: Mon, Aug 31, 2026 at 10:15 AM",
      "Subject: Order",
    );

    const found = detectForwardedOriginal(text);

    expect(found?.fromAddress).toBe("orders@shop.example.com");
    expect(found?.subject).toBe("Order");
    expect(iso(found?.sentAt ?? null)).toBe("2026-08-31T10:15");
  });

  it("stops following nested forwards after three levels", () => {
    const block = (who: string) => [
      "---------- Forwarded message ---------",
      `From: ${who} <${who}@example.com>`,
      "Subject: s",
      "",
    ];
    const text = lines(
      ...block("one"),
      ...block("two"),
      ...block("three"),
      ...block("four"),
    );

    expect(detectForwardedOriginal(text)?.fromAddress).toBe(
      "three@example.com",
    );
  });

  it("scans only the first 200 lines", () => {
    const filler = Array.from({ length: MAX_SCANNED_LINES }, () => "filler");
    const text = lines(
      ...filler,
      "---------- Forwarded message ---------",
      "From: Shop <orders@shop.example.com>",
      "Subject: Order",
    );

    expect(detectForwardedOriginal(text)).toBeNull();
  });

  it("finds a block that starts on line 200", () => {
    const filler = Array.from(
      { length: MAX_SCANNED_LINES - 3 },
      () => "filler",
    );
    const text = lines(
      ...filler,
      "---------- Forwarded message ---------",
      "From: Shop <orders@shop.example.com>",
      "Subject: Order",
    );

    expect(detectForwardedOriginal(text)?.fromAddress).toBe(
      "orders@shop.example.com",
    );
  });

  it("is linear on a hostile text: a million characters and a long run of marker filler", () => {
    const hostile = `${"-".repeat(500)}${"- ".repeat(250_000)}`;
    const started = Date.now();

    expect(detectForwardedOriginal(hostile)).toBeNull();
    expect(
      detectForwardedOriginal(`${"From: ".repeat(100_000)}\n`.repeat(300)),
    ).toBeNull();
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("cuts a very long line before reading it", () => {
    const text = lines(
      "---------- Forwarded message ---------",
      `From: ${"x".repeat(5_000)} <orders@shop.example.com>`,
      "Subject: Order",
    );

    // The address sits past the cut, so the block names no readable sender.
    expect(detectForwardedOriginal(text)).toBeNull();
  });

  it("does not take an address with an illegal character", () => {
    const text = lines(
      "---------- Forwarded message ---------",
      "From: Shop <or ders@shop.example.com>",
      "Subject: Order",
    );

    expect(detectForwardedOriginal(text)).toBeNull();
  });

  it("returns null for a non-string input", () => {
    expect(detectForwardedOriginal(undefined as unknown as string)).toBeNull();
  });
});

describe("parseForwardedDate", () => {
  it.each([
    [
      "RFC 2822 with an offset",
      "Mon, 31 Aug 2026 10:15:00 +0200",
      "2026-08-31T08:15",
    ],
    ["RFC 2822 with GMT", "Mon, 31 Aug 2026 10:15:00 GMT", "2026-08-31T10:15"],
    [
      "RFC 2822 with a named zone",
      "Mon, 31 Aug 2026 10:15:00 CEST",
      "2026-08-31T08:15",
    ],
    [
      "RFC 2822 negative offset",
      "Mon, 31 Aug 2026 10:15:00 -0500",
      "2026-08-31T15:15",
    ],
    ["ISO date", "2026-08-31", "2026-08-31T00:00"],
    ["ISO date and time", "2026-08-31 10:15", "2026-08-31T10:15"],
    ["ISO with T and offset", "2026-08-31T10:15:00+02:00", "2026-08-31T08:15"],
    ["ISO with Z", "2026-08-31T10:15:00Z", "2026-08-31T10:15"],
    ["Gmail English AM", "Mon, Aug 31, 2026 at 10:15 AM", "2026-08-31T10:15"],
    ["Gmail English PM", "Mon, Aug 31, 2026 at 3:20 PM", "2026-08-31T15:20"],
    ["Gmail English noon", "Mon, Aug 31, 2026 at 12:00 PM", "2026-08-31T12:00"],
    [
      "Gmail English midnight",
      "Mon, Aug 31, 2026 at 12:30 AM",
      "2026-08-31T00:30",
    ],
    [
      "Gmail English narrow no-break space",
      "Mon, Aug 31, 2026 at 10:15 AM",
      "2026-08-31T10:15",
    ],
    ["Gmail Polish", "pon., 31 sie 2026 o 10:15", "2026-08-31T10:15"],
    ["Gmail Polish ź", "śr., 30 paź 2026 o 08:00", "2026-10-30T08:00"],
    ["Outlook English", "Monday, August 31, 2026 10:15 AM", "2026-08-31T10:15"],
    [
      "Outlook English PM",
      "Monday, August 31, 2026 1:05 PM",
      "2026-08-31T13:05",
    ],
    [
      "Outlook Polish genitive",
      "poniedziałek, 31 sierpnia 2026 10:15",
      "2026-08-31T10:15",
    ],
    [
      "Polish genitive with diacritics",
      "piątek, 30 października 2026 18:45",
      "2026-10-30T18:45",
    ],
    [
      "Polish June (czerwca)",
      "wtorek, 2 czerwca 2026 09:00",
      "2026-06-02T09:00",
    ],
    ["Polish nominative", "31 sierpień 2026 10:15", "2026-08-31T10:15"],
    ["Apple Mail", "31 August 2026 at 10:15:00 CEST", "2026-08-31T08:15"],
    [
      "Apple Mail GMT offset",
      "August 31, 2026 at 10:15:00 AM GMT+2",
      "2026-08-31T08:15",
    ],
    ["German", "Mo., 31. Aug. 2026 um 10:15", "2026-08-31T10:15"],
    ["German March", "Montag, 2. März 2026 08:00", "2026-03-02T08:00"],
    ["French", "lundi 31 août 2026 à 10:15", "2026-08-31T10:15"],
    ["Spanish", "lun, 31 ago 2026 a las 10:15", "2026-08-31T10:15"],
    ["numeric dotted", "31.08.2026 10:15", "2026-08-31T10:15"],
    ["numeric dotted without time", "31.08.2026", "2026-08-31T00:00"],
    ["numeric slashed day over 12", "31/08/2026", "2026-08-31T00:00"],
  ])("reads %s", (_name, input, expected) => {
    expect(iso(parseForwardedDate(input))).toBe(expected);
  });

  it.each([
    ["empty", ""],
    ["blank", "   "],
    ["prose", "sometime last week"],
    ["a month with no day", "Aug 2026"],
    ["a month with no year", "Mon, Aug 31 at 10:15 AM"],
    ["31 February", "Mon, Feb 31, 2026 at 10:15 AM"],
    ["hour 25", "Mon, Aug 31, 2026 at 25:15"],
    ["13 PM", "Mon, Aug 31, 2026 at 13:15 PM"],
    ["a year far away", "Mon, Aug 31, 1850 at 10:15 AM"],
    ["an ambiguous slashed date", "05/06/2026"],
    ["an order number", "Order 123456"],
    ["an engine-friendly nonsense the legacy parser would accept", "Sunday 7"],
  ])("returns null for %s", (_name, input) => {
    expect(parseForwardedDate(input)).toBeNull();
  });

  it("reads a slashed date whose day and month are equal (there is no ambiguity)", () => {
    expect(iso(parseForwardedDate("05/05/2026"))).toBe("2026-05-05T00:00");
  });

  it("never reads more than the first 120 characters", () => {
    const padded = `${"x".repeat(200)} Mon, Aug 31, 2026 at 10:15 AM`;

    expect(parseForwardedDate(padded)).toBeNull();
  });
});
