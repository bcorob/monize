import { BadRequestException } from "@nestjs/common";
import { EntityManager } from "typeorm";
import { UUID_REGEX } from "../common/query-param-utils";
import { tr } from "../i18n/translate";
import { baseInvestmentAction } from "../securities/investment-replay.util";
import { InvestmentAction } from "../securities/entities/investment-transaction.entity";

/**
 * The series of a program-linked security a share-moving transaction acts on
 * (`docs/specs/bond-program-securities.md` section 2.3, INV-BOND-007). One
 * resolver for every write path (the UI service, bulk, the AI assistant, MCP,
 * the file imports, undo and redo), called inside the write's own transaction
 * before anything is written, so a refusal leaves nothing behind.
 */

/** How a transaction's action relates to a series. */
export type SeriesRole =
  /** Adds a lot: the series is given or inferred from the date. */
  | "acquisition"
  /** Takes lots out: the series is optional. */
  | "removal"
  /** Names no series (cash actions, a split). */
  | "none";

/**
 * The role of an action. `pairedTransfer`: a TRANSFER_IN whose other leg exists
 * adds nothing of its own (the pair moves the source's lots with their series),
 * so it names a series only optionally, like a removal.
 */
export function seriesRoleOf(
  action: string,
  pairedTransfer: boolean,
): SeriesRole {
  switch (baseInvestmentAction(action)) {
    case InvestmentAction.BUY:
    case InvestmentAction.REINVEST:
    case InvestmentAction.ADD_SHARES:
      return "acquisition";
    case InvestmentAction.TRANSFER_IN:
      return pairedTransfer ? "removal" : "acquisition";
    case InvestmentAction.SELL:
    case InvestmentAction.REMOVE_SHARES:
    case InvestmentAction.TRANSFER_OUT:
      return "removal";
    default:
      return "none";
  }
}

/**
 * An acquisition with a purchase date of its own (BUY, REINVEST): its series is
 * inferred from that date when none is named. ADD_SHARES and an unpaired
 * TRANSFER_IN carry the transfer or grant date, not a purchase date, so they
 * must name their series (`SERIES_REQUIRED`) and are never inferred
 * (INV-BOND-007).
 */
export function infersSeriesFromDate(action: string): boolean {
  const base = baseInvestmentAction(action);
  return base === InvestmentAction.BUY || base === InvestmentAction.REINVEST;
}

/**
 * SQL selecting the ids of a program's series on sale on a date: the series
 * whose NEWEST terms version's `saleWindow` contains it. `program` and `date`
 * are SQL expressions (a placeholder or a column), `date` a YYYY-MM-DD text:
 * ISO dates compare correctly as text, and a series with no window matches
 * nothing. Written once; the inference of a write, the legacy inference of the
 * lot derivation and the link check all read it.
 */
export function seriesOnSaleSql(program: string, date: string): string {
  return `SELECT s.id
            FROM bond_instruments s
           CROSS JOIN LATERAL (
             SELECT v.terms
               FROM bond_terms_versions v
              WHERE v.bond_instrument_id = s.id
              ORDER BY v.version DESC
              LIMIT 1
           ) tv
           WHERE s.bond_program_id = ${program}::uuid
             AND (tv.terms -> 'saleWindow' ->> 'from') <= ${date}
             AND (tv.terms -> 'saleWindow' ->> 'to') >= ${date}`;
}

/**
 * The one series of the program on sale on `date`, or null when none or more
 * than one is (never a guess).
 */
export async function inferSeriesForDate(
  m: EntityManager,
  bondProgramId: string,
  date: string,
): Promise<string | null> {
  const rows: Array<{ id: string }> = await m.query(
    `${seriesOnSaleSql("$1", "$2::text")} ORDER BY s.series_code`,
    [bondProgramId, date.slice(0, 10)],
  );
  return rows.length === 1 ? rows[0].id : null;
}

/**
 * A series named by a UUID or by its code (`EDO1036`, case-insensitive) within
 * the program: the id, or null when the program has no such series. For the AI
 * and MCP tools, which accept either spelling.
 */
