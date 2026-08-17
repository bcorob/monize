import { fakeMnyDatabase } from "../__fixtures__/fake-mny-database";
import { readBillData } from "./read-bills";

const BILL_COLUMNS = [
  "hbill",
  "st",
  "frq",
  "cFrqInst",
  "dt",
  "lHtrn",
  "hbillHead",
  "iinst",
  "dtMax",
  "cInstMax",
];

describe("readBillData", () => {
  it("reads a bill row", () => {
    const db = fakeMnyDatabase({
      BILL: {
        columns: BILL_COLUMNS,
        rows: [
          {
            hbill: 12,
            st: 1,
            frq: 3,
            cFrqInst: 1,
            dt: new Date(Date.UTC(2011, 6, 1)),
            lHtrn: 940,
            hbillHead: 12,
            iinst: 4,
            dtMax: new Date(Date.UTC(2012, 0, 1)),
            cInstMax: 12,
          },
        ],
      },
    });

    const { bills, supported } = readBillData(db);

    expect(supported).toBe(true);
    expect(bills).toEqual([
      {
        handle: 12,
        status: 1,
        frequency: 3,
        occurrencesPerUnit: 1,
        nextDue: "2011-07-01",
        templateTransaction: 940,
        series: 12,
        instance: 4,
        endsOn: "2012-01-01",
        maxInstances: 12,
      },
    ]);
  });

  it("defaults an unbounded series rather than dropping the row", () => {
    const db = fakeMnyDatabase({
      BILL: { columns: BILL_COLUMNS, rows: [{ hbill: 1 }] },
    });

    expect(readBillData(db).bills[0]).toEqual({
      handle: 1,
      // -1 rather than 0: 0 is a real Money status and a real frequency (once).
      status: -1,
      frequency: -1,
      occurrencesPerUnit: 1,
      nextDue: null,
      templateTransaction: null,
      series: null,
      instance: 0,
      endsOn: null,
      maxInstances: 0,
    });
  });

  it("degrades when the Money version has no BILL table", () => {
    const { bills, supported, availability } = readBillData(
      fakeMnyDatabase({ TRN: { columns: ["htrn"] } }),
    );

    expect(supported).toBe(false);
    expect(bills).toEqual([]);
    expect(availability.present).toBe(false);
  });
});
