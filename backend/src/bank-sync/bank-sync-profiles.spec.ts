import { readdirSync, readFileSync } from "fs";
import { join, relative } from "path";
import { SUPPORTED_LOCALE_CODES } from "../i18n/config";
import {
  NO_BANK_OPERATION,
  operationTagLabel,
  type BankOperation,
} from "./bank-operation";
import {
  BankSyncProfileError,
  DEFAULT_PROFILE_ID,
  assertNoPersonalData,
  buildProfileSet,
  findOperationType,
  loadBankSyncProfiles,
  normalizeInstitutionName,
  profileNotesView,
  resolveConnectionProfile,
  resolveProfile,
  validateBankSyncProfile,
  type BankSyncProfile,
} from "./bank-sync-profiles";

const PROFILES_DIR = join(__dirname, "profiles");

const operation = (over: Partial<BankOperation> = {}): BankOperation => ({
  ...NO_BANK_OPERATION,
  ...over,
});

/** A small profile that passes every check; each refusal case breaks one thing in a copy. */
const valid = (): Record<string, any> => ({
  id: "pl/example-bank",
  version: 1,
  source: "enable_banking",
  institution: { country: "PL", names: ["Example Bank"] },
  operation: { location: ["remittance_line"] },
  types: [
    {
      key: "CARD-PAYMENT",
      match: { exact: "CARD-PAYMENT" },
      label: "cardPayment",
    },
    {
      match: { exact: "TRANSFER" },
      byDirection: { credit: "CARD-PAYMENT", debit: "CARD-PAYMENT" },
    },
  ],
});

const refusal = (raw: unknown): string => {
  try {
    validateBankSyncProfile(raw, "example.json");
  } catch (error) {
    expect(error).toBeInstanceOf(BankSyncProfileError);
    return (error as Error).message;
  }
  throw new Error("the profile was accepted");
};

describe("the built-in profile files", () => {
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? files(join(dir, entry.name))
        : entry.name.endsWith(".json")
          ? [relative(PROFILES_DIR, join(dir, entry.name))]
          : [],
    );

  it("are all loaded: a file under profiles/ that the loader does not list is a profile that never applies", () => {
    const { builtIn, defaultProfile } = loadBankSyncProfiles();
    const loadedIds = [defaultProfile, ...builtIn].map((p) => p.id).sort();
    const fileIds = files(PROFILES_DIR)
      .map((file) => file.replace(/\.json$/, ""))
      .sort();
    expect(fileIds).toEqual(loadedIds);
  });

  it("are read as they are in production: through the loader, from JSON modules the compiler copies into dist", () => {
    // `resolveJsonModule` is what makes `tsc` emit a JSON module that is
    // imported; without it the build compiles and the profiles are missing at
    // runtime.
    const tsconfig = readFileSync(
      join(__dirname, "../../tsconfig.json"),
      "utf8",
    );
    expect(tsconfig).toMatch(/^\s*"resolveJsonModule":\s*true/m);
    expect(loadBankSyncProfiles()).toBe(loadBankSyncProfiles());
  });

  it("carry no personal data and match the format (the loader refuses otherwise)", () => {
    for (const file of files(PROFILES_DIR)) {
      const raw = JSON.parse(readFileSync(join(PROFILES_DIR, file), "utf8"));
      expect(() => validateBankSyncProfile(raw, file)).not.toThrow();
    }
  });

  it("are checked when the module starts, so a broken one stops the boot", () => {
    // Importing the module would load the whole bank-sync graph for one line, so
    // the hook is read from its source.
    const source = readFileSync(join(__dirname, "bank-sync.module.ts"), "utf8");
    expect(source).toMatch(
      /onModuleInit\(\): void \{\s*loadBankSyncProfiles\(\);\s*\}/,
    );
  });
});

