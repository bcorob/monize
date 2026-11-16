import { bondInstrumentId } from "../bonds/bond-instrument-id";
import {
  BackupBondSeriesIdentity,
  BackupData,
  parseBondCatalogIdentity,
} from "./backup-format";
import {
  applyBondSeriesIds,
  referencedBondSeries,
  seriesKey,
} from "./restore-bond-series";

const EDO = bondInstrumentId("PL", "PL_MF", "EDO1036");
const TOS = bondInstrumentId("PL", "PL_MF", "TOS1029");

const identity = (
  seriesCode: string,
  id = bondInstrumentId("PL", "PL_MF", seriesCode),
): BackupBondSeriesIdentity => ({
  bondInstrumentId: id,
  issuerCountryCode: "PL",
  issuerCode: "PL_MF",
  programCode: seriesCode.slice(0, 3),
  seriesCode,
});

const file = (
  rows: Array<Record<string, unknown>>,
  series?: unknown,
): BackupData =>
  ({
    version: 1,
    exportedAt: "x",
    investment_transactions: rows,
    ...(series === undefined ? {} : { bondCatalog: { series } }),
  }) as unknown as BackupData;

describe("parseBondCatalogIdentity", () => {
  it("reads well-formed entries and normalises the codes", () => {
    expect(
      parseBondCatalogIdentity({
        series: [
          {
            ...identity("EDO1036"),
            seriesCode: "edo1036",
            issuerCountryCode: "pl",
          },
        ],
      }),
    ).toEqual([identity("EDO1036", EDO)]);
  });

  it.each([
    ["no member", undefined],
    ["a scalar", 7],
    ["no series list", {}],
    ["a series object", { series: {} }],
  ])("reads %s as no identities", (_name, value) => {
    expect(parseBondCatalogIdentity(value)).toEqual([]);
  });

  it("drops an entry that is not five well-formed strings", () => {
    const good = identity("EDO1036");
    expect(
      parseBondCatalogIdentity({
        series: [
          null,
          "x",
          { ...good, seriesCode: 5 },
          { ...good, seriesCode: "EDO1036; DROP TABLE" },
          { ...good, issuerCountryCode: "POL" },
          { ...good, issuerCode: "" },
          { ...good, programCode: "x".repeat(41) },
          { ...good, terms: { rate: 1 } },
        ],
      }),
    ).toEqual([good]);
  });
});

describe("referencedBondSeries", () => {
  it("returns one identity per series a row names", () => {
    const wanted = referencedBondSeries(
      file(
        [
          { id: "1", bond_instrument_id: EDO },
          { id: "2", bond_instrument_id: EDO },
          { id: "3", bond_instrument_id: null },
        ],
        [identity("EDO1036"), identity("EDO1036"), identity("TOS1029")],
      ),
    );
    expect(wanted.map((w) => w.seriesCode)).toEqual(["EDO1036"]);
  });

  it("is empty for a file without the member (a legacy backup)", () => {
    expect(referencedBondSeries(file([{ bond_instrument_id: EDO }]))).toEqual(
      [],
    );
  });

  it("is empty when no row names a series, however long the member is", () => {
    expect(
      referencedBondSeries(
        file([{ bond_instrument_id: null }], [identity("EDO1036")]),
      ),
    ).toEqual([]);
  });

  it("matches ids by their canonical spelling", () => {
    const wanted = referencedBondSeries(
      file([{ bond_instrument_id: EDO.toUpperCase() }], [identity("EDO1036")]),
    );
    expect(wanted).toHaveLength(1);
  });

  it("keys a series on country, issuer and upper-case code", () => {
    expect(seriesKey(identity("EDO1036"))).toBe("PL|PL_MF|EDO1036");
  });
});

describe("applyBondSeriesIds", () => {
  it("points each row at the target catalog's id, as a new document", () => {
    const target = "99999999-9999-5999-8999-999999999999";
    const input = file([
      { id: "1", bond_instrument_id: EDO },
      { id: "2", bond_instrument_id: TOS },
      { id: "3", bond_instrument_id: null },
    ]);
    const output = applyBondSeriesIds(input, new Map([[EDO, target]]));
    expect(
      output.investment_transactions.map((r) => r.bond_instrument_id),
    ).toEqual([target, TOS, null]);
    expect(input.investment_transactions[0].bond_instrument_id).toBe(EDO);
  });

  it("returns the document itself when there is nothing to map", () => {
    const input = file([{ bond_instrument_id: EDO }]);
    expect(applyBondSeriesIds(input, new Map())).toBe(input);
  });
});
