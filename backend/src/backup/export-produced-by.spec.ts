import { ExportReader } from "./export-cursor";
import { readProducedBy } from "./export-produced-by";

/** A reader answering the two statements `readProducedBy` issues. */
function reader(ledger: { present: boolean }, filenames: unknown[]) {
  const read = jest.fn(async (sql: string) =>
    sql.includes("to_regclass")
      ? [ledger]
      : filenames.map((filename) => ({ filename })),
  );
  return { reader: { read, rows: jest.fn() } as unknown as ExportReader, read };
}

describe("readProducedBy", () => {
  it("answers the newest migration by numeric prefix, not by string order", async () => {
    const { reader: r } = reader({ present: true }, [
      "20261012133629_user_preferences_hidden_table_columns.sql",
      "191_payee_lookup_ai_enabled.sql",
      "20261012131846_securities_skip_price_updates_user_switch.sql",
      "068_a.sql",
    ]);
    expect(await readProducedBy(r)).toEqual({
      schemaMigration:
        "20261012133629_user_preferences_hidden_table_columns.sql",
    });
  });

  it("ranks a historical name below any timestamp whatever the row order", async () => {
    const { reader: r } = reader({ present: true }, [
      "20261012131846_x.sql",
      "191_y.sql",
    ]);
    expect((await readProducedBy(r)).schemaMigration).toBe(
      "20261012131846_x.sql",
    );
  });

  it("ignores rows that are not orderable migration names", async () => {
    const { reader: r } = reader({ present: true }, [
      null,
      42,
      "stray.sql",
      "191_y.sql",
    ]);
    expect((await readProducedBy(r)).schemaMigration).toBe("191_y.sql");
  });

  it("answers null, without reading the ledger, when it does not exist", async () => {
    const { reader: r, read } = reader({ present: false }, ["191_y.sql"]);
    expect(await readProducedBy(r)).toEqual({ schemaMigration: null });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("answers null when the ledger lists nothing orderable", async () => {
    const { reader: r } = reader({ present: true }, []);
    expect(await readProducedBy(r)).toEqual({ schemaMigration: null });
  });
});
