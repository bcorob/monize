import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BadRequestException } from "@nestjs/common";
import { EntityManager } from "typeorm";
import {
  clearForeignSeries,
  clearForeignSeriesOfUser,
  findSeriesOfProgram,
  infersSeriesFromDate,
  inferSeriesForDate,
  programOfSecurity,
  resolveImportedSeries,
  resolveTransactionSeries,
  restoredSeries,
  seriesCodeOf,
  seriesOnSaleSql,
  seriesRoleOf,
} from "./bond-series-resolver";

const USER = "user-1";
const SECURITY = "sec-1";
const PROGRAM = "33333333-3333-5333-8333-333333333333";
const EDO = "11111111-1111-5111-8111-111111111111";
const COI = "22222222-2222-5222-8222-222222222222";

interface World {
  /** The program of the security; null for an unlinked one. */
  program: string | null;
  /** Series of the program by id. */
  series: Record<string, string>;
  /** Ids the sale-window query finds. */
  onSale: string[];
}

function fakeManager(world: Partial<World> = {}) {
  const w: World = {
    program: PROGRAM,
    series: { [EDO]: "EDO1036", [COI]: "COI1030" },
    onSale: [EDO],
    ...world,
  };
  const query = jest.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes("s.bond_program_id AS id")) {
      return [{ id: w.program, program_code: w.program ? "EDO" : null }];
    }
    if (sql.includes("saleWindow")) return w.onSale.map((id) => ({ id }));
    if (sql.includes("id = $1::uuid AND bond_program_id")) {
      return String(params[0]) in w.series ? [{ id: params[0] }] : [];
    }
    if (sql.includes("UPPER(series_code) = UPPER($2)")) {
      const code = String(params[1]).toUpperCase();
      const id = Object.entries(w.series).find(([, c]) => c === code)?.[0];
      return id ? [{ id }] : [];
    }
    if (sql.includes("SELECT series_code")) {
      return [{ series_code: w.series[String(params[0])] }];
    }
    if (sql.includes("UPDATE investment_transactions")) return [];
    throw new Error(`unexpected query: ${sql}`);
  });
  return { manager: { query } as unknown as EntityManager, query };
}

const write = (over: Record<string, unknown> = {}) => ({
  securityId: SECURITY,
  action: "BUY",
  transactionDate: "2026-10-15",
  requested: true,
  ...over,
});

const message = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(BadRequestException);
    return (error as BadRequestException).message;
  }
  throw new Error("expected a refusal");
};

describe("seriesRoleOf", () => {
  it.each([
    ["BUY", false, "acquisition"],
    ["REINVEST", false, "acquisition"],
    ["REINVEST_INTEREST", false, "acquisition"],
    ["ADD_SHARES", false, "acquisition"],
    ["TRANSFER_IN", false, "acquisition"],
    ["SELL", false, "removal"],
    ["REDEEM", false, "removal"],
    ["REMOVE_SHARES", false, "removal"],
    ["TRANSFER_OUT", false, "removal"],
    // The in-leg of a pair adds nothing of its own.
    ["TRANSFER_IN", true, "removal"],
    ["DIVIDEND", false, "none"],
    ["INTEREST", false, "none"],
    ["SPLIT", false, "none"],
  ])("%s (paired %s) is %s", (action, paired, role) => {
    expect(seriesRoleOf(action, paired)).toBe(role);
  });
});

