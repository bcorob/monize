import { readFileSync } from "fs";
import { join } from "path";
import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";

import { gitListFiles } from "./repo-tree.util";
import { TRANSACTION_NOTE_MAX_LENGTH } from "./transaction-note";
import { CreateTransactionDto } from "../transactions/dto/create-transaction.dto";
import { CreateTransactionSplitDto } from "../transactions/dto/create-transaction-split.dto";
import { PostScheduledTransactionDto } from "../scheduled-transactions/dto/post-scheduled-transaction.dto";

/**
 * The free-text note on a transaction has one length, on every path that writes
 * one and on both sides of the wire.
 *
 * It was written out twenty-three times -- fifteen DTO fields, five AI tool
 * schemas, three MCP ones -- and the frontend, which enforced it in exactly one
 * of nine forms. So the main transaction form let the user type past the limit
 * and the save came back a bare 400 with nothing pointing at the field, while
 * `BulkUpdateModal` (the one form with a `.max()`) said so properly. Raising the
 * cap from 500 to 750 is precisely the change that turns a set of copies into a
 * set of disagreements, which is why it lives in one constant now.
 */
const srcRoot = join(__dirname, "..");
const repoRoot = join(__dirname, "..", "..", "..");

const backendSources = (): string[] =>
  gitListFiles(srcRoot)
    .filter((file) => file.endsWith(".ts"))
    .filter((file) => !file.endsWith(".spec.ts"))
    .filter((file) => !file.endsWith("common/transaction-note.ts"));

/**
 * Where a transaction note is written. The scan is scoped to these rather than
 * run tree-wide, because `description` is the same word for a different thing
 * elsewhere: an account's, a budget's, a category's, a custom report's each cap
 * at their own length, and folding them into this constant would be asserting a
 * product decision nobody made.
 */
const NOTE_MODULES = [
  "transactions/",
  "scheduled-transactions/",
  "securities/dto/",
  "ai/query/",
  "mcp/tools/",
];

/** Inside those modules, the fields that are still not transaction notes. */
const NOT_A_TRANSACTION_NOTE: Record<string, string> = {
  "securities/dto/create-security.dto.ts":
    "the security's own profile text, usually filled from the quote provider",
};

const noteModuleSources = (): string[] =>
  backendSources()
    .filter((file) => NOTE_MODULES.some((module) => file.startsWith(module)))
    .filter((file) => !(file in NOT_A_TRANSACTION_NOTE));

/**
 * A cap spelled out on a `description` or `memo` field, in either dialect: a
 * `@MaxLength(<number>)` decorator above one, or a zod `.string().max(<number>)`
 * on a key of that name. By shape rather than by the literal `500`, so a copy
 * made with a different number fails too -- a second number is the defect, not
 * the old one specifically.
 */
const HAND_WRITTEN_DTO_CAP =
  /@MaxLength\(\s*\d+\s*\)(?:\s*@[A-Za-z]+\([^)]*\))*\s*(?:description|memo)\?:/;
const HAND_WRITTEN_ZOD_CAP =
  /\b(?:description|memo):\s*z\s*\.string\(\)\s*\.max\(\s*\d+\s*\)/;

/** Comments discuss the very shapes above; strip them before matching. */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, " "))
    .replace(
      /(^|[^:])\/\/[^\n]*/g,
      (match, before: string) =>
        before + " ".repeat(match.length - before.length),
    );
}

/** Decorators and zod chains wrap across lines; compare on one. */
const flattened = (source: string) =>
  withoutComments(source).replace(/\s+/g, " ");

