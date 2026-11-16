import { readFileSync } from "fs";
import { join } from "path";
import { Logger } from "@nestjs/common";
import { GOOGLE_PLACES_CAP, resolveMonthlyCap } from "./google-places-cap";
import {
  GOOGLE_PLACES_ENV_SPECS,
  resolveOperatorGooglePlaces,
} from "./google-places.config";

const readerFor = (values: Record<string, unknown>) => ({
  get: <T>(key: string) => values[key] as T | undefined,
});

const makeLogger = () => {
  const logger = { log: jest.fn(), warn: jest.fn() };
  return logger as unknown as Logger & typeof logger;
};

describe("resolveOperatorGooglePlaces", () => {
  it("answers null when the deployment configured no key", () => {
    // The key is the whole switch: with none, each user's own row decides.
    expect(resolveOperatorGooglePlaces(readerFor({}))).toBeNull();
  });

  it("treats a blank or whitespace key as no key", () => {
    expect(
      resolveOperatorGooglePlaces(readerFor({ GOOGLE_PLACES_API_KEY: "   " })),
    ).toBeNull();
  });

  it("answers null when there is no reader at all", () => {
    expect(resolveOperatorGooglePlaces(undefined)).toBeNull();
  });

  it("uses the documented default cap when only a key is set", () => {
    expect(
      resolveOperatorGooglePlaces(readerFor({ GOOGLE_PLACES_API_KEY: "k" })),
    ).toEqual({ apiKey: "k", monthlyCap: GOOGLE_PLACES_CAP.default });
  });

  it("trims the key, because a trailing newline is what a mounted secret has", () => {
    expect(
      resolveOperatorGooglePlaces(readerFor({ GOOGLE_PLACES_API_KEY: "k\n" })),
    ).toMatchObject({ apiKey: "k" });
  });

  it("applies an operator override", () => {
    expect(
      resolveOperatorGooglePlaces(
        readerFor({
          GOOGLE_PLACES_API_KEY: "k",
          GOOGLE_PLACES_MONTHLY_CAP: "5000",
        }),
      ),
    ).toEqual({ apiKey: "k", monthlyCap: 5000 });
  });

  describe.each([
    ["a non-numeric string", "one thousand"],
    ["zero", "0"],
    ["a negative number", "-5"],
    ["a grouped number", "1,000"],
  ])("with %s as the cap", (_label, value) => {
    it("falls back to the default and says so", () => {
      // Absent is a choice; invalid is a mistake, and an operator who typed it
      // should learn from the log rather than from a bill.
      const logger = makeLogger();

      expect(
        resolveOperatorGooglePlaces(
          readerFor({
            GOOGLE_PLACES_API_KEY: "k",
            GOOGLE_PLACES_MONTHLY_CAP: value,
          }),
          logger,
        ),
      ).toEqual({ apiKey: "k", monthlyCap: GOOGLE_PLACES_CAP.default });
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("GOOGLE_PLACES_MONTHLY_CAP"),
      );
    });
  });

  it("does not warn when nothing was supplied", () => {
    const logger = makeLogger();

    resolveOperatorGooglePlaces(
      readerFor({ GOOGLE_PLACES_API_KEY: "k" }),
      logger,
    );

    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe("resolveMonthlyCap", () => {
  it("keeps a stored value inside the range", () => {
    expect(resolveMonthlyCap(250)).toBe(250);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a fraction", 10.5],
    ["below the minimum", 0],
    ["above the maximum", GOOGLE_PLACES_CAP.max + 1],
  ])("falls back to the default for %s", (_label, value) => {
    // Falls back rather than clamps: a value the database should never have
    // held is a fault, and clamping silently substitutes a limit nobody chose.
    expect(resolveMonthlyCap(value as number | null | undefined)).toBe(
      GOOGLE_PLACES_CAP.default,
    );
  });

  it("accepts both ends of the range", () => {
    expect(resolveMonthlyCap(GOOGLE_PLACES_CAP.min)).toBe(
      GOOGLE_PLACES_CAP.min,
    );
    expect(resolveMonthlyCap(GOOGLE_PLACES_CAP.max)).toBe(
      GOOGLE_PLACES_CAP.max,
    );
  });
});

describe(".env.example documents what the code reads", () => {
  const envExample = readFileSync(
    join(__dirname, "..", "..", "..", "..", "..", ".env.example"),
    "utf8",
  );

  it.each(Object.values(GOOGLE_PLACES_ENV_SPECS).map((spec) => spec.envVar))(
    "documents %s",
    (envVar) => {
      expect(envExample).toContain(envVar);
    },
  );

  it("documents no GOOGLE_PLACES_ variable the code does not read", () => {
    // The other direction: a documented knob nothing reads is a promise the
    // operator cannot cash.
    const documented = new Set(
      Array.from(envExample.matchAll(/^#?\s*(GOOGLE_PLACES_[A-Z_]+)=/gm)).map(
        (match) => match[1],
      ),
    );
    const read = new Set<string>(
      Object.values(GOOGLE_PLACES_ENV_SPECS).map((spec) => spec.envVar),
    );
    expect([...documented].filter((name) => !read.has(name))).toEqual([]);
    expect(documented.size).toBeGreaterThan(0);
  });

  it("documents the cap's current default beside it", () => {
    expect(envExample).toContain(
      `GOOGLE_PLACES_MONTHLY_CAP=${GOOGLE_PLACES_CAP.default}`,
    );
  });

  it("says why the default is not the widely quoted 10,000", () => {
    // The number is surprising, so the reason travels with it: this lookup's
    // field mask is billed at the Enterprise SKU, whose free tier is 1,000.
    expect(envExample).toMatch(/"Enterprise SKU"/);
  });
});

describe("the cap default", () => {
  it("is Google's free monthly allowance for the SKU this lookup uses", () => {
    // Pinned deliberately: raising it silently would hand every deployment a
    // bill the day after an upgrade.
    expect(GOOGLE_PLACES_CAP.default).toBe(1000);
  });
});
