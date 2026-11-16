/**
 * `DECLARE` / `FETCH` / `CLOSE` for a mocked `manager.query`.
 *
 * The backup export reads large tables through a database cursor so that a
 * table contributes a batch of rows at a time rather than all of it (issue
 * #1070, `export-cursor.ts`). A mock that answers only the plain `SELECT` sees
 * `DECLARE ... CURSOR FOR SELECT ...` and then `FETCH FORWARD n FROM ...`, and
 * returns nothing for the second -- so every export in the suite would quietly
 * produce empty tables and every assertion about content would be vacuous.
 *
 * Wrapping a handler here keeps the specs written against the *query*: the inner
 * `SELECT` is handed to the wrapped handler exactly as it used to be, with the
 * same parameters, and its rows are served back in batches. A spec that mocks
 * `sql.includes("FROM accounts")` needs no change.
 */
export function emulatePgCursors(
  handler: (sql: string, params?: unknown[]) => Promise<unknown> | unknown,
): (sql: string, params?: unknown[]) => Promise<unknown> {
  const open = new Map<string, { rows: unknown[]; next: number }>();

  const DECLARE =
    /^DECLARE\s+([A-Za-z_][A-Za-z0-9_$]*)\s+(?:NO SCROLL\s+|SCROLL\s+)?CURSOR\s+(?:WITHOUT HOLD\s+|WITH HOLD\s+)?FOR\s+([\s\S]+)$/i;
  const FETCH = /^FETCH\s+FORWARD\s+(\d+)\s+FROM\s+([A-Za-z_][A-Za-z0-9_$]*)$/i;
  const CLOSE = /^CLOSE\s+([A-Za-z_][A-Za-z0-9_$]*)$/i;

  return async (sql: string, params?: unknown[]) => {
    const text = String(sql).trim();

    const declared = DECLARE.exec(text);
    if (declared) {
      const rows = (await handler(declared[2], params)) as
        unknown[] | undefined;
      open.set(declared[1], { rows: rows ?? [], next: 0 });
      return [];
    }

    const fetched = FETCH.exec(text);
    if (fetched) {
      const cursor = open.get(fetched[2]);
      // A FETCH from a cursor nothing declared is a bug in the code under test,
      // not an empty result: real Postgres raises, and so does this.
      if (!cursor) throw new Error(`cursor "${fetched[2]}" does not exist`);
      const size = Number(fetched[1]);
      const batch = cursor.rows.slice(cursor.next, cursor.next + size);
      open.set(fetched[2], { rows: cursor.rows, next: cursor.next + size });
      return batch;
    }

    const closed = CLOSE.exec(text);
    if (closed) {
      open.delete(closed[1]);
      return [];
    }

    return handler(sql, params);
  };
}