export async function findSeriesOfProgram(
  m: EntityManager,
  bondProgramId: string,
  reference: string,
): Promise<string | null> {
  const rows: Array<{ id: string }> = UUID_REGEX.test(reference)
    ? await m.query(
        `SELECT id FROM bond_instruments WHERE id = $1::uuid AND bond_program_id = $2::uuid`,
        [reference.toLowerCase(), bondProgramId],
      )
    : await m.query(
        `SELECT id FROM bond_instruments
          WHERE bond_program_id = $1::uuid AND UPPER(series_code) = UPPER($2)`,
        [bondProgramId, reference],
      );
  return rows[0]?.id ?? null;
}

export type BondSeriesProblemCode =
  | "SERIES_NOT_IN_PROGRAM"
  | "SERIES_NOT_DETERMINED"
  | "SERIES_NOT_ALLOWED"
  | "SERIES_REQUIRED";

const FALLBACKS: Readonly<
  Record<BondSeriesProblemCode, (p: Record<string, string>) => string>
> = {
  SERIES_NOT_IN_PROGRAM: (p) =>
    `Series ${p.series} does not belong to the bond program of this security (${p.program})`,
  SERIES_NOT_DETERMINED: (p) =>
    `The series of this ${p.program} purchase on ${p.date} could not be determined: no single stored series of the program was on sale that day. Fetch the series from the official source and choose it for the transaction.`,
  SERIES_NOT_ALLOWED: () =>
    "A bond series can only be named for a share-moving transaction of a security linked to a bond program",
  SERIES_REQUIRED: (p) =>
    `Name the bond series of these shares: ${p.action} has no purchase date of its own to infer it from.`,
};

function refuse(
  code: BondSeriesProblemCode,
  params: Record<string, string> = {},
): never {
  throw new BadRequestException({
    message: tr(`errors.bonds.${code}`, FALLBACKS[code](params), params),
    errorCode: code,
  });
}

export interface SeriesWrite {
  readonly securityId: string | null | undefined;
  readonly action: string;
  /** The transaction date, YYYY-MM-DD (a longer ISO string is cut to its date). */
  readonly transactionDate: string;
  /** The series (bond instrument id) the row names, if any. */
  readonly bondInstrumentId?: string | null;
  /**
   * True when the caller named the series in THIS write; false when
   * `bondInstrumentId` is only what the unchanged row already stored (a form
   * resends every field, and a stored value is not a request). A stored series
   * the row can no longer carry (the security was unlinked, the action no
   * longer moves shares) is dropped; a requested one is refused.
   */
  readonly requested: boolean;
  /**
   * A series named by its code (`EDO1036`, case-insensitive) or by its id, for
   * the AI and MCP tools. When present it is the request and wins over
   * `bondInstrumentId`; it is resolved within the security's program.
   */
  readonly bondSeriesReference?: string | null;
  /** The other leg of a transfer exists. */
  readonly pairedTransfer?: boolean;
  /**
   * The write changes nothing the series depends on (the security, the action
   * and the date are the stored ones) and names no series: the stored value,
   * `bondInstrumentId` (NULL included), is kept as it is -- never inferred and
   * never refused. A form resends every field, so an edit of the description of
   * a legacy row must not be the write that asks for a series.
   */
  readonly keepStored?: boolean;
  /**
   * Per-run memo of the security's program (an import writes thousands of rows
   * of one security): the lookup runs once per security, not once per row.
   */
  readonly programCache?: BondProgramCache;
}

/** The bond program a security is linked to, with its code for messages. */
export interface BondProgramRef {
  readonly id: string;
  readonly programCode: string;
}

/** A memo of `programOfSecurity` answers for one run (one import, one request). */
export type BondProgramCache = Map<string, BondProgramRef | null>;

/**
 * The program the user's security is linked to, or null (not linked, or not the
 * caller's: ownership is in the predicate, `user_id` comes from the JWT). With a
 * cache the lookup runs once per security.
 */