describe("the PKO BP profile", () => {
  const pko = resolveProfile("enable_banking", "PL", "PKO Bank Polski");

  it("is for PKO Bank Polski, the name Enable Banking lists it under, in Poland", () => {
    expect(pko.id).toBe("pl/pko-bp");
    expect(pko.source).toBe("enable_banking");
    expect(pko.institution).toEqual({
      country: "PL",
      names: ["PKO Bank Polski"],
    });
    expect(pko.operation.location).toEqual(["remittance_line"]);
  });

  it("tells the reader the three things verified about how this bank's API behaves, in English and Polish", () => {
    expect(pko.notes.map((n) => [n.id, n.severity])).toEqual([
      ["gluedFields", "warning"],
      ["operationCodeLine", "info"],
      ["counterpartyOnTransfers", "info"],
    ]);
    for (const note of pko.notes) {
      expect(Object.keys(note.text).sort()).toEqual(["en", "pl"]);
    }
    expect(pko.notes[0].text.en).toMatch(/^For card and BLIK payments/);
    expect(pko.notes[0].text.pl).toMatch(/^Przy płatnościach kartą i BLIK/);
    expect(Object.isFrozen(pko.notes)).toBe(true);
    expect(Object.isFrozen(pko.notes[0].text)).toBe(true);
    // Notes change what the reader is told, not what a row gets.
    expect(pko.version).toBe(1);
  });

  it("holds the operation-code table the code held, in the same order", () => {
    // The order is match order: an exact code before its prefix, the BLIK and
    // refund rules before the mobile payment family.
    expect(
      pko.types.map((type) =>
        "key" in type
          ? [type.key, type.label]
          : ["byDirection", type.byDirection],
      ),
    ).toEqual([
      ["CARD-PAYMENT", "cardPayment"],
      ["MOBILE-PAYMENT-RETURN", "mobilePaymentRefund"],
      ["MOBILE-PAYMENT-ATM", "cashWithdrawalBlik"],
      ["MOBILE-PAYMENT", "mobilePayment"],
      ["ATM", "cashWithdrawal"],
      ["TRANSFER-IN", "transferIn"],
      ["TRANSFER-OUT", "transferOut"],
      ["byDirection", { credit: "TRANSFER-IN", debit: "TRANSFER-OUT" }],
      ["STANDING-ORDER", "standingOrder"],
      ["CASHBACK", "cashback"],
      ["LOAN-PAYOFF", "loanRepayment"],
      ["CREDIT-CARD-AUTO-REPAYMENT", "creditCardRepayment"],
    ]);
  });

  it("matches the codes as the table did, down to the English fallbacks", () => {
    const tag = (code: string, direction: "credit" | "debit" | null = null) => {
      const found = findOperationType(pko, code, direction);
      return found && [found.key, found.catalogKey, found.fallback];
    };
    expect(tag("CARD-PAYMENT")).toEqual([
      "CARD-PAYMENT",
      "cardPayment",
      "Card payment",
    ]);
    expect(tag("MOBILE-PAYMENT-ATM-RETURN")?.[0]).toBe("MOBILE-PAYMENT-RETURN");
    expect(tag("MOBILE-PAYMENT-ATM-TX-CODE")?.[2]).toBe(
      "Cash withdrawal (BLIK)",
    );
    expect(tag("MOBILE-PAYMENT-X")?.[2]).toBe("Mobile payment");
    expect(tag("ATM-X")?.[2]).toBe("Cash withdrawal");
    expect(tag("TRANSFER", "credit")?.[0]).toBe("TRANSFER-IN");
    expect(tag("TRANSFER", "debit")?.[0]).toBe("TRANSFER-OUT");
    expect(tag("TRANSFER")).toBeNull();
    expect(tag("TRANSFER-IN", "debit")?.[0]).toBe("TRANSFER-IN");
    expect(tag("MOBILE-PAYMENT")).toBeNull();
    expect(tag("ATM")).toBeNull();
    expect(tag("DIRECT-DEBIT")).toBeNull();
  });
});

describe("the default profile", () => {
  const { defaultProfile } = loadBankSyncProfiles();

  it("is for no bank and looks for the operation in the transaction code before the remittance", () => {
    expect(defaultProfile.id).toBe(DEFAULT_PROFILE_ID);
    expect(defaultProfile.institution).toBeNull();
    expect(defaultProfile.operation.location).toEqual([
      "bank_transaction_code",
      "remittance_line",
    ]);
  });

  it("has no notes: nothing is known about a bank it was not written for", () => {
    expect(defaultProfile.notes).toEqual([]);
  });

  it("labels only the codes whose own text says what they are, never a prefix family", () => {
    expect(
      defaultProfile.types.map((type) => ("key" in type ? type.key : "")),
    ).toEqual(["TRANSFER-IN", "TRANSFER-OUT"]);
  });

  it("leaves every other code its own tag, as an unknown code always was", () => {
    for (const code of [
      "CARD-PAYMENT",
      "MOBILE-PAYMENT-POS",
      "ATM-WITHDRAWAL",
      "STANDING-ORDER",
      "CASHBACK",
    ]) {
      expect(
        operationTagLabel(operation({ remittanceCode: code }), defaultProfile),
      ).toEqual({ key: code, label: code });
    }
  });

  it("does not read a bare TRANSFER by the direction: that is one bank's convention", () => {
    expect(
      operationTagLabel(
        operation({ remittanceCode: "TRANSFER" }),
        defaultProfile,
        undefined,
        "credit",
      ),
    ).toEqual({ key: "TRANSFER", label: "TRANSFER" });
  });

  it("translates the codes it does know", () => {
    expect(
      operationTagLabel(
        operation({ code: "TRANSFER-OUT" }),
        defaultProfile,
        (key, fallback) => `pl(${key})|${fallback}`,
      ),
    ).toEqual({
      key: "TRANSFER-OUT",
      label: "pl(common.bankSync.operationTypes.transferOut)|Outgoing transfer",
    });
  });
});