describe("resolveTransactionSeries", () => {
  describe("an acquisition", () => {
    it("takes the series on sale on the date when none is named", async () => {
      const { manager, query } = fakeManager();
      await expect(
        resolveTransactionSeries(manager, USER, write()),
      ).resolves.toBe(EDO);
      const call = query.mock.calls.find(([sql]) => sql.includes("saleWindow"));
      expect(call?.[1]).toEqual([PROGRAM, "2026-10-15"]);
    });

    it("cuts a date-time to its date", async () => {
      const { manager, query } = fakeManager();
      await resolveTransactionSeries(
        manager,
        USER,
        write({ transactionDate: "2026-10-15T00:00:00.000Z" }),
      );
      expect(
        query.mock.calls.find(([sql]) => sql.includes("saleWindow"))?.[1],
      ).toEqual([PROGRAM, "2026-10-15"]);
    });

    it("accepts a series of the program that is named, in any spelling of the id", async () => {
      const { manager } = fakeManager({ onSale: [] });
      await expect(
        resolveTransactionSeries(
          manager,
          USER,
          write({ bondInstrumentId: COI.toUpperCase() }),
        ),
      ).resolves.toBe(COI);
    });

    it("refuses a series that is not of the program (SERIES_NOT_IN_PROGRAM)", async () => {
      const { manager } = fakeManager();
      const text = await message(
        resolveTransactionSeries(
          manager,
          USER,
          write({ bondInstrumentId: "99999999-9999-5999-8999-999999999999" }),
        ),
      );
      expect(text).toMatch(/does not belong to the bond program/);
      expect(text).toMatch(/EDO/);
    });

    it("refuses with the date and the program when no series was on sale (SERIES_NOT_DETERMINED)", async () => {
      const { manager } = fakeManager({ onSale: [] });
      const text = await message(
        resolveTransactionSeries(manager, USER, write()),
      );
      expect(text).toMatch(/2026-10-15/);
      expect(text).toMatch(/EDO/);
      expect(text).toMatch(/Fetch the series/);
    });

    it("does not choose between two series that were on sale", async () => {
      const { manager } = fakeManager({ onSale: [EDO, COI] });
      await message(resolveTransactionSeries(manager, USER, write()));
    });

    it("resolves a series by its code within the program, case-insensitively, or refuses it", async () => {
      const { manager } = fakeManager({ onSale: [] });
      await expect(
        resolveTransactionSeries(
          manager,
          USER,
          write({ bondSeriesReference: " coi1030 " }),
        ),
      ).resolves.toBe(COI);
      const text = await message(
        resolveTransactionSeries(
          manager,
          USER,
          write({ bondSeriesReference: "ROR1027" }),
        ),
      );
      expect(text).toMatch(/ROR1027/);
    });

    it("a reference given as an id is looked up as an id", async () => {
      const { manager } = fakeManager({ onSale: [] });
      await expect(
        resolveTransactionSeries(
          manager,
          USER,
          write({ bondSeriesReference: EDO }),
        ),
      ).resolves.toBe(EDO);
    });
  });

  describe("a removal", () => {
    it("names no series when none is given, and asks nothing about the date", async () => {
      const { manager, query } = fakeManager({ onSale: [] });
      await expect(
        resolveTransactionSeries(manager, USER, write({ action: "SELL" })),
      ).resolves.toBeNull();
      expect(query.mock.calls.some(([sql]) => sql.includes("saleWindow"))).toBe(
        false,
      );
    });

    it("checks a series that is given", async () => {
      const { manager } = fakeManager();
      await expect(
        resolveTransactionSeries(
          manager,
          USER,
          write({ action: "REDEEM", bondInstrumentId: EDO }),
        ),
      ).resolves.toBe(EDO);
      await message(
        resolveTransactionSeries(
          manager,
          USER,
          write({
            action: "SELL",
            bondInstrumentId: "99999999-9999-5999-8999-999999999999",
          }),
        ),
      );
    });

    it("treats the in-leg of a paired transfer like a removal (optional series)", async () => {
      const { manager } = fakeManager({ onSale: [] });
      await expect(
        resolveTransactionSeries(
          manager,
          USER,
          write({ action: "TRANSFER_IN", pairedTransfer: true }),
        ),
      ).resolves.toBeNull();
      await message(
        resolveTransactionSeries(
          manager,
          USER,
          write({ action: "TRANSFER_IN", pairedTransfer: false }),
        ),
      );
    });
  });

  describe("a security with no program, or an action that moves no shares", () => {
    it("never carries a series, and refuses one that is requested (SERIES_NOT_ALLOWED)", async () => {
      const { manager } = fakeManager({ program: null });
      await expect(
        resolveTransactionSeries(manager, USER, write()),
      ).resolves.toBeNull();
      await message(
        resolveTransactionSeries(
          manager,
          USER,
          write({ bondInstrumentId: EDO }),
        ),
      );
      await message(
        resolveTransactionSeries(
          manager,
          USER,
          write({ bondSeriesReference: "EDO1036" }),
        ),
      );
    });

    it("drops a stored series that the row can no longer carry, without refusing", async () => {
      const unlinked = fakeManager({ program: null });
      await expect(
        resolveTransactionSeries(
          unlinked.manager,
          USER,
          write({ bondInstrumentId: EDO, requested: false }),
        ),
      ).resolves.toBeNull();
      const cash = fakeManager();
      await expect(
        resolveTransactionSeries(
          cash.manager,
          USER,
          write({
            action: "DIVIDEND",
            bondInstrumentId: EDO,
            requested: false,
          }),
        ),
      ).resolves.toBeNull();
    });

    it("refuses a series on a cash action when it is requested", async () => {
      const { manager } = fakeManager();
      await message(
        resolveTransactionSeries(
          manager,
          USER,
          write({ action: "INTEREST", bondInstrumentId: EDO }),
        ),
      );
    });

    it("a write with no security carries none", async () => {
      const { manager, query } = fakeManager();
      await expect(
        resolveTransactionSeries(manager, USER, write({ securityId: null })),
      ).resolves.toBeNull();
      expect(query).not.toHaveBeenCalled();
    });
  });

  it("keeps a stored series of the program without a request, and replaces one the program no longer holds", async () => {
    const { manager } = fakeManager({ onSale: [COI] });
    await expect(
      resolveTransactionSeries(
        manager,
        USER,
        write({ bondInstrumentId: EDO, requested: false }),
      ),
    ).resolves.toBe(EDO);
    const relinked = fakeManager({
      series: { [COI]: "COI1030" },
      onSale: [COI],
    });
    await expect(
      resolveTransactionSeries(
        relinked.manager,
        USER,
        write({ bondInstrumentId: EDO, requested: false }),
      ),
    ).resolves.toBe(COI);
  });

  it("reads the security under the caller's ownership (user_id in the predicate)", async () => {
    const { manager, query } = fakeManager();
    await resolveTransactionSeries(manager, USER, write());
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/s\.user_id = \$2/);
    expect(params).toEqual([SECURITY, USER]);
  });
});

