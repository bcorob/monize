import { ExportReader } from "./export-cursor";
import {
  collectExportTables,
  EXPORT_CHUNK_BYTES,
  exportJsonChunks,
} from "./export-json-stream";
import { ExportTableQuery } from "./export-table-queries";

/**
 * The document assembly: what it produces has to be byte-identical to what the
 * old whole-table `JSON.stringify` produced, and what it *holds* has to be the
 * chunk budget rather than the table.
 */
describe("exportJsonChunks", () => {
  const exportedAt = "2026-08-07T00:00:00.000Z";
  /** The claim the artifact carries about its own attachments (issue #1069). */
  const COMPLETE = {
    complete: true,
    expectedAttachments: 0,
    includedAttachments: 0,
    missingAttachments: 0,
    inconsistentAttachments: 0,
  };

  /**
   * A reader over fixed tables, recording how many rows it has been asked for so
   * a test can prove the reader stopped when the writer did.
   */
  function readerOver(
    tables: Record<string, Record<string, unknown>[]>,
    trace: { fetched: number } = { fetched: 0 },
  ): ExportReader {
    return {
      read: async (sql) =>
        Object.entries(tables).find(([name]) => sql.includes(name))?.[1] ?? [],
      async *rows(sql, batchSize) {
        const rows =
          Object.entries(tables).find(([name]) => sql.includes(name))?.[1] ??
          [];
        for (let i = 0; i < rows.length; i += batchSize) {
          const batch = rows.slice(i, i + batchSize);
          trace.fetched += batch.length;
          yield batch;
        }
      },
    };
  }

  const query = (
    key: string,
    extra: Partial<ExportTableQuery> = {},
  ): ExportTableQuery => ({ key, sql: `SELECT * FROM ${key}`, ...extra });

  async function assemble(
    reader: ExportReader,
    tables: ExportTableQuery[],
    chunkBytes?: number,
  ): Promise<{
    text: string;
    chunks: Array<{ table: string | null; size: number }>;
  }> {
    const parts: string[] = [];
    const chunks: Array<{ table: string | null; size: number }> = [];
    for await (const chunk of exportJsonChunks(reader, tables, {
      exportedAt,
      completeness: COMPLETE,
      chunkBytes,
    })) {
      parts.push(chunk.text);
      chunks.push({ table: chunk.table, size: chunk.text.length });
    }
    return { text: parts.join(""), chunks };
  }

  it("writes the non-table members after the last table and before completeness, read from the same reader", async () => {
    const reader = readerOver({ accounts: [{ id: "a" }] });
    const parts: string[] = [];
    for await (const chunk of exportJsonChunks(reader, [query("accounts")], {
      exportedAt,
      completeness: COMPLETE,
      members: async (r) => ({
        bondCatalog: { series: await r.read("accounts") },
      }),
    })) {
      parts.push(chunk.text);
    }
    const text = parts.join("");
    expect(text).toBe(
      `{"version":1,"exportedAt":"${exportedAt}"` +
        `,"accounts":[{"id":"a"}]` +
        `,"bondCatalog":{"series":[{"id":"a"}]}` +
        `,"completeness":${JSON.stringify(COMPLETE)}}`,
    );
  });

  it("produces the document the whole-table serialisation produced", async () => {
    const accounts = [
      { id: "a", name: 'Quote " and \\ backslash' },
      { id: "b", name: null, nested: { x: 1 } },
    ];
    const reader = readerOver({ accounts, payees: [] });

    const { text } = await assemble(reader, [
      query("accounts"),
      query("payees"),
    ]);

    expect(JSON.parse(text)).toEqual({
      version: 1,
      exportedAt,
      accounts,
      payees: [],
      completeness: COMPLETE,
    });
    // Not just parseable -- the same bytes, so nothing downstream can notice the
    // difference between a table serialised whole and one serialised per row.
    expect(text).toBe(
      `{"version":1,"exportedAt":"${exportedAt}"` +
        `,"accounts":${JSON.stringify(accounts)}` +
        `,"payees":[]` +
        `,"completeness":${JSON.stringify(COMPLETE)}}`,
    );
  });

  it("flushes at the chunk budget instead of at the end of a table", async () => {
    // 400 rows of ~40 bytes is ~16 kB, so a 4 kB budget must produce several
    // chunks. Before issue #1070 the table was one string however large it was.
    const rows = Array.from({ length: 400 }, (_, i) => ({
      id: `row-${String(i).padStart(6, "0")}`,
      note: "0123456789",
    }));
    const reader = readerOver({ transactions: rows });

    const { text, chunks } = await assemble(
      reader,
      [query("transactions")],
      4 * 1024,
    );

    expect(chunks.length).toBeGreaterThan(3);
    // No chunk is much larger than the budget: the flush happens as soon as it
    // is crossed, so the overshoot is one row.
    const biggest = Math.max(...chunks.map((c) => c.size));
    expect(biggest).toBeLessThan(4 * 1024 + 200);
    expect(JSON.parse(text).transactions).toHaveLength(400);
  });

  it("names the table each chunk was flushed during", async () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({ id: i }));
    const reader = readerOver({ transactions: rows, payees: rows });

    const { chunks } = await assemble(
      reader,
      [query("transactions"), query("payees")],
      256,
    );

    // A sink that refuses a chunk has to be able to say where the document had
    // got to; the envelope and the closing brace inherit the table before them.
    expect(chunks.some((c) => c.table === "transactions")).toBe(true);
    expect(chunks.some((c) => c.table === "payees")).toBe(true);
    expect(chunks.every((c) => c.table !== null)).toBe(true);
  });

  it("does not read past what the consumer has taken", async () => {
    // The backpressure claim, at this layer: the generator is pulled, so a
    // consumer that stops taking chunks stops the reads behind it.
    const trace = { fetched: 0 };
    const rows = Array.from({ length: 5000 }, (_, i) => ({
      id: `row-${i}`,
      note: "x".repeat(50),
    }));
    const reader = readerOver({ transactions: rows }, trace);

    const chunks = exportJsonChunks(reader, [query("transactions")], {
      exportedAt,
      completeness: COMPLETE,
      chunkBytes: 1024,
    });
    await chunks.next();
    // One batch, not the table: 200 of 5000 rows have been read to produce the
    // first chunk. The old assembly read all 5000 before producing anything.
    expect(trace.fetched).toBeLessThanOrEqual(200);

    for await (const rest of chunks) {
      expect(rest.text.length).toBeGreaterThan(0);
    }
    expect(trace.fetched).toBe(rows.length);
  });

  it("appends a table's trailing rows one at a time", async () => {
    const yielded: string[] = [];
    const reader = readerOver({
      attachment_blobs: [{ attachment_id: "in-db" }],
    });
    const tables = [
      query("attachment_blobs", {
        trailingRows: async function* () {
          for (const id of ["ext-1", "ext-2"]) {
            yielded.push(id);
            yield { attachment_id: id };
          }
        },
      }),
    ];

    const { text } = await assemble(reader, tables);

    expect(JSON.parse(text).attachment_blobs).toEqual([
      { attachment_id: "in-db" },
      { attachment_id: "ext-1" },
      { attachment_id: "ext-2" },
    ]);
    expect(yielded).toEqual(["ext-1", "ext-2"]);
  });

  it("uses a chunk budget by default", () => {
    // The default matters: a budget nobody set is a budget of one table.
    expect(EXPORT_CHUNK_BYTES).toBeGreaterThan(0);
    expect(EXPORT_CHUNK_BYTES).toBeLessThanOrEqual(1024 * 1024);
  });
});