describe("resolveProfile", () => {
  it.each([
    ["PKO Bank Polski", "PL"],
    ["pko bank polski", "PL"],
    ["PKO BANK POLSKI", "pl"],
    ["  PKO   Bank \t Polski  ", " PL "],
    ["PKO Bank Polski", "PL"],
  ])("takes %p in %p for PKO BP", (name, country) => {
    expect(resolveProfile("enable_banking", country, name).id).toBe(
      "pl/pko-bp",
    );
  });

  it.each([
    ["Some Other Bank", "PL"],
    ["PKO Bank Polski", "DE"],
    ["PKO", "PL"],
    ["PKO BP", "PL"],
    ["PKO Bank Polski S.A.", "PL"],
    ["PKO Bank Polskiego", "PL"],
    ["", "PL"],
  ])(
    "takes the default for %p in %p: a bank is never guessed from part of its name",
    (name, country) => {
      expect(resolveProfile("enable_banking", country, name).id).toBe(
        DEFAULT_PROFILE_ID,
      );
    },
  );

  it("takes the default for a provider no profile is written for", () => {
    expect(resolveProfile("another_provider", "PL", "PKO Bank Polski").id).toBe(
      DEFAULT_PROFILE_ID,
    );
  });

  it("names a bank the same way whatever the case, the spacing or the form of its accents", () => {
    expect(normalizeInstitutionName("  Bank  Zachodni  ")).toBe(
      "bank zachodni",
    );
    expect(normalizeInstitutionName("Kredyt Bank")).toBe("kredyt bank");
    expect(normalizeInstitutionName("Zażółć")).toBe(
      normalizeInstitutionName("Zażółć"),
    );
  });

  it("takes a bank's operation codes from its own profile, not another's", () => {
    const card = operation({ remittanceCode: "CARD-PAYMENT" });
    expect(
      operationTagLabel(
        card,
        resolveProfile("enable_banking", "PL", "PKO Bank Polski"),
      ),
    ).toEqual({ key: "CARD-PAYMENT", label: "Card payment" });
    expect(
      operationTagLabel(
        card,
        resolveProfile("enable_banking", "PL", "Some Other Bank"),
      ),
    ).toEqual({ key: "CARD-PAYMENT", label: "CARD-PAYMENT" });
  });
});

describe("resolveConnectionProfile", () => {
  it("chooses the profile resolveProfile chooses, from the connection's own columns", () => {
    expect(
      resolveConnectionProfile({
        provider: "enable_banking",
        institutionCountry: "PL",
        institutionName: "PKO Bank Polski",
      }),
    ).toBe(resolveProfile("enable_banking", "PL", "PKO Bank Polski"));
    expect(
      resolveConnectionProfile({
        provider: "enable_banking",
        institutionCountry: "PL",
        institutionName: "Another Bank",
      }).id,
    ).toBe(DEFAULT_PROFILE_ID);
  });
});

describe("profileNotesView", () => {
  const pko = resolveProfile("enable_banking", "PL", "PKO Bank Polski");
  const view = (lang: string) =>
    profileNotesView(pko, lang).map((n) => [n.id, n.lang]);

  it("gives a reader in Polish the Polish text, and says it is Polish", () => {
    const [glued] = profileNotesView(pko, "pl");
    expect(glued).toEqual({
      id: "gluedFields",
      severity: "warning",
      text: pko.notes[0].text.pl,
      lang: "pl",
    });
  });

  it("gives a reader in a language the note lacks the English text, and says it is English", () => {
    for (const lang of ["de", "zh-CN", "xx", "unknown"]) {
      expect(profileNotesView(pko, lang)).toEqual(
        pko.notes.map((n) => ({
          id: n.id,
          severity: n.severity,
          text: n.text.en,
          lang: "en",
        })),
      );
    }
  });

  it("reads a regional variant as the language it is a variant of, else English", () => {
    const note = (text: Record<string, string>) => ({
      notes: [{ id: "x", severity: "info" as const, text }],
    });
    expect(
      profileNotesView(note({ en: "Hello", "en-GB": "Hello, mate" }), "en-GB"),
    ).toEqual([
      { id: "x", severity: "info", text: "Hello, mate", lang: "en-GB" },
    ]);
    expect(profileNotesView(note({ en: "Hello" }), "en-GB")[0]).toMatchObject({
      text: "Hello",
      lang: "en",
    });
    // pt-BR is a full translation of its own, not a variant of pt: a note
    // written in pt is not assumed to read right for it.
    expect(
      profileNotesView(note({ en: "Hi", pt: "Olá" }), "pt-BR")[0],
    ).toMatchObject({ text: "Hi", lang: "en" });
  });

  it("keeps the order of the file", () => {
    expect(view("pl")).toEqual([
      ["gluedFields", "pl"],
      ["operationCodeLine", "pl"],
      ["counterpartyOnTransfers", "pl"],
    ]);
  });

  it("is empty for a profile without notes", () => {
    expect(
      profileNotesView(resolveProfile("enable_banking", "PL", "X"), "pl"),
    ).toEqual([]);
  });
});

describe("findOperationType", () => {
  it("skips a directed type whose target the profile does not hold, rather than naming one", () => {
    const broken = {
      ...resolveProfile("enable_banking", "PL", "PKO Bank Polski"),
      types: [
        {
          match: { exact: "TRANSFER" },
          byDirection: { credit: "MISSING", debit: "MISSING" },
        },
      ],
    } as BankSyncProfile;
    expect(findOperationType(broken, "TRANSFER", "credit")).toBeNull();
  });
});