describe("seriesOnSaleSql", () => {
  it("reads the sale window of the NEWEST terms version of each series of the program", () => {
    const sql = seriesOnSaleSql("$1", "$2::text");
    expect(sql).toMatch(/ORDER BY v\.version DESC\s+LIMIT 1/);
    expect(sql).toMatch(/s\.bond_program_id = \$1::uuid/);
    expect(sql).toMatch(/'from'\) <= \$2::text/);
    expect(sql).toMatch(/'to'\) >= \$2::text/);
  });
});

describe("inferSeriesForDate", () => {
  it("is the one series on sale, null for none or several", async () => {
    await expect(
      inferSeriesForDate(
        fakeManager({ onSale: [EDO] }).manager,
        PROGRAM,
        "2026-10-15",
      ),
    ).resolves.toBe(EDO);
    await expect(
      inferSeriesForDate(
        fakeManager({ onSale: [] }).manager,
        PROGRAM,
        "2026-10-15",
      ),
    ).resolves.toBeNull();
    await expect(
      inferSeriesForDate(
        fakeManager({ onSale: [EDO, COI] }).manager,
        PROGRAM,
        "2026-10-15",
      ),
    ).resolves.toBeNull();
  });
});

describe("findSeriesOfProgram and seriesCodeOf", () => {
  it("finds by id or by code, and names a series", async () => {
    const { manager } = fakeManager();
    await expect(findSeriesOfProgram(manager, PROGRAM, EDO)).resolves.toBe(EDO);
    await expect(
      findSeriesOfProgram(manager, PROGRAM, "coi1030"),
    ).resolves.toBe(COI);
    await expect(
      findSeriesOfProgram(manager, PROGRAM, "NOPE"),
    ).resolves.toBeNull();
    await expect(seriesCodeOf(manager, EDO)).resolves.toBe("EDO1036");
    await expect(seriesCodeOf(manager, null)).resolves.toBeNull();
  });
});

