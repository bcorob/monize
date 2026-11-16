import { EntityManager } from "typeorm";

/**
 * How the export reads rows out of its snapshot.
 *
 * Two shapes, deliberately, because the export asks two different questions:
 *
 *  - `read` runs a query whose whole result the caller intends to hold. It is
 *    for the small, bounded reads -- a schema lookup, a handful of counters --
 *    and every use of it is a decision that the result cannot grow with the
 *    user's data.
 *  - `rows` runs the same query through a **cursor** and hands back batches, so
 *    the number of rows resident at once is the batch size rather than the
 *    table. This is the one that closed issue #1070: `manager.query` materialises
 *    every row the query returns before the first byte can be written, so a
 *    `SELECT` over `attachment_blobs` -- base64 text, potentially the largest
 *    thing in the database -- put the entire attachment set on the heap whatever
 *    the caller then did with it.
 *
 * Both run inside the caller's `REPEATABLE READ` transaction, so a cursor sees
 * exactly the snapshot the rest of the export does. That is also why the cursor
 * needs no `WITH HOLD`: it lives and dies with the transaction that declared it.
 */
export type ExportRead = (sql: string) => Promise<Record<string, unknown>[]>;

export interface ExportReader {
  /** One query, whole result. For bounded reads only. */
  read: ExportRead;
  /**
   * One query, streamed in batches of at most `batchSize` rows. The generator
   * closes its cursor when it is exhausted **and** when the consumer abandons
   * it early (a `break`, or a throw further down the pipeline).
   */
  rows(
    sql: string,
    batchSize: number,
  ): AsyncGenerator<Record<string, unknown>[]>;
}

/**
 * The batch size for an ordinary table: rows are small, and a hundred of them
 * cost less than the round trip to fetch them one at a time.
 */
export const DEFAULT_EXPORT_BATCH_ROWS = 200;

/**
 * The batch size for a table whose single row can be megabytes.
 *
 * `attachment_blobs` carries one base64-encoded object per row, so a batch of
 * two means two attachments resident at once. One is the floor this design can
 * offer: a row is serialised whole, so the largest single attachment is the
 * irreducible part of the peak. Everything else is bounded by the chunk budget
 * in `export-json-stream.ts`.
 */
export const BLOB_EXPORT_BATCH_ROWS = 1;

/** Rows a `FETCH` may ask for, guarded because the number reaches SQL. */
function assertBatchSize(batchSize: number): number {
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error(`Export batch size must be a positive integer`);
  }
  return batchSize;
}

/**
 * Builds the reader bound to one snapshot transaction and one user id (`$1`).
 *
 * The cursor name is generated here and nowhere else -- it is `monize_export_`
 * plus a counter, never anything derived from a request -- because a cursor name
 * cannot be a bind parameter and therefore has to be interpolated. The row count
 * in `FETCH FORWARD` cannot be a parameter either, which is why `assertBatchSize`
 * proves it is an integer before it is spliced in. The *query* keeps its
 * parameters: `DECLARE ... CURSOR FOR <sql>` binds `$1` the same way a plain
 * `SELECT` does.
 */
export function createExportReader(
  manager: EntityManager,
  userId: string,
): ExportReader {
  let declared = 0;
  const query = async (
    sql: string,
    params: unknown[],
  ): Promise<Record<string, unknown>[]> => {
    const rows = (await manager.query(sql, params)) as
      Record<string, unknown>[] | undefined;
    return rows ?? [];
  };

  return {
    read: (sql) => query(sql, [userId]),

    async *rows(sql: string, batchSize: number) {
      const size = assertBatchSize(batchSize);
      const name = `monize_export_${(declared += 1)}`;
      await query(`DECLARE ${name} NO SCROLL CURSOR FOR ${sql}`, [userId]);
      try {
        for (;;) {
          const batch = await query(`FETCH FORWARD ${size} FROM ${name}`, []);
          if (batch.length > 0) yield batch;
          // A short batch means the cursor is spent. Checking that rather than
          // fetching once more saves a round trip per table on the common case
          // of a table smaller than one batch.
          if (batch.length < size) return;
        }
      } finally {
        // Closing is not strictly required -- the transaction closes every
        // cursor when it ends -- but a plain export holds its snapshot open for
        // the length of the download, and an abandoned cursor keeps its
        // resources for all of it. Failures here are swallowed on purpose: the
        // interesting error is whatever ended the iteration, and the transaction
        // will clean up regardless.
        await query(`CLOSE ${name}`, []).catch(() => undefined);
      }
    },
  };
}