describe("validateBankSyncProfile", () => {
  it("accepts a well-formed profile and returns it frozen", () => {
    const profile = validateBankSyncProfile(valid(), "example.json");
    expect(profile.id).toBe("pl/example-bank");
    expect(profile.version).toBe(1);
    expect(Object.isFrozen(profile)).toBe(true);
    expect(Object.isFrozen(profile.types)).toBe(true);
    expect(Object.isFrozen(profile.institution)).toBe(true);
  });

  describe("notes", () => {
    const note = (
      id: string = "gluedFields",
      severity: string = "info",
      text: Record<string, unknown> = { en: "Text" },
    ) => ({ id, severity, text });

    it("are optional: a profile without them has an empty, frozen list", () => {
      const profile = validateBankSyncProfile(valid(), "example.json");
      expect(profile.notes).toEqual([]);
      expect(Object.isFrozen(profile.notes)).toBe(true);
    });

    it("are accepted with either severity, in the order written, each frozen", () => {
      const raw = valid();
      raw.notes = [
        note("operationCodeLine", "info", { en: "One", pl: "Jeden" }),
        note("gluedFields", "warning"),
      ];
      const { notes } = validateBankSyncProfile(raw, "example.json");
      expect(notes).toEqual([
        {
          id: "operationCodeLine",
          severity: "info",
          text: { en: "One", pl: "Jeden" },
        },
        { id: "gluedFields", severity: "warning", text: { en: "Text" } },
      ]);
      expect(Object.isFrozen(notes)).toBe(true);
      expect(Object.isFrozen(notes[0])).toBe(true);
      expect(Object.isFrozen(notes[0].text)).toBe(true);
    });

    it("accept an empty list, and every supported language but the pseudo-locale", () => {
      const raw = valid();
      raw.notes = [];
      expect(validateBankSyncProfile(raw, "example.json").notes).toEqual([]);
      raw.notes = [
        note(
          "everyLanguage",
          "info",
          Object.fromEntries(
            SUPPORTED_LOCALE_CODES.filter((code) => code !== "xx").map(
              (code) => [code, `Text in ${code}`],
            ),
          ),
        ),
      ];
      expect(() => validateBankSyncProfile(raw, "example.json")).not.toThrow();
    });

    it("accept text of exactly 600 characters", () => {
      const raw = valid();
      raw.notes = [note("gluedFields", "info", { en: "a".repeat(600) })];
      expect(() => validateBankSyncProfile(raw, "example.json")).not.toThrow();
    });

    const cases: [string, (raw: Record<string, any>) => void, RegExp][] = [
      [
        "a severity the format does not have",
        (r) => (r.notes = [note("gluedFields", "error")]),
        /notes\[0\]\.severity: must be one of info, warning/,
      ],
      [
        "no severity",
        (r) => (r.notes = [{ id: "gluedFields", text: { en: "Text" } }]),
        /notes\[0\]\.severity: must be one of info, warning/,
      ],
      [
        "an id that is not camelCase",
        (r) => (r.notes = [note("glued Fields")]),
        /notes\[0\]\.id: must be a note id/,
      ],
      [
        "an id that is not text",
        (r) => (r.notes = [note(5 as never)]),
        /notes\[0\]\.id: must be a note id/,
      ],
      [
        "an id repeated",
        (r) =>
          (r.notes = [note("gluedFields"), note("gluedFields", "warning")]),
        /notes\[1\]\.id: repeats the id of an earlier note/,
      ],
      [
        "a field the format does not have",
        (r) => (r.notes = [{ ...note(), key: "gluedFields" }]),
        /notes\[0\]\.key: is not a field/,
      ],
      [
        "text with no English",
        (r) => (r.notes = [note("gluedFields", "info", { pl: "Tekst" })]),
        /notes\[0\]\.text\.en: is required/,
      ],
      [
        "no text",
        (r) => (r.notes = [{ id: "gluedFields", severity: "info" }]),
        /notes\[0\]\.text: must be an object/,
      ],
      [
        "text that is a string",
        (r) => (r.notes = [{ ...note(), text: "Text" }]),
        /notes\[0\]\.text: must be an object/,
      ],
      [
        "a language Monize is not translated into",
        (r) => (r.notes = [note("gluedFields", "info", { en: "a", tlh: "b" })]),
        /notes\[0\]\.text\.tlh: is not a language Monize is translated into/,
      ],
      [
        "the pseudo-locale",
        (r) => (r.notes = [note("gluedFields", "info", { en: "a", xx: "b" })]),
        /notes\[0\]\.text\.xx: is not a language Monize is translated into/,
      ],
      [
        "a language that is an inherited property",
        (r) =>
          (r.notes = [
            note(
              "gluedFields",
              "info",
              JSON.parse('{"en":"a","__proto__":"b"}'),
            ),
          ]),
        /notes\[0\]\.text\.__proto__: is not a language/,
      ],
      [
        "text that is not a string",
        (r) => (r.notes = [note("gluedFields", "info", { en: 5 })]),
        /notes\[0\]\.text\.en: must be non-empty text/,
      ],
      [
        "empty text",
        (r) => (r.notes = [note("gluedFields", "info", { en: "" })]),
        /notes\[0\]\.text\.en: must be non-empty text/,
      ],
      [
        "text of spaces",
        (r) => (r.notes = [note("gluedFields", "info", { en: "   " })]),
        /notes\[0\]\.text\.en: must be non-empty text/,
      ],
      [
        "text with space around it",
        (r) => (r.notes = [note("gluedFields", "info", { en: " Text" })]),
        /notes\[0\]\.text\.en: must be non-empty text/,
      ],
      [
        "an optional language that is empty",
        (r) => (r.notes = [note("gluedFields", "info", { en: "a", pl: "" })]),
        /notes\[0\]\.text\.pl: must be non-empty text/,
      ],
      [
        "text with a line break",
        (r) => (r.notes = [note("gluedFields", "info", { en: "One\nTwo" })]),
        /notes\[0\]\.text\.en: must be one line/,
      ],
      [
        "text with a carriage return",
        (r) => (r.notes = [note("gluedFields", "info", { en: "One\rTwo" })]),
        /notes\[0\]\.text\.en: must be one line/,
      ],
      [
        "text of 601 characters",
        (r) =>
          (r.notes = [note("gluedFields", "info", { en: "a".repeat(601) })]),
        /notes\[0\]\.text\.en: must be at most 600 characters/,
      ],
      [
        "more than 20 notes",
        (r) =>
          (r.notes = Array.from({ length: 21 }, (_v, i) => note(`note${i}`))),
        /notes: must be a list of at most 20 notes/,
      ],
      [
        "notes that are not a list",
        (r) => (r.notes = {}),
        /notes: must be a list/,
      ],
      [
        "a note that is not an object",
        (r) => (r.notes = ["gluedFields"]),
        /notes\[0\]: must be an object/,
      ],
    ];
    it.each(cases)("refuse %s", (_what, mutate, message) => {
      const raw = valid();
      mutate(raw);
      expect(refusal(raw)).toMatch(message);
    });

    it("accept exactly 20 notes", () => {
      const raw = valid();
      raw.notes = Array.from({ length: 20 }, (_v, i) => note(`note${i}`));
      expect(validateBankSyncProfile(raw, "example.json").notes).toHaveLength(
        20,
      );
    });

    it("are read by the personal-data check: a text that carries an account number is refused, naming where and never what", () => {
      const raw = valid();
      raw.notes = [
        note("gluedFields", "info", { en: "Pay to 1234 5678 9012 3456" }),
      ];
      const message = refusal(raw);
      expect(message).toContain("notes[0].text.en: looks like");
      expect(message).not.toContain("1234");
    });
  });

  it("accepts a prefix with a suffix, and the two operation locations in either order", () => {
    const raw = valid();
    raw.operation.location = ["bank_transaction_code", "remittance_line"];
    raw.types[0].match = { prefix: "MOBILE-PAYMENT-", suffix: "-RETURN" };
    expect(() => validateBankSyncProfile(raw, "example.json")).not.toThrow();
    raw.types[0].match = { suffix: "-RETURN" };
    expect(() => validateBankSyncProfile(raw, "example.json")).not.toThrow();
  });

  describe("personal data (invariant S2)", () => {
    const ACCOUNT = "PL61 1090 1014 0000 0712 1981 2874";

    it.each([
      ["an IBAN with spaces", ACCOUNT],
      ["an IBAN without spaces", "PL61109010140000071219812874"],
      ["a foreign IBAN", "DE89 3704 0044 0532 0130 00"],
      ["an IBAN-like string with no digit run long enough", "GB29NWBK6016ABCD"],
      ["an eight digit run", "12345678"],
      ["a longer digit run", "1234567890123456"],
      ["a card number in groups", "4111 1111 1111 1111"],
      ["a digit run split by hyphens", "1234-5678"],
      ["an amount with decimals", "12.34"],
      ["an amount with a decimal comma", "7,5"],
      ["an amount with a currency", "100 PLN"],
      ["an amount glued to a currency", "100PLN"],
      ["an e-mail address", "someone@example.com"],
    ])("refuses %s in an institution name", (_what, value) => {
      const raw = valid();
      raw.institution.names = [`Example ${value}`];
      expect(refusal(raw)).toContain("institution.names[0]");
    });

    it("refuses it in any string of the file, whatever the field", () => {
      for (const mutate of [
        (raw: Record<string, any>) => (raw.id = "pl/12345678"),
        (raw: Record<string, any>) => (raw.types[0].label = "x12345678"),
        (raw: Record<string, any>) => (raw.types[0].key = "CARD-12345678"),
        (raw: Record<string, any>) =>
          (raw.types[0].match.exact = "CARD-12345678"),
        (raw: Record<string, any>) => (raw.unknownField = "12345678"),
      ]) {
        const raw = valid();
        mutate(raw);
        expect(refusal(raw)).toMatch(
          /looks like a run of eight or more digits/,
        );
      }
    });

    it("says where and why, and never repeats the value it refused", () => {
      const raw = valid();
      raw.institution.names = [ACCOUNT];
      const message = refusal(raw);
      expect(message).toBe(
        "Bank sync profile example.json: institution.names[0]: looks like a run of eight or more digits; a shared profile holds operation codes and bank names only",
      );
      for (const part of ["1090", "0712", "2874", ACCOUNT]) {
        expect(message).not.toContain(part);
      }

      const iban = valid();
      iban.institution.names = ["Example PLxx"];
      iban.types[0].label = "GB29NWBK6016ABCD";
      expect(refusal(iban)).not.toContain("GB29NWBK6016ABCD");
      expect(refusal(iban)).toContain(
        "types[0].label: looks like an account number",
      );
    });

    it("looks inside arrays and nested objects, and ignores numbers and booleans", () => {
      expect(() =>
        assertNoPersonalData(
          { a: [{ b: ["fine", 123456789012, true, null] }] },
          "x",
        ),
      ).not.toThrow();
      expect(() =>
        assertNoPersonalData({ a: [{ b: ["fine", "12345678"] }] }, "x"),
      ).toThrow("a[0].b[1]");
    });

    it("leaves the codes and names a profile is made of alone", () => {
      for (const value of [
        "MOBILE-PAYMENT-POS-NO-CARD-TX-CODE",
        "CREDIT-CARD-AUTO-REPAYMENT",
        "PKO Bank Polski",
        "ING Bank Śląski",
        "A1-B2",
        "enable_banking",
        "pl/pko-bp",
        "cashWithdrawalBlik",
      ]) {
        expect(() => assertNoPersonalData({ value }, "x")).not.toThrow();
      }
    });

    it("is checked before the shape, so a file that is wrong in both is refused as personal data", () => {
      expect(refusal({ id: "12345678", extra: true })).toMatch(
        /looks like a run of eight or more digits/,
      );
    });
  });

  describe("shape", () => {
    const cases: [string, (raw: Record<string, any>) => void, RegExp][] = [
      [
        "an unknown top-level field",
        (r) => (r.extra = 1),
        /extra: is not a field/,
      ],
      ["a bad id", (r) => (r.id = "PKO"), /id: must be/],
      [
        "an id of another country",
        (r) => (r.id = "de/example-bank"),
        /id: must start with the institution's country/,
      ],
      [
        "a version of zero",
        (r) => (r.version = 0),
        /version: must be a whole number/,
      ],
      [
        "a fractional version",
        (r) => (r.version = 1.5),
        /version: must be a whole number/,
      ],
      [
        "a version that is text",
        (r) => (r.version = "1"),
        /version: must be a whole number/,
      ],
      [
        "an unknown source",
        (r) => (r.source = "csv"),
        /source: must be one of enable_banking/,
      ],
      [
        "no institution",
        (r) => delete r.institution,
        /institution: must be an object/,
      ],
      [
        "an unknown institution field",
        (r) => (r.institution.city = "x"),
        /institution.city: is not a field/,
      ],
      [
        "a lower-case country",
        (r) => (r.institution.country = "pl"),
        /institution.country: must be an upper-case/,
      ],
      [
        "no names",
        (r) => (r.institution.names = []),
        /institution.names: must list one to 20/,
      ],
      [
        "names that are not a list",
        (r) => (r.institution.names = "x"),
        /institution.names: must list one to 20/,
      ],
      [
        "too many names",
        (r) =>
          (r.institution.names = Array.from(
            { length: 21 },
            (_v, i) => `Bank ${String.fromCharCode(65 + i)}`,
          )),
        /institution.names: must list one to 20/,
      ],
      [
        "a name with markup",
        (r) => (r.institution.names = ["<b>Bank</b>"]),
        /institution.names\[0\]: must be plain text/,
      ],
      [
        "a name that is not text",
        (r) => (r.institution.names = [5]),
        /institution.names\[0\]: must be plain text/,
      ],
      [
        "a name that is too long",
        (r) => (r.institution.names = ["B".repeat(101)]),
        /at most 100 characters/,
      ],
      [
        "a name repeated in another case",
        (r) => (r.institution.names = ["Example Bank", "EXAMPLE  bank"]),
        /repeats another name/,
      ],
      [
        "no operation",
        (r) => delete r.operation,
        /operation: must be an object/,
      ],
      [
        "an unknown operation field",
        (r) => (r.operation.column = "x"),
        /operation.column: is not a field/,
      ],
      [
        "a location that is not a list",
        (r) => (r.operation.location = "remittance_line"),
        /operation.location: must list/,
      ],
      [
        "no location",
        (r) => (r.operation.location = []),
        /operation.location: must list/,
      ],
      [
        "an unknown location",
        (r) => (r.operation.location = ["column"]),
        /operation.location: must list/,
      ],
      [
        "a repeated location",
        (r) => (r.operation.location = ["remittance_line", "remittance_line"]),
        /operation.location: must list/,
      ],
      [
        "types that are not a list",
        (r) => (r.types = {}),
        /types: must be a list/,
      ],
      [
        "too many types",
        (r) => (r.types = Array.from({ length: 201 }, () => r.types[0])),
        /types: must be a list of at most 200/,
      ],
      [
        "a type that is not an object",
        (r) => (r.types[0] = "CARD"),
        /types\[0\]: must be an object/,
      ],
      [
        "an unknown type field",
        (r) => (r.types[0].payee = "x"),
        /types\[0\].payee: is not a field/,
      ],
      [
        "a type with no match",
        (r) => delete r.types[0].match,
        /types\[0\].match: must be an object/,
      ],
      [
        "an unknown match field",
        (r) => (r.types[0].match.regex = "x"),
        /types\[0\].match.regex: is not a field/,
      ],
      [
        "an empty match",
        (r) => (r.types[0].match = {}),
        /needs an exact code, a prefix or a suffix/,
      ],
      [
        "an exact code with a prefix",
        (r) => (r.types[0].match = { exact: "CARD-PAYMENT", prefix: "CARD-" }),
        /not both/,
      ],
      [
        "a lower-case exact code",
        (r) => (r.types[0].match = { exact: "card-payment" }),
        /match.exact: must be an upper-case code/,
      ],
      [
        "a prefix with no hyphen at the end",
        (r) => (r.types[0].match = { prefix: "ATM" }),
        /match.prefix: must be an upper-case code ending in a hyphen/,
      ],
      [
        "a suffix with no hyphen at the start",
        (r) => (r.types[0].match = { suffix: "RETURN" }),
        /match.suffix: must be an upper-case code starting with a hyphen/,
      ],
      [
        "a type with a label but no key",
        (r) => delete r.types[0].key,
        /types\[0\].key: must be an upper-case family name/,
      ],
      [
        "a type with no label",
        (r) => delete r.types[0].label,
        /types\[0\].label: must be a label key/,
      ],
      [
        "a label that is not a key",
        (r) => (r.types[0].label = "Card payment"),
        /types\[0\].label: must be a label key/,
      ],
      [
        "a label the catalogue does not have",
        (r) => (r.types[0].label = "unknownLabel"),
        /is not a key under common.bankSync.operationTypes/,
      ],
      [
        "a label that is an inherited property",
        (r) => (r.types[0].label = "constructor"),
        /is not a key under common.bankSync.operationTypes/,
      ],
      [
        "a key repeated",
        (r) => r.types.splice(1, 0, { ...r.types[0] }),
        /types\[1\].key: repeats the key/,
      ],
      [
        "a label together with byDirection",
        (r) => (r.types[1].label = "cardPayment"),
        /not both/,
      ],
      [
        "a byDirection missing a direction",
        (r) => delete r.types[1].byDirection.debit,
        /byDirection.debit: must be the key of a type/,
      ],
      [
        "a byDirection with an unknown direction",
        (r) => (r.types[1].byDirection.both = "CARD-PAYMENT"),
        /byDirection.both: is not a field/,
      ],
      [
        "a byDirection that is not an object",
        (r) => (r.types[1].byDirection = "x"),
        /byDirection: must be an object/,
      ],
      [
        "a byDirection naming no type",
        (r) => (r.types[1].byDirection.credit = "NOWHERE"),
        /byDirection.credit: names no type of this profile/,
      ],
    ];
    it.each(cases)("refuses %s", (what, mutate, message) => {
      const raw = valid();
      mutate(raw);
      expect(refusal(raw)).toMatch(message);
    });

    it("refuses what is not an object", () => {
      for (const raw of ["profile", null, [], 5]) {
        expect(refusal(raw)).toMatch(/profile: must be an object/);
      }
    });

    it("names the file in every refusal", () => {
      const raw = valid();
      raw.version = 0;
      expect(refusal(raw)).toMatch(/^Bank sync profile example\.json: /);
    });

    it("lets only the default profile name no bank, and it must name none", () => {
      const raw = valid();
      raw.id = "default";
      expect(refusal(raw)).toContain("institution: the default profile");
      delete raw.institution;
      expect(
        validateBankSyncProfile(raw, "default.json").institution,
      ).toBeNull();
    });
  });
});

