import { readFileSync } from "fs";
import { join } from "path";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { getMetadataArgsStorage } from "typeorm";

import { DOCUMENT_KINDS } from "./attachment-parent";
import { UpdateDocumentKindDto } from "./dto/update-document-kind.dto";
import { WarrantyAttachmentUploadDto } from "./dto/warranty-attachment-upload.dto";
import { TransactionAttachment } from "./entities/transaction-attachment.entity";

/**
 * `DOCUMENT_KINDS` is one list, and this is where that is checked: the
 * `chk_attachment_document_kind` CHECK in `database/schema.sql` and the copy
 * of it on the entity's `@Check` are the lists the database accepts, and each
 * is compared with the constant in both directions. A kind the DTOs admit and
 * the database refuses fails an upload at runtime; a kind the database admits
 * and the constant does not know cannot be chosen or labelled.
 */

const SCHEMA_PATH = join(__dirname, "..", "..", "..", "database", "schema.sql");

const CHECK_PATTERN =
  /CONSTRAINT\s+chk_attachment_document_kind\s+CHECK\s*\(\s*document_kind\s+IN\s*\(([^)]*)\)\s*\)/i;

function kindsIn(list: string): string[] {
  return [...list.matchAll(/'([^']*)'/g)].map((m) => m[1]).sort();
}

describe("DOCUMENT_KINDS", () => {
  const expected = [...DOCUMENT_KINDS].sort();

  it("matches chk_attachment_document_kind in database/schema.sql", () => {
    const match = CHECK_PATTERN.exec(readFileSync(SCHEMA_PATH, "utf8"));
    if (!match) {
      throw new Error(
        "No `CONSTRAINT chk_attachment_document_kind CHECK (document_kind IN " +
          "(...))` found in database/schema.sql. The constraint was renamed or " +
          "reworded; update this parser, or this guard is checking nothing.",
      );
    }
    expect(kindsIn(match[1])).toEqual(expected);
  });

  it("matches the entity's @Check", () => {
    const check = getMetadataArgsStorage().checks.find(
      (c) =>
        c.target === TransactionAttachment &&
        c.name === "chk_attachment_document_kind",
    );
    expect(check).toBeDefined();
    expect(kindsIn(check?.expression ?? "")).toEqual(expected);
  });

  it("includes the warranty certificate, in picker order", () => {
    expect(DOCUMENT_KINDS).toEqual([
      "receipt",
      "manual",
      "photo",
      "warranty",
      "other",
    ]);
  });

  it.each(DOCUMENT_KINDS)("is accepted by both DTOs: %s", async (kind) => {
    const update = plainToInstance(UpdateDocumentKindDto, {
      documentKind: kind,
    });
    const upload = plainToInstance(WarrantyAttachmentUploadDto, {
      documentKind: kind,
    });
    expect(await validate(update)).toEqual([]);
    expect(await validate(upload)).toEqual([]);
  });

  it("refuses a kind outside the list", async () => {
    const update = plainToInstance(UpdateDocumentKindDto, {
      documentKind: "certificate",
    });
    const upload = plainToInstance(WarrantyAttachmentUploadDto, {
      documentKind: "certificate",
    });
    expect(await validate(update)).toHaveLength(1);
    expect(await validate(upload)).toHaveLength(1);
  });
});
