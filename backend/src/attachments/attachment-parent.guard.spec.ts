import { readFileSync } from "fs";
import { join } from "path";

const SRC_ROOT = join(__dirname, "..");

/**
 * Blank out comments while preserving every line break, so a reported
 * offender still points at the right line. The rule has to be explained in
 * prose that names the table, and a scan over raw text would fail on its own
 * explanations (`docs/guard-tests.md`).
 */
export function blankComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (match, prefix: string) =>
      prefix.concat(" ".repeat(match.length - prefix.length)),
    );
}

/**
 * The reads that answer a question about a TRANSACTION's attachments: the
 * register's paperclip count and its `hasAttachments` filter, the
 * `has:attachment` search term, and the rule engine's attachment fact. Each
 * answers with the transaction's own rows plus the documents of every
 * warranty linked to it (WTY-003's consumer side, as the maintainer ruled it
 * on 2026-10-22), through the fragments in `attachment-parent.ts`.
 */
const TRANSACTION_BOUND_FILES = [
  "transactions/transactions.service.ts",
  "transactions/transaction-search.util.ts",
  "transaction-rules/rule-facts.ts",
] as const;

/** A query site: raw SQL naming the table, or the entity's repository. */
const QUERY_SITE =
  /getRepository\(\s*TransactionAttachment\s*\)|\btransaction_attachments\b/g;

/**
 * The reach every site must carry: the one-transaction predicate, or the
 * "reached from" expression of a grouped read (which only makes sense beside
 * `reachingWarrantyJoinSql`). Both live in `attachment-parent.ts`.
 */