describe("the transaction note length", () => {
  it("is spelled out nowhere but the constant", () => {
    const offenders = noteModuleSources().filter((file) => {
      const source = flattened(readFileSync(join(srcRoot, file), "utf8"));
      return (
        HAND_WRITTEN_DTO_CAP.test(source) || HAND_WRITTEN_ZOD_CAP.test(source)
      );
    });
    expect(offenders).toEqual([]);
  });

  it("keeps each exemption pointing at a field that really is something else", () => {
    // The other direction: a file excused from the scan must still be there,
    // and must still be capping a description of its own.
    const stale = Object.entries(NOT_A_TRANSACTION_NOTE)
      .filter(
        ([file]) =>
          !HAND_WRITTEN_DTO_CAP.test(
            flattened(readFileSync(join(srcRoot, file), "utf8")),
          ),
      )
      .map(([file, reason]) => `${file} (excused as: ${reason})`);
    expect(stale).toEqual([]);
  });

  it("is applied on every path that writes a note", () => {
    // The scan above only proves nobody wrote a number; this proves the
    // constant actually reached the fields, so removing a cap altogether
    // cannot pass by leaving no literal behind.
    const users = backendSources().filter((file) =>
      readFileSync(join(srcRoot, file), "utf8").includes(
        "TRANSACTION_NOTE_MAX_LENGTH",
      ),
    );
    expect(users).toEqual(
      expect.arrayContaining([
        "transactions/dto/create-transaction.dto.ts",
        "transactions/dto/create-transaction-split.dto.ts",
        "transactions/dto/create-transfer.dto.ts",
        "transactions/dto/update-transfer.dto.ts",
        "transactions/dto/bulk-update.dto.ts",
        "scheduled-transactions/dto/create-scheduled-transaction.dto.ts",
        "scheduled-transactions/dto/post-scheduled-transaction.dto.ts",
        "scheduled-transactions/dto/scheduled-transaction-override.dto.ts",
        "securities/dto/create-investment-transaction.dto.ts",
        // Both AI tool layers, which write the same field without a DTO.
        "ai/query/tool-input-schemas.ts",
        "mcp/tools/transactions.tool.ts",
        "mcp/tools/investments.tool.ts",
      ]),
    );
  });

  it("is what the validator actually enforces", () => {
    const at = (length: number) =>
      validateSync(
        plainToInstance(CreateTransactionDto, {
          accountId: "3f0b9a3e-2f5a-4a1f-8f4e-0f5d9c2b7a11",
          transactionDate: "2026-01-05",
          amount: -10,
          currencyCode: "CAD",
          description: "x".repeat(length),
        }),
      ).filter((error) => error.property === "description");

    expect(at(TRANSACTION_NOTE_MAX_LENGTH)).toEqual([]);
    expect(at(TRANSACTION_NOTE_MAX_LENGTH + 1)).not.toEqual([]);
  });

  it("is the same length for a split memo as for its parent", () => {
    // A split memo capped shorter than the description above it is a rejection
    // the user cannot see the reason for: the field they typed in looks the
    // same on both rows.
    const errors = validateSync(
      plainToInstance(CreateTransactionSplitDto, {
        amount: -10,
        memo: "x".repeat(TRANSACTION_NOTE_MAX_LENGTH),
      }),
    ).filter((error) => error.property === "memo");
    expect(errors).toEqual([]);
  });

  it("strips markup on the posting path too", () => {
    // `PostScheduledTransactionDto`'s memo and description had @MaxLength but no
    // @SanitizeHtml, so a note posted through a schedule kept its angle brackets
    // while the identical field on every sibling DTO had them stripped.
    const dto = plainToInstance(PostScheduledTransactionDto, {
      description: "<script>alert(1)</script>",
      splits: [{ categoryId: null, amount: -1, memo: "<b>x</b>" }],
    });
    expect(dto.description).toBe("scriptalert(1)/script");
    expect(dto.splits?.[0]?.memo).toBe("bx/b");
  });

  it("matches the number the frontend stops typing at", () => {
    // Two layers, one product decision. A frontend cap BELOW this one silently
    // truncates what a user may legitimately store; above it, the form accepts
    // text the save then rejects -- the defect this pair was added for.
    const frontend = readFileSync(
      join(repoRoot, "frontend/src/lib/transaction-note.ts"),
      "utf8",
    );
    const declared = frontend.match(/TRANSACTION_NOTE_MAX_LENGTH\s*=\s*(\d+)/);
    expect(declared).not.toBeNull();
    expect(Number(declared![1])).toBe(TRANSACTION_NOTE_MAX_LENGTH);
  });

  it("leaves the columns behind it unbounded, so the cap needs no migration", () => {
    // Every one of these is TEXT: the limit is a decision about how much a
    // person should type, not something the database is enforcing. If one ever
    // became VARCHAR(n), raising this constant would start failing on write.
    const schema = readFileSync(join(repoRoot, "database/schema.sql"), "utf8");
    const table = (name: string) =>
      schema.slice(
        schema.indexOf(`CREATE TABLE ${name} (`),
        schema.indexOf(");", schema.indexOf(`CREATE TABLE ${name} (`)),
      );
    expect(table("transactions")).toMatch(/^\s+description TEXT,?$/m);
    expect(table("transaction_splits")).toMatch(/^\s+memo TEXT,?$/m);
    expect(table("scheduled_transactions")).toMatch(/^\s+description TEXT,?$/m);
  });

  it("catches the shapes it bans, so the scan cannot pass by accident", () => {
    expect(
      HAND_WRITTEN_DTO_CAP.test(
        flattened("@MaxLength(500) @SanitizeHtml() description?: string;"),
      ),
    ).toBe(true);
    expect(
      HAND_WRITTEN_DTO_CAP.test(
        flattened("@MaxLength(750) memo?: string | null;"),
      ),
    ).toBe(true);
    expect(
      HAND_WRITTEN_ZOD_CAP.test(
        flattened("memo: z\n.string()\n.max(500)\n.optional()"),
      ),
    ).toBe(true);
    // A cap on a field that is not a note, and the constant form, both pass.
    expect(
      HAND_WRITTEN_DTO_CAP.test(flattened("@MaxLength(500) address?: string;")),
    ).toBe(false);
    expect(
      HAND_WRITTEN_DTO_CAP.test(
        flattened(
          "@MaxLength(TRANSACTION_NOTE_MAX_LENGTH) description?: string;",
        ),
      ),
    ).toBe(false);
  });
});