describe("collectExportTables", () => {
  function readerOver(
    tables: Record<string, Record<string, unknown>[]>,
    seen: string[] = [],
  ): ExportReader {
    return {
      read: async () => [],
      async *rows(sql, batchSize) {
        seen.push(sql);
        const rows =
          Object.entries(tables).find(([name]) => sql.includes(name))?.[1] ??
          [];
        for (let i = 0; i < rows.length; i += batchSize) {
          yield rows.slice(i, i + batchSize);
        }
      },
    };
  }

  it("collects every table's rows, including trailing ones", async () => {
    const reader = readerOver({ accounts: [{ id: "a" }] });

    const tables = await collectExportTables(reader, [
      { key: "accounts", sql: "SELECT * FROM accounts" },
      {
        key: "attachment_blobs",
        sql: "SELECT * FROM attachment_blobs",
        trailingRows: async function* () {
          yield { attachment_id: "ext" };
        },
      },
    ]);

    expect(tables).toEqual({
      accounts: [{ id: "a" }],
      attachment_blobs: [{ attachment_id: "ext" }],
    });
  });

  it("never queries a table the caller is skipping", async () => {
    // A budget checked after the allocation is not a budget: the support export
    // discards `attachment_blobs`, which is base64 and can be the largest thing
    // in the database.
    const seen: string[] = [];
    const trailing = jest.fn();
    const reader = readerOver(
      { attachment_blobs: [{ attachment_id: "a" }] },
      seen,
    );

    const tables = await collectExportTables(
      reader,
      [
        {
          key: "attachment_blobs",
          sql: "SELECT * FROM attachment_blobs",
          trailingRows: async function* () {
            trailing();
            yield { attachment_id: "never reached" };
          },
        },
      ],
      new Set(["attachment_blobs"]),
    );

    expect(tables).toEqual({});
    expect(seen).toEqual([]);
    expect(trailing).not.toHaveBeenCalled();
  });
});