describe("building the profile set", () => {
  const file = (raw: unknown, origin = "example.json") => ({ origin, raw });
  const standard = () => ({
    id: "default",
    version: 1,
    source: "enable_banking",
    operation: { location: ["bank_transaction_code"] },
    types: [],
  });

  it("indexes each built-in profile by every name it lists", () => {
    const raw = valid();
    raw.institution.names = ["Example Bank", "Example Bank Business"];
    const set = buildProfileSet(file(standard()), [file(raw)]);
    expect(set.builtIn.map((profile) => profile.id)).toEqual([
      "pl/example-bank",
    ]);
    expect(set.byInstitution.size).toBe(2);
  });

  it("refuses a built-in profile that is malformed, naming the file", () => {
    const raw = valid();
    raw.version = 0;
    expect(() =>
      buildProfileSet(file(standard()), [file(raw, "pl/example-bank.json")]),
    ).toThrow(
      "Bank sync profile pl/example-bank.json: version: must be a whole number from 1",
    );
  });

  it("refuses a default profile that is malformed or is not called default", () => {
    expect(() =>
      buildProfileSet(file({ ...standard(), version: 0 }, "default.json"), []),
    ).toThrow(/default\.json: version/);
    expect(() => buildProfileSet(file(valid(), "default.json"), [])).toThrow(
      /default\.json: id: must be default/,
    );
  });

  it("refuses a built-in profile that names no bank", () => {
    expect(() =>
      buildProfileSet(file(standard()), [file(standard(), "other.json")]),
    ).toThrow(/other\.json: id: default is the one profile that names no bank/);
  });

  it("refuses two profiles with one id", () => {
    expect(() =>
      buildProfileSet(file(standard()), [
        file(valid()),
        file(valid(), "b.json"),
      ]),
    ).toThrow(/b\.json: id: repeats the id of another profile/);
  });

  it("refuses two profiles for one bank, however the name is spaced or cased", () => {
    const other = valid();
    other.id = "pl/other-bank";
    other.institution.names = ["EXAMPLE   bank"];
    expect(() =>
      buildProfileSet(file(standard()), [file(valid()), file(other, "b.json")]),
    ).toThrow(
      /b\.json: institution\.names: names a bank another profile is for/,
    );
  });

  it("allows one name in two countries, and one bank for two providers' files", () => {
    const abroad = valid();
    abroad.id = "de/example-bank";
    abroad.institution.country = "DE";
    expect(() =>
      buildProfileSet(file(standard()), [
        file(valid()),
        file(abroad, "b.json"),
      ]),
    ).not.toThrow();
  });
});