const REACHABILITY =
  /\battachmentReachableFromTransactionSql\s*\(|\breachedTransactionIdSql\s*\(/;

/**
 * Where a site's statement ends: the next semicolon. Both dialects used in
 * these files end their statement there -- a template literal holding an
 * EXISTS subquery, and a query-builder chain closed by `getRawMany()`.
 */
function statementFrom(source: string, index: number): string {
  const end = source.indexOf(";", index);
  return source.slice(index, end === -1 ? source.length : end);
}

interface Offender {
  file: string;
  line: number;
}

/**
 * Every query site in `source` that names the attachments table or
 * repository without reaching it through the shared fragment.
 */
export function unreachedAttachmentSites(
  source: string,
  file = "<source>",
): Offender[] {
  const code = blankComments(source);
  const offenders: Offender[] = [];
  for (const match of code.matchAll(QUERY_SITE)) {
    const index = match.index ?? 0;
    if (REACHABILITY.test(statementFrom(code, index))) continue;
    const line = code.slice(0, index).split("\n").length;
    offenders.push({ file, line });
  }
  return offenders;
}

/**
 * A transaction's attachments are its own rows plus the documents of the
 * warranties linked to it, reached one way.
 *
 * `transaction_attachments` carries two parent columns and exactly one is
 * set (`chk_attachment_one_parent`). A document uploaded to a warranty that
 * is linked to a transaction is one of that transaction's attachments (the
 * maintainer's ruling), reached through `warranties.transaction_id`. A read
 * that restricts on `transaction_id` alone answers with the row's own files
 * and misses the receipt on its warranty: a paperclip that says 0 beside a
 * list that shows one, a `has:attachment` that skips the row, a rule that
 * never fires. A read that restricts on `user_id` alone, or reaches
 * `warranty_id` without the warranties join, answers with every warranty's
 * documents, linked or not. This scan fails the moment one of the
 * transaction-bound reads spells the reach itself instead of calling the
 * fragment in `attachment-parent.ts`.
 */
describe("a transaction-bound attachment read reaches through the shared fragment (WTY-003)", () => {
  const sources = TRANSACTION_BOUND_FILES.map((rel) => ({
    rel,
    source: readFileSync(join(SRC_ROOT, rel), "utf8"),
  }));

  it("finds query sites in every scanned file", () => {
    // A renamed table or a moved read would make the assertion below vacuous.
    const counts = sources.map(({ rel, source }) => ({
      rel,
      sites: [...blankComments(source).matchAll(QUERY_SITE)].length,
    }));
    for (const { sites } of counts) expect(sites).toBeGreaterThan(0);
  });

  it("calls a reachability fragment at every site", () => {
    // Each entry carries the rule, so the failure output says what to do: a
    // read of transaction_attachments that answers for a transaction reaches
    // its own rows and its linked warranties' documents through
    // attachment-parent.ts, never by a predicate of its own.
    const offenders = sources.flatMap(({ rel, source }) =>
      unreachedAttachmentSites(source, rel).map(
        ({ file, line }) =>
          `WTY-003: ${file}:${line} reads transaction_attachments without ` +
          `attachmentReachableFromTransactionSql or reachedTransactionIdSql ` +
          `(attachments/attachment-parent.ts). A transaction's attachments ` +
          `are its own rows plus the documents of every warranty linked to ` +
          `it (the maintainer's ruling, 2026-10-22): a count of own rows ` +
          `alone misses them, and a reach into warranty_id that skips ` +
          `warranties.transaction_id counts every warranty's documents`,
      ),
    );

    expect(offenders).toEqual([]);
  });

  // The scan is only worth anything if it would actually catch the thing it
  // bans, so both directions are asserted rather than assumed.
  describe("the scan itself", () => {
    it("catches a raw EXISTS that names only the user", () => {
      const code =
        "const sql = `EXISTS (SELECT 1 FROM transaction_attachments ta " +
        "WHERE ta.user_id = :userId)`;";
      expect(unreachedAttachmentSites(code)).toEqual([
        { file: "<source>", line: 1 },
      ]);
    });

    it("catches the old own-rows-only restriction on transaction_id", () => {
      // The form every consumer had before the ruling: it misses the receipt
      // on the row's warranty.
      const code =
        "const sql = `EXISTS (SELECT 1 FROM transaction_attachments ta " +
        "WHERE ta.transaction_id = t.id)`;";
      expect(unreachedAttachmentSites(code)).toEqual([
        { file: "<source>", line: 1 },
      ]);
    });

    it("catches a repository read restricted on transactionId alone", () => {
      const code =
        "const n = await m.getRepository(TransactionAttachment)\n" +
        '  .createQueryBuilder("ta")\n' +
        '  .where("ta.transactionId IN (:...ids)", { ids })\n' +
        "  .getRawMany();\n";
      expect(unreachedAttachmentSites(code)).toEqual([
        { file: "<source>", line: 1 },
      ]);
    });

    it("catches a reach into warranty_id spelled at the site", () => {
      // Names both columns and the warranties table, but with a predicate of
      // its own: the next edit to the rule would not reach it.
      const code =
        "const sql = `EXISTS (SELECT 1 FROM transaction_attachments ta " +
        "WHERE ta.transaction_id = t.id OR ta.warranty_id IN " +
        "(SELECT id FROM warranties WHERE transaction_id = t.id))`;";
      expect(unreachedAttachmentSites(code)).toEqual([
        { file: "<source>", line: 1 },
      ]);
    });

    it("accepts a raw EXISTS over the one-transaction fragment", () => {
      const code =
        "const sql = `EXISTS (SELECT 1 FROM transaction_attachments ta WHERE " +
        '${attachmentReachableFromTransactionSql("ta", "t.id")})`;';
      expect(unreachedAttachmentSites(code)).toEqual([]);
    });

    it("accepts a grouped read keyed by the reached transaction", () => {
      const code =
        "const rows = await m.getRepository(TransactionAttachment)\n" +
        '  .createQueryBuilder("ta")\n' +
        '  .leftJoin(Warranty, "w", reachingWarrantyJoinSql("ta", "w"))\n' +
        '  .where(`${reachedTransactionIdSql("ta", "w")} IN (:...ids)`, { ids })\n' +
        "  .getRawMany();\n";
      expect(unreachedAttachmentSites(code)).toEqual([]);
    });

    it("does not read a fragment call from the next statement", () => {
      // The reach has to be in the SAME statement; one that follows the
      // semicolon belongs to another query.
      const code =
        "const a = `SELECT 1 FROM transaction_attachments ta WHERE ta.user_id = $1`;\n" +
        'const b = attachmentReachableFromTransactionSql("ta", "t.id");\n';
      expect(unreachedAttachmentSites(code)).toEqual([
        { file: "<source>", line: 1 },
      ]);
    });

    it("ignores the table named in a comment", () => {
      const code =
        "// an EXISTS against transaction_attachments\n" +
        "/* getRepository(TransactionAttachment) is read elsewhere */\n" +
        "const x = 1;\n";
      expect(unreachedAttachmentSites(code)).toEqual([]);
    });

    it("reports the line of the offending site", () => {
      const code =
        "const ok = 1;\n" +
        "const bad = `SELECT 1 FROM transaction_attachments WHERE user_id = $1`;\n";
      expect(unreachedAttachmentSites(code)).toEqual([
        { file: "<source>", line: 2 },
      ]);
    });
  });
});
