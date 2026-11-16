import { BACKUP_VERSION, BackupCompletenessReport } from "./backup-format";
import { DEFAULT_EXPORT_BATCH_ROWS, ExportReader } from "./export-cursor";
import { ExportTableQuery } from "./export-table-queries";

/**
 * The backup document, produced as a sequence of bounded JSON fragments.
 *
 * The export used to build one string per table (`JSON.stringify(rows)`) and
 * hand it to gzip. That reads as streaming -- a table at a time -- and is not:
 * the array, and then a string of the whole array, are both live at the moment
 * of the call, so peak memory tracked the largest table rather than the chunk
 * size. With `attachment_blobs` holding every receipt as base64 that was the
 * whole dataset (issue #1070, F3RB-006).
 *
 * So the document is assembled here instead, one row at a time, and flushed
 * whenever the accumulated text passes `EXPORT_CHUNK_BYTES`. What is resident is
 * a batch of rows, one serialised row, and at most one chunk of text.
 *
 * **The floor is one row.** A single 10 MiB attachment is 13.6 MiB of base64
 * whatever the budget says, because a row is serialised whole. The budget bounds
 * accumulation, not the largest individual value, and no cursor can change that.
 */

/**
 * Text accumulated before a flush. 256 KiB is large enough that the per-write
 * overhead through gzip is irrelevant and small enough that a hundred concurrent
 * exports would still be measured in tens of megabytes.
 */
export const EXPORT_CHUNK_BYTES = 256 * 1024;

/**
 * One fragment of the artifact, with the table it came from.
 *
 * The table travels with the text because the buffered sink has to be able to
 * name the table it gave up at -- an error that says only "too large" tells the
 * user nothing they can act on. `null` is the envelope itself.
 */
export interface ExportChunk {
  table: string | null;
  text: string;
}

export interface ExportJsonOptions {
  /** `exportedAt` for the envelope; passed in so every path stamps one instant. */
  exportedAt: string;
  /**
   * The completeness claim written into the document itself (issue #1069).
   *
   * At the tail rather than beside `version` because that is where the buffered
   * assembly had to put it -- it could not know the answer until every table had
   * been read -- and one placement for both paths means a reader never has to
   * care which produced the file. JSON member order carries no meaning;
   * `data.completeness` reads the same either way. The streaming path *does*
   * know the answer up front now, since the audit precedes the body, and it
   * still writes it here for that reason.
   *
   * Written for a complete artifact too. "This file says it is complete" and
   * "this file says nothing" are different facts about a recovered artifact, and
   * only the first of them is evidence (`parseArtifactCompleteness`).
   */
  completeness: BackupCompletenessReport;
  /**
   * Document members that are not tables, read from the same snapshot after the
   * last table and written before `completeness`. Bounded reads only: each
   * member is held whole (today the identity of the bond series the rows
   * reference, `bondCatalog`).
   */
  members?: (reader: ExportReader) => Promise<Record<string, unknown>>;
  /** Overridable for tests that need to observe flush behaviour cheaply. */
  chunkBytes?: number;
}

/**
 * Streams the whole document: envelope, then every table in `tables` in order,
 * then the closing brace.
 *
 * The consumer drives it. Each `yield` suspends until the writer has taken the
 * chunk, so a slow client stops the reader rather than filling a queue behind
 * it -- that is the backpressure half of the fix, and it is why this is a
 * generator rather than a callback that pushes.
 */
export async function* exportJsonChunks(
  reader: ExportReader,
  tables: ExportTableQuery[],
  options: ExportJsonOptions,
): AsyncGenerator<ExportChunk> {
  const chunkBytes = options.chunkBytes ?? EXPORT_CHUNK_BYTES;
  // A local accumulator, appended to rather than rebuilt: rebuilding it per row
  // is quadratic in the number of rows that fit one chunk, which for ordinary
  // rows is thousands. Nothing outside this generator can observe it.
  let buffered: string[] = [];
  let bufferedBytes = 0;
  // The last table anything was written for. The envelope and the closing brace
  // belong to no table, and a sink that refuses a chunk still has to be able to
  // say where the document had got to -- so those inherit the table before them
  // rather than reporting nothing.
  let lastTable: string | null = null;

  async function* emit(
    text: string,
    table: string | null,
  ): AsyncGenerator<ExportChunk> {
    if (table !== null) lastTable = table;
    buffered.push(text);
    bufferedBytes += Buffer.byteLength(text, "utf-8");
    if (bufferedBytes >= chunkBytes) {
      yield { table: lastTable, text: buffered.join("") };
      buffered = [];
      bufferedBytes = 0;
    }
  }

  yield* emit(
    `{"version":${BACKUP_VERSION},"exportedAt":"${options.exportedAt}"`,
    null,
  );

  for (const entry of tables) {
    yield* emit(`,"${entry.key}":[`, entry.key);
    let written = 0;
    // The transform runs here, one row at a time, so a rewritten table costs the
    // same resident bytes as an untouched one.
    const separated = (row: Record<string, unknown>): string =>
      (written === 0 ? "" : ",") +
      JSON.stringify(entry.transformRow ? entry.transformRow(row) : row);

    for await (const batch of reader.rows(
      entry.sql,
      entry.batchRows ?? DEFAULT_EXPORT_BATCH_ROWS,
    )) {
      for (const row of batch) {
        yield* emit(separated(row), entry.key);
        written += 1;
      }
    }

    if (entry.trailingRows) {
      for await (const row of entry.trailingRows(reader)) {
        yield* emit(separated(row), entry.key);
        written += 1;
      }
    }

    yield* emit("]", entry.key);
  }

  if (options.members) {
    for (const [key, value] of Object.entries(await options.members(reader))) {
      yield* emit(`,${JSON.stringify(key)}:${JSON.stringify(value)}`, null);
    }
  }

  yield* emit(`,"completeness":${JSON.stringify(options.completeness)}}`, null);

  if (buffered.length > 0) yield { table: lastTable, text: buffered.join("") };
}

/**
 * The same tables, collected into memory as `table -> rows`.
 *
 * The support (de-identified) backup cannot stream: it reconciles scaled
 * balances across every table before it serialises anything, so it needs the
 * whole map. It gets it from the same reader and the same query list, so the two
 * paths cannot disagree about what a backup contains -- and it passes
 * `skipTables` so the tables it is going to discard are never read at all.
 */
export async function collectExportTables(
  reader: ExportReader,
  tables: ExportTableQuery[],
  skipTables?: ReadonlySet<string>,
): Promise<Record<string, Record<string, unknown>[]>> {
  const collected: Record<string, Record<string, unknown>[]> = {};
  for (const entry of tables) {
    // A caller that will discard a table must not pay to load it. The support
    // backup always excludes `attachment_blobs`, which is base64 -- thirty 10 MiB
    // receipts are ~400 MiB of text, fetched and thrown away before any ceiling
    // was consulted. Skipping the query is the only fix that helps: a budget
    // checked after the allocation is a budget checked too late.
    if (skipTables?.has(entry.key)) continue;
    const batches: Record<string, unknown>[][] = [];
    for await (const batch of reader.rows(
      entry.sql,
      entry.batchRows ?? DEFAULT_EXPORT_BATCH_ROWS,
    )) {
      batches.push(batch);
    }
    if (entry.trailingRows) {
      for await (const row of entry.trailingRows(reader)) {
        batches.push([row]);
      }
    }
    const rows = batches.flat();
    // Same transform as the streamed path, or the support backup and the
    // download would describe different data for the same table.
    collected[entry.key] = entry.transformRow
      ? rows.map(entry.transformRow)
      : rows;
  }
  return collected;
}