describe("clearing the series a link change leaves behind (INV-BOND-007)", () => {
  it("nulls the rows of the security whose series is outside the new program", async () => {
    const { manager, query } = fakeManager();
    await clearForeignSeries(manager, USER, SECURITY, PROGRAM);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/UPDATE investment_transactions/);
    expect(sql).toMatch(/NOT EXISTS/);
    expect(params).toEqual([SECURITY, USER, PROGRAM]);
  });

  it("nulls every series of a security that was unlinked", async () => {
    const { manager, query } = fakeManager();
    await clearForeignSeries(manager, USER, SECURITY, null);
    expect(query.mock.calls[0][1]).toEqual([SECURITY, USER, null]);
  });

  it("after a restore, nulls the user's rows whose series is not of their own security's program", async () => {
    const { manager, query } = fakeManager();
    await clearForeignSeriesOfUser(manager, USER);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/t\.user_id = \$1/);
    expect(sql).toMatch(
      /JOIN bond_instruments i ON i\.bond_program_id = s\.bond_program_id/,
    );
    expect(params).toEqual([USER]);
  });
});

describe("an acquisition with no purchase date of its own (INV-BOND-007)", () => {
  it.each(["ADD_SHARES", "TRANSFER_IN"])(
    "%s must name its series (SERIES_REQUIRED), and is never inferred from its date",
    async (action) => {
      const { manager, query } = fakeManager({ onSale: [EDO] });
      await expect(
        resolveTransactionSeries(manager, USER, write({ action })),
      ).rejects.toMatchObject({ response: { errorCode: "SERIES_REQUIRED" } });
      // The date was never even asked about.
      expect(query.mock.calls.some(([sql]) => sql.includes("saleWindow"))).toBe(
        false,
      );
    },
  );

  it("accepts a series it names, and refuses one of another program", async () => {
    const { manager } = fakeManager();
    await expect(
      resolveTransactionSeries(
        manager,
        USER,
        write({ action: "ADD_SHARES", bondInstrumentId: COI }),
      ),
    ).resolves.toBe(COI);
    await expect(
      resolveTransactionSeries(
        manager,
        USER,
        write({
          action: "ADD_SHARES",
          bondInstrumentId: "99999999-9999-5999-8999-999999999999",
        }),
      ),
    ).rejects.toMatchObject({
      response: { errorCode: "SERIES_NOT_IN_PROGRAM" },
    });
  });

  it("an unpaired TRANSFER_IN is one of them; the in-leg of a pair names none", async () => {
    const { manager } = fakeManager();
    await expect(
      resolveTransactionSeries(
        manager,
        USER,
        write({ action: "TRANSFER_IN", pairedTransfer: true }),
      ),
    ).resolves.toBeNull();
  });

  it("only BUY and REINVEST (and their refinements) are inferred from the date", () => {
    expect(
      ["BUY", "REINVEST", "REINVEST_INTEREST"].every(infersSeriesFromDate),
    ).toBe(true);
    expect(
      ["ADD_SHARES", "TRANSFER_IN", "SELL", "DIVIDEND"].some(
        infersSeriesFromDate,
      ),
    ).toBe(false);
  });
});

describe("keepStored: an edit that changes nothing the series depends on", () => {
  it("returns the stored value as it is, NULL included, without a query, for every acquisition", async () => {
    const { manager, query } = fakeManager({ onSale: [] });
    for (const action of ["BUY", "ADD_SHARES", "TRANSFER_IN", "SELL"]) {
      await expect(
        resolveTransactionSeries(
          manager,
          USER,
          write({
            action,
            keepStored: true,
            requested: false,
            bondInstrumentId: null,
          }),
        ),
      ).resolves.toBeNull();
    }
    await expect(
      resolveTransactionSeries(
        manager,
        USER,
        write({
          keepStored: true,
          requested: false,
          // Not in the program any more: kept, neither refused nor re-resolved.
          bondInstrumentId: "99999999-9999-5999-8999-999999999999",
        }),
      ),
    ).resolves.toBe("99999999-9999-5999-8999-999999999999");
    expect(query).not.toHaveBeenCalled();
  });

  it("is not a way to name a series by code: a code is still a request", async () => {
    const { manager } = fakeManager();
    await expect(
      resolveTransactionSeries(
        manager,
        USER,
        write({
          keepStored: true,
          requested: false,
          bondSeriesReference: "coi1030",
        }),
      ),
    ).resolves.toBe(COI);
  });
});