describe("countryless SimpleFIN profiles", () => {
  const sourceDefault = () => ({
    id: "simplefin/default",
    version: 1,
    source: "simplefin",
    operation: { location: ["bank_transaction_code"] },
    types: [],
  });
  const bank = () => ({
    ...sourceDefault(),
    id: "simplefin/example-bank",
    institution: { names: ["Example Bank"] },
  });
  it("indexes normalized Bridge names without inventing a country", () => {
    const set = buildProfileSet(
      { origin: "default.json", raw: { ...sourceDefault(), id: "default" } },
      [
        { origin: "bank.json", raw: bank() },
        { origin: "simplefin/default.json", raw: sourceDefault() },
      ],
    );
    expect(set.byInstitution.get("simplefin||example bank")?.id).toBe(
      "simplefin/example-bank",
    );
    expect(normalizeInstitutionName("  EXAMPLE   Bank ")).toBe("example bank");
    expect(set.bySource.get("simplefin")?.id).toBe("simplefin/default");
  });
  it("uses the source default for unknown countryless banks and supplies API notes", () => {
    const profile = resolveProfile("simplefin", "", "Unknown Bank");
    expect(profile.id).toBe("simplefin/default");
    expect(profile.source).toBe("simplefin");
    expect(profile.types).toEqual([]);
    expect(profileNotesView(profile, "fr-CA")).toHaveLength(7);
    expect(
      profileNotesView(profile, "fr-CA").every((note) => note.lang === "fr-CA"),
    ).toBe(true);
    expect(
      profileNotesView(profile, "de").every((note) => note.lang === "en"),
    ).toBe(true);
    expect(() =>
      assertNoPersonalData(profile, "simplefin/default.json"),
    ).not.toThrow();
  });
  it("rejects a supplied country, country-prefix id, or institution on a source default", () => {
    expect(() =>
      validateBankSyncProfile(
        { ...bank(), institution: { names: ["Example Bank"], country: "US" } },
        "bank.json",
      ),
    ).toThrow(/must be omitted/);
    expect(() =>
      validateBankSyncProfile(
        { ...bank(), id: "us/example-bank" },
        "bank.json",
      ),
    ).toThrow(/must start/);
    expect(() =>
      validateBankSyncProfile(
        { ...sourceDefault(), institution: { names: ["Example Bank"] } },
        "bank.json",
      ),
    ).toThrow(/names none/);
    expect(() =>
      validateBankSyncProfile(
        { ...bank(), source: "enable_banking" },
        "bank.json",
      ),
    ).toThrow(/country/);
  });
});