export async function programOfSecurity(
  m: EntityManager,
  userId: string,
  securityId: string,
  cache?: BondProgramCache,
): Promise<BondProgramRef | null> {
  if (cache?.has(securityId)) return cache.get(securityId) ?? null;
  const rows: Array<{ id: string | null; program_code: string | null }> =
    await m.query(
      `SELECT s.bond_program_id AS id, p.program_code
         FROM securities s
         LEFT JOIN bond_programs p ON p.id = s.bond_program_id
        WHERE s.id = $1 AND s.user_id = $2`,
      [securityId, userId],
    );
  const program = rows[0]?.id
    ? { id: rows[0].id, programCode: rows[0].program_code ?? "" }
    : null;
  cache?.set(securityId, program);
  return program;
}

/**
 * The series to store on a share-moving row, or null. Runs on the write's own
 * transaction (`m`), before anything is written; throws a translated 400 that
 * names the series, program and date.
 *
 * - A security with no program link, or an action that moves no shares: no
 *   series; naming one is refused (`SERIES_NOT_ALLOWED`).
 * - A named series must belong to the security's program
 *   (`SERIES_NOT_IN_PROGRAM`).
 * - A BUY or REINVEST with none named takes the program's series on sale on the
 *   transaction date; none, or more than one, is `SERIES_NOT_DETERMINED`.
 * - ADD_SHARES and an unpaired TRANSFER_IN with none named are
 *   `SERIES_REQUIRED`: they have no purchase date to infer from.
 * - `keepStored`: the stored value is returned as it is (see `SeriesWrite`).
 * - A removal with none named stays without one (first-in first-out across
 *   series).
 */
export async function resolveTransactionSeries(
  m: EntityManager,
  userId: string,
  write: SeriesWrite,
): Promise<string | null> {
  if (write.keepStored && !write.bondSeriesReference?.trim()) {
    return write.bondInstrumentId ? write.bondInstrumentId.toLowerCase() : null;
  }
  const role = seriesRoleOf(write.action, write.pairedTransfer ?? false);
  const reference = write.bondSeriesReference?.trim() || null;
  let named = write.bondInstrumentId
    ? write.bondInstrumentId.toLowerCase()
    : null;
  const requested = write.requested || reference !== null;

  const program = write.securityId
    ? await programOfSecurity(m, userId, write.securityId, write.programCache)
    : null;

  if (program === null || role === "none") {
    if ((named !== null || reference !== null) && requested) {
      refuse("SERIES_NOT_ALLOWED");
    }
    return null;
  }

  if (reference !== null) {
    named = await findSeriesOfProgram(m, program.id, reference);
    if (named === null) {
      refuse("SERIES_NOT_IN_PROGRAM", {
        series: reference,
        program: program.programCode,
      });
    }
  }

  if (named !== null) {
    const rows: unknown[] = await m.query(
      `SELECT 1 FROM bond_instruments WHERE id = $1::uuid AND bond_program_id = $2::uuid`,
      [named, program.id],
    );
    if (rows.length > 0) return named;
    if (requested) {
      refuse("SERIES_NOT_IN_PROGRAM", {
        series: named,
        program: program.programCode,
      });
    }
    // A stored series of another program (the security was relinked): not a
    // request, so the row is treated as naming none.
  }

  if (role === "removal") return null;

  // An acquisition with no purchase date of its own (ADD_SHARES, an unpaired
  // TRANSFER_IN) is never inferred from the date it was recorded on.
  if (!infersSeriesFromDate(write.action)) {
    refuse("SERIES_REQUIRED", { action: baseInvestmentAction(write.action) });
  }

  const date = String(write.transactionDate).slice(0, 10);
  const inferred = await inferSeriesForDate(m, program.id, date);
  if (inferred === null) {
    refuse("SERIES_NOT_DETERMINED", { date, program: program.programCode });
  }
  return inferred;
}

/**
 * The series an undo or redo puts back on a row: the snapshot's own, exactly,
 * and never an inference. A snapshot series that is not in the security's
 * current program (relinked or unlinked since, or not a UUID) is stored as NULL
 * and the ledger reports the row (INV-BOND-007).
 */
