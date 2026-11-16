import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Logger } from "@nestjs/common";
import { getRequestContext, getRequestTimezone } from "../request-context";
import {
  withPreserveTimestamps,
  withSystemContext,
  withUserContext,
} from "./with-context";

const VALID_UUID = "11111111-1111-4111-8111-111111111111";

describe("withUserContext", () => {
  it("seeds a user context and returns the callback value", () => {
    const seen = withUserContext(VALID_UUID, () => getRequestContext());
    expect(seen).toEqual({ userId: VALID_UUID });
  });

  it("seeds an optional timezone, visible via getRequestTimezone", () => {
    const seen = withUserContext(VALID_UUID, () => getRequestTimezone());
    expect(seen).toBeUndefined();
    const tz = withUserContext(
      VALID_UUID,
      () => getRequestTimezone(),
      "Australia/Brisbane",
    );
    expect(tz).toBe("Australia/Brisbane");
    // The key is omitted, not set to undefined.
    const ctx = withUserContext(VALID_UUID, () => getRequestContext());
    expect(ctx).not.toHaveProperty("timezone");
  });

  it("does not seed realUserId (withScopedDb defaults it to userId)", () => {
    const seen = withUserContext(VALID_UUID, () => getRequestContext());
    expect(seen?.realUserId).toBeUndefined();
    expect(seen?.system).toBeUndefined();
  });

  it("propagates async return values within the scope", async () => {
    await expect(
      withUserContext(VALID_UUID, async () => {
        return getRequestContext()?.userId;
      }),
    ).resolves.toBe(VALID_UUID);
  });

  it.each(["not-a-uuid", "", "12345", "11111111-1111-4111-8111"])(
    "throws on a non-UUID userId (%s)",
    (bad) => {
      expect(() => withUserContext(bad, () => 1)).toThrow(/valid UUID/);
    },
  );

  it("does not enter a scope when validation fails", () => {
    expect(getRequestContext()).toBeUndefined();
    try {
      withUserContext("bad", () => 1);
    } catch {
      // expected
    }
    expect(getRequestContext()).toBeUndefined();
  });
});

describe("withPreserveTimestamps", () => {
  it("extends an ambient user context, keeping its identity", () => {
    const seen = withUserContext(VALID_UUID, () =>
      withPreserveTimestamps(() => getRequestContext()),
    );
    expect(seen).toEqual({ userId: VALID_UUID, preserveTimestamps: true });
  });

  it("grants no identity of its own -- an empty ambient context stays empty", () => {
    // withScopedDb inside the callback must still throw its missing-context
    // error: preserving timestamps is a flag on the caller's identity, not a
    // context by itself.
    const seen = withPreserveTimestamps(() => getRequestContext());
    expect(seen).toEqual({ preserveTimestamps: true });
    expect(seen?.userId).toBeUndefined();
    expect(seen?.system).toBeUndefined();
  });

  it("does not leak the flag outside its scope", () => {
    withUserContext(VALID_UUID, () => {
      withPreserveTimestamps(() => getRequestContext());
      expect(getRequestContext()?.preserveTimestamps).toBeUndefined();
      return 1;
    });
  });

  it("propagates async return values within the scope", async () => {
    await expect(
      withUserContext(VALID_UUID, () =>
        withPreserveTimestamps(async () => {
          return getRequestContext()?.preserveTimestamps;
        }),
      ),
    ).resolves.toBe(true);
  });
});

describe("withSystemContext", () => {
  let logSpies: jest.SpyInstance[];

  beforeEach(() => {
    const proto = Logger.prototype;
    logSpies = [
      jest.spyOn(proto, "log").mockImplementation(() => {}),
      jest.spyOn(proto, "debug").mockImplementation(() => {}),
      jest.spyOn(proto, "verbose").mockImplementation(() => {}),
      jest.spyOn(proto, "warn").mockImplementation(() => {}),
      jest.spyOn(proto, "error").mockImplementation(() => {}),
    ];
  });

  afterEach(() => {
    logSpies.forEach((spy) => spy.mockRestore());
  });

  it("seeds a system context and returns the callback value", () => {
    const seen = withSystemContext(() => getRequestContext());
    expect(seen).toEqual({ system: true });
  });

  it("emits no log line, at any level", () => {
    // The bypass audit log used to print once per call site per minute. With
    // ~100 call sites, most of them on request and cron paths, that was the
    // bulk of a quiet backend log. Every level is spied, because moving the
    // line to `debug` would be the same flood: nothing in this app restricts
    // Nest's log levels, so `debug` prints too.
    const invoke = () => withSystemContext(() => undefined);
    invoke();
    invoke();
    for (const spy of logSpies) {
      expect(spy).not.toHaveBeenCalled();
    }
  });

  it("propagates async return values within the scope", async () => {
    await expect(
      withSystemContext(async () => getRequestContext()?.system),
    ).resolves.toBe(true);
  });
});

describe("with-context.ts source", () => {
  // A guard rather than only the behavioural test above: a logger reintroduced
  // behind a condition the unit test does not enter (an env flag, a mode check)
  // would leave that test green and the log back. The module has no reason to
  // log at all -- it seeds AsyncLocalStorage and returns.
  const SOURCE_PATH = join(__dirname, "with-context.ts");

  // Comments are blanked before matching so this file's own prose about the
  // removed logger cannot fail the scan it documents.
  function blankComments(source: string): string {
    return source
      .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, " "))
      .replace(
        /(^|[^:])\/\/[^\n]*/g,
        (match, prefix: string) =>
          prefix + " ".repeat(match.length - prefix.length),
      );
  }

  it("blanks comments while preserving line numbers", () => {
    const blanked = blankComments("const a = 1; // Logger\n/* Logger */\nb;");
    expect(blanked).not.toMatch(/Logger/);
    expect(blanked.split("\n")).toHaveLength(3);
    expect(blanked).toContain("const a = 1;");
  });

  it("leaves a Logger outside a comment visible to the scan", () => {
    expect(blankComments('const l = new Logger("X");')).toMatch(/Logger/);
  });

  it("instantiates no logger and captures no stack", () => {
    const code = blankComments(readFileSync(SOURCE_PATH, "utf8"));
    const offenders = code
      .split("\n")
      .map((text, index) => ({ line: index + 1, text: text.trim() }))
      .filter(({ text }) => /\bLogger\b|new Error\(\)\.stack/.test(text));
    expect(offenders).toEqual([]);
  });
});