describe("SimpleFIN regional profile notes", () => {
  const profile = resolveProfile("simplefin", "", "Example Bank");
  it.each(["en-US", "en-CA", "fr-CA", "es-ES", "fr", "es"])(
    "serves every note directly in %s",
    (lang) => {
      const notes = profileNotesView(profile, lang);
      expect(notes).toHaveLength(7);
      expect(notes.every((note) => note.lang === lang)).toBe(true);
      expect(notes.map((note) => note.id)).toContain("manualAccountLinking");
    },
  );
  it("removes the Polish SimpleFIN example and retains the English fallback", () => {
    expect(profile.notes.every((note) => note.text.pl === undefined)).toBe(
      true,
    );
    expect(
      profileNotesView(profile, "pl").every((note) => note.lang === "en"),
    ).toBe(true);
  });
  it.each([
    ["fr-CA", "fr"],
    ["es-ES", "es"],
  ])(
    "falls back from %s to %s when a profile omits the regional text",
    (regional, base) => {
      const raw = {
        id: "simplefin/example-bank",
        version: 1,
        source: "simplefin",
        institution: { names: ["Example Bank"] },
        operation: { location: ["bank_transaction_code"] },
        types: [],
        notes: [
          {
            id: "example",
            severity: "info",
            text: { en: "English note", [base]: "Translated note" },
          },
        ],
      };
      const checked = validateBankSyncProfile(raw, "example.json");
      expect(profileNotesView(checked, regional)[0]).toMatchObject({
        lang: base,
        text: "Translated note",
      });
    },
  );
  it("keeps note-only regional variants tied to supported base languages", () => {
    expect(SUPPORTED_LOCALE_CODES).toEqual(
      expect.arrayContaining(["fr", "es"]),
    );
    const note = profile.notes.find(
      (note) => note.id === "manualAccountLinking",
    )!;
    expect(note.text["en-US"]).toContain("checking account");
    expect(note.text["en-CA"]).toContain("chequing account");
  });
});