export async function restoredSeries(
  m: EntityManager,
  userId: string,
  securityId: string | null | undefined,
  snapshotSeries: unknown,
): Promise<string | null> {
  if (
    !securityId ||
    typeof snapshotSeries !== "string" ||
    !UUID_REGEX.test(snapshotSeries)
  ) {
    return null;
  }
  const rows: unknown[] = await m.query(
    `SELECT 1
       FROM securities s
       JOIN bond_instruments i ON i.bond_program_id = s.bond_program_id
      WHERE s.id = $1 AND s.user_id = $2 AND i.id = $3::uuid`,
    [securityId, userId, snapshotSeries.toLowerCase()],
  );
  return rows.length > 0 ? snapshotSeries.toLowerCase() : null;
}

/**
 * The series of a row a file import writes: a file names none, so a BUY or
 * REINVEST takes the program's series on sale on its date, and every other
 * acquisition (ADD_SHARES, an unpaired TRANSFER_IN) or one with no stored
 * series on sale that day stores NULL, which the lot derivation reports with
 * `SERIES_NOT_DETERMINED` instead of the import refusing or dropping the row.
 * `unresolved` says the row is such an acquisition, for the import's count.
 * The program is looked up once per security per run (`cache`).
 */
export async function resolveImportedSeries(
  m: EntityManager,
  userId: string,
  row: {
    readonly securityId: string | null | undefined;
    readonly action: string;
    readonly transactionDate: string;
    readonly pairedTransfer?: boolean;
  },
  cache: BondProgramCache,
): Promise<{ id: string | null; unresolved: boolean }> {
  const program = row.securityId
    ? await programOfSecurity(m, userId, row.securityId, cache)
    : null;
  if (
    program === null ||
    seriesRoleOf(row.action, row.pairedTransfer ?? false) !== "acquisition"
  ) {
    return { id: null, unresolved: false };
  }
  const id = infersSeriesFromDate(row.action)
    ? await inferSeriesForDate(
        m,
        program.id,
        String(row.transactionDate).slice(0, 10),
      )
    : null;
  return { id, unresolved: id === null };
}

/**
 * After a security's link changed (unlinked, or moved to another program):
 * its rows that name a series outside the new program lose it, in the link's
 * own transaction. A security that is not program-linked never has the column
 * set (INV-BOND-007); a row left without one is read by the lot derivation as a
 * legacy row (inferred from its date).
 */
export async function clearForeignSeries(
  m: EntityManager,
  userId: string,
  securityId: string,
  newProgramId: string | null,
): Promise<void> {
  await m.query(
    `UPDATE investment_transactions t
        SET bond_instrument_id = NULL
      WHERE t.security_id = $1 AND t.user_id = $2
        AND t.bond_instrument_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM bond_instruments i
           WHERE i.id = t.bond_instrument_id AND i.bond_program_id = $3::uuid
        )`,
    [securityId, userId, newProgramId],
  );
}

/** The code of a series (`EDO1036`) for a confirmation card, or null. */
export async function seriesCodeOf(
  m: EntityManager,
  instrumentId: string | null,
): Promise<string | null> {
  if (!instrumentId) return null;
  const rows: Array<{ series_code: string }> = await m.query(
    `SELECT series_code FROM bond_instruments WHERE id = $1::uuid`,
    [instrumentId],
  );
  return rows[0]?.series_code ?? null;
}

/**
 * After a restore wrote a user's rows from a file: every row of the user's that
 * names a series outside its own security's program (a crafted or stale file,
 * a program this deployment links differently) loses it (INV-BOND-007).
 */
export async function clearForeignSeriesOfUser(
  m: EntityManager,
  userId: string,
): Promise<void> {
  await m.query(
    `UPDATE investment_transactions t
        SET bond_instrument_id = NULL
      WHERE t.user_id = $1
        AND t.bond_instrument_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
            FROM securities s
            JOIN bond_instruments i ON i.bond_program_id = s.bond_program_id
           WHERE s.id = t.security_id AND s.user_id = t.user_id
             AND i.id = t.bond_instrument_id
        )`,
    [userId],
  );
}