describe("restoredSeries (undo and redo put the snapshot's series back exactly)", () => {
  it("returns the snapshot's series when the security's program holds it, and never infers", async () => {
    const query = jest.fn(async (..._args: unknown[]) => [{ "?column?": 1 }]);
    const manager = { query } as unknown as EntityManager;
    await expect(restoredSeries(manager, USER, SECURITY, EDO)).resolves.toBe(
      EDO,
    );
    expect(query.mock.calls[0][1]).toEqual([SECURITY, USER, EDO]);
    expect(String(query.mock.calls[0][0])).not.toContain("saleWindow");
  });

  it("stores NULL for a series outside the program, an unlinked security, a missing series or a value that is not an id", async () => {
    const none = { query: jest.fn(async () => []) } as unknown as EntityManager;
    await expect(restoredSeries(none, USER, SECURITY, EDO)).resolves.toBeNull();
    for (const [security, series] of [
      [null, EDO],
      [SECURITY, null],
      [SECURITY, undefined],
      [SECURITY, "EDO1036; DROP TABLE"],
      [SECURITY, 7],
    ] as const) {
      const query = jest.fn(async () => [{ "?column?": 1 }]);
      await expect(
        restoredSeries(
          { query } as unknown as EntityManager,
          USER,
          security,
          series,
        ),
      ).resolves.toBeNull();
      expect(query).not.toHaveBeenCalled();
    }
  });
});

describe("resolveImportedSeries (a file names no series)", () => {
  const row = (over: Record<string, unknown> = {}) => ({
    securityId: SECURITY,
    action: "BUY",
    transactionDate: "2026-10-15",
    ...over,
  });

  it("takes the series on sale for a BUY or REINVEST, and reports none unresolved", async () => {
    const { manager } = fakeManager();
    await expect(
      resolveImportedSeries(manager, USER, row(), new Map()),
    ).resolves.toEqual({ id: EDO, unresolved: false });
  });

  it("stores NULL and reports the row when none was on sale, instead of refusing", async () => {
    const { manager } = fakeManager({ onSale: [] });
    await expect(
      resolveImportedSeries(manager, USER, row(), new Map()),
    ).resolves.toEqual({ id: null, unresolved: true });
  });

  it("never infers an ADD_SHARES or an unpaired TRANSFER_IN; a paired leg, a removal and a cash action are not unresolved", async () => {
    const { manager } = fakeManager();
    const cache = new Map();
    for (const action of ["ADD_SHARES", "TRANSFER_IN"]) {
      await expect(
        resolveImportedSeries(manager, USER, row({ action }), cache),
      ).resolves.toEqual({ id: null, unresolved: true });
    }
    for (const over of [
      { action: "TRANSFER_IN", pairedTransfer: true },
      { action: "SELL" },
      { action: "DIVIDEND" },
    ]) {
      await expect(
        resolveImportedSeries(manager, USER, row(over), cache),
      ).resolves.toEqual({ id: null, unresolved: false });
    }
  });

  it("an unlinked security, or a row with no security, is never unresolved", async () => {
    const { manager } = fakeManager({ program: null });
    await expect(
      resolveImportedSeries(manager, USER, row(), new Map()),
    ).resolves.toEqual({ id: null, unresolved: false });
    await expect(
      resolveImportedSeries(
        manager,
        USER,
        row({ securityId: null }),
        new Map(),
      ),
    ).resolves.toEqual({ id: null, unresolved: false });
  });

  it("looks the program up once per security however many rows follow", async () => {
    const { manager, query } = fakeManager();
    const cache = new Map();
    for (let i = 0; i < 5; i++) {
      await resolveImportedSeries(manager, USER, row(), cache);
    }
    expect(
      query.mock.calls.filter(([sql]) =>
        sql.includes("s.bond_program_id AS id"),
      ),
    ).toHaveLength(1);
  });
});

describe("programOfSecurity", () => {
  it("memoizes a security that is not linked as well as one that is", async () => {
    const { manager, query } = fakeManager({ program: null });
    const cache = new Map();
    await expect(
      programOfSecurity(manager, USER, SECURITY, cache),
    ).resolves.toBeNull();
    await programOfSecurity(manager, USER, SECURITY, cache);
    expect(query).toHaveBeenCalledTimes(1);
  });
});

describe("the UUID check (one definition)", () => {
  it("uses the shared UUID_REGEX, not a private pattern", () => {
    const source = readFileSync(
      join(__dirname, "bond-series-resolver.ts"),
      "utf8",
    );
    expect(source).toContain("UUID_REGEX");
    expect(source).not.toMatch(/UUID_PATTERN|\[0-9a-f\]\{8\}/);
  });
});
