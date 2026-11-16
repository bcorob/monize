import { fakeMnyDatabase } from "../__fixtures__/fake-mny-database";
import { MnyValue } from "../msisam/open-mny";
import { readBillData } from "./read-bills";

const COLUMNS = ["htrn", "frq", "cFrqInst", "dt", "htrnSrc"];

function money99(rows: ReadonlyArray<Record<string, MnyValue>>) {
  return fakeMnyDatabase({ TRN: { columns: COLUMNS, rows } }, "jet3");
}

describe("readBillData on a Money 97-99 file", () => {
  it("turns each recurrence template that names its pending instance into a series", () => {
    const data = readBillData(
      money99([
        // The paying leg of a scheduled transfer, and its pending instance.
        {
          htrn: 1,
          frq: 3,
          cFrqInst: 1,
          dt: new Date("2026-11-27T00:00:00Z"),
          htrnSrc: 3,
        },
        {
          htrn: 3,
          frq: -1,
          cFrqInst: null,
          dt: new Date("2026-11-27T00:00:00Z"),
          htrnSrc: 1,
        },
        // The receiving leg: a template too, but it names no instance.
        {
          htrn: 2,
          frq: 3,
          cFrqInst: 1,
          dt: new Date("2026-11-27T00:00:00Z"),
          htrnSrc: null,
        },
        // An ordinary posting.
        {
          htrn: 47,
          frq: -1,
          cFrqInst: null,
          dt: new Date("2026-10-27T00:00:00Z"),
          htrnSrc: null,
        },
      ]),
    );

    expect(data.supported).toBe(true);
    expect(data.bills).toEqual([
      {
        handle: 1,
        status: -1,
        frequency: 3,
        occurrencesPerUnit: 1,
        nextDue: "2026-11-27",
        templateTransaction: 1,
        series: 1,
        instance: 0,
        endsOn: null,
        maxInstances: -1,
      },
    ]);
  });

  it("does not report BILL as missing, and names a missing source column instead", () => {
    const data = readBillData(
      fakeMnyDatabase(
        {
          TRN: {
            columns: ["htrn", "frq", "cFrqInst", "dt"],
            rows: [
              {
                htrn: 1,
                frq: 3,
                cFrqInst: 1,
                dt: new Date("2026-11-27T00:00:00Z"),
              },
            ],
          },
        },
        "jet3",
      ),
    );

    expect(data.availability.table).toBe("TRN");
    expect(data.availability.missingFields).toEqual(["pendingInstance"]);
    expect(data.bills).toEqual([]);
  });

  it("still reads BILL, and reports its absence, on a Money 2001+ file", () => {
    const data = readBillData(
      fakeMnyDatabase({
        TRN: {
          columns: COLUMNS,
          rows: [
            {
              htrn: 1,
              frq: 3,
              cFrqInst: 1,
              dt: new Date("2026-11-27T00:00:00Z"),
              htrnSrc: 3,
            },
          ],
        },
      }),
    );

    expect(data.supported).toBe(false);
    expect(data.availability.table).toBe("BILL");
    expect(data.bills).toEqual([]);
  });
});
