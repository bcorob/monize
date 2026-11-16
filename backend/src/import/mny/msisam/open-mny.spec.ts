import {
  MNY_FIXTURES,
  MnyFixtureName,
  readMnyFixture,
} from "../__fixtures__/mny-fixtures";
import {
  MnyNotAMoneyFileError,
  MnyPasswordRequiredError,
  MnyUnreadableDatabaseError,
} from "../mny-errors";
import { JET_PAGE_SIZE } from "./jet-header";
import { decryptMsisamInPlace } from "./msisam-decrypt";
import {
  assertMoneyTables,
  openDecryptedMnyFile,
  openMnyFile,
} from "./open-mny";

function open(fixture: MnyFixtureName) {
  return openMnyFile(readMnyFixture(fixture), MNY_FIXTURES[fixture].password);
}

describe("openMnyFile", () => {
  it.each(Object.keys(MNY_FIXTURES) as MnyFixtureName[])(
    "reads the expected table list from %s",
    (fixture) => {
      const db = open(fixture);

      // Table counts come from jackcess-encrypt's own expectations for these
      // files, so a decryption regression surfaces here rather than as a
      // vague parse error later.
      expect(db.tableNames).toHaveLength(MNY_FIXTURES[fixture].tableCount);
      expect(db.hasTable("ACCT")).toBe(true);
      expect(db.hasTable("TRN")).toBe(true);
      expect(db.hasTable("CRNC")).toBe(true);
    },
  );

  it("reports the scheme and password state of the source file", () => {
    expect(open("money2001").scheme).toBe("old");
    expect(open("money2002").scheme).toBe("new-md5");

    const protectedFile = open("money2008Pwd");
    expect(protectedFile.scheme).toBe("new-sha1");
    expect(protectedFile.passwordProtected).toBe(true);
    expect(open("money2008").passwordProtected).toBe(false);
  });

  it("opens a Money 97-99 file with no decryption, ignoring a password", () => {
    const db = openMnyFile(readMnyFixture("money99"), "ignored");

    expect(db).toMatchObject({
      format: "jet3",
      scheme: "none",
      passwordProtected: false,
    });
    expect(open("money2008").format).toBe("msisam");
  });

  it("reopens a staged Money 97-99 file unchanged", () => {
    // `POST /parse` stages the bytes `openMnyFile` was handed; for a Jet 3 file
    // that is the upload itself, and the job reads it through this door.
    const staged = readMnyFixture("money99");
    openMnyFile(staged);

    const db = openDecryptedMnyFile(staged);

    expect(db.format).toBe("jet3");
    expect(db.getTableOrNull("TRN")?.rowCount).toBe(102);
  });

  it("refuses a Jet 3 database that does not have Money's tables", () => {
    expect(() => assertMoneyTables("jet3", ["Customers", "TRN"])).toThrow(
      MnyNotAMoneyFileError,
    );
    expect(() =>
      assertMoneyTables("jet3", ["ACCT", "TRN", "DHD"]),
    ).not.toThrow();
    // An MSISAM file is Money's by its engine name; table sets vary by version.
    expect(() => assertMoneyTables("msisam", [])).not.toThrow();
  });

  it("propagates password errors from the decryptor", () => {
    expect(() => openMnyFile(readMnyFixture("money2008Pwd"))).toThrow(
      MnyPasswordRequiredError,
    );
  });

  it("reports a decrypted but unparseable database distinctly", () => {
    const file = readMnyFixture("money2002");
    // Corrupt the catalogue page rather than the header, so decryption
    // succeeds and only the Jet structure is broken.
    file.fill(0xff, 2 * JET_PAGE_SIZE, 3 * JET_PAGE_SIZE);

    expect(() => openMnyFile(file)).toThrow(MnyUnreadableDatabaseError);
  });

  it("reports an unreadable table definition distinctly", () => {
    const file = readMnyFixture("money2002");
    // Page 15 is the first plaintext page and holds the ACCT table definition.
    // Corrupting it leaves the catalogue readable, so the failure surfaces on
    // the table read rather than on open.
    file.fill(0xff, 15 * JET_PAGE_SIZE, 16 * JET_PAGE_SIZE);
    const db = openMnyFile(file);

    expect(() => db.getTableOrNull("ACCT")).toThrow(MnyUnreadableDatabaseError);
  });

  it("reports an unreadable data page distinctly, not as a raw reader error", () => {
    const file = readMnyFixture("money2002");
    // Page 34 holds ACCT row data, not its definition: the catalogue and the
    // table definition both still read, and the failure only appears when rows
    // are pulled -- which is where a truncated upload of a large file lands.
    file.fill(0xab, 34 * JET_PAGE_SIZE, 35 * JET_PAGE_SIZE);
    const db = openMnyFile(file);
    const table = db.getTableOrNull("ACCT");

    // The regression this guards: `rows()` used to let mdb-reader's own
    // "Wrong page type" escape untyped, so `/import/mny/parse` 500'd with no
    // code for the wizard to act on, and a running job recorded the failure as
    // retryable -- offering Try again on a file that can never import.
    expect(() => table!.rows()).toThrow(MnyUnreadableDatabaseError);
    expect(() => table!.rows(["hacct"])).toThrow(MnyUnreadableDatabaseError);
  });

  describe("openDecryptedMnyFile", () => {
    it.each(Object.keys(MNY_FIXTURES) as MnyFixtureName[])(
      "re-opens %s after it has already been decrypted once",
      (fixture) => {
        // The wizard's real path: parse decrypts the upload in place, the same
        // buffer is staged as plaintext, and the import job re-parses it.
        const buffer = readMnyFixture(fixture);
        openMnyFile(buffer, MNY_FIXTURES[fixture].password);

        const reopened = openDecryptedMnyFile(buffer);

        expect(reopened.tableNames).toHaveLength(
          MNY_FIXTURES[fixture].tableCount,
        );
        expect(reopened.getTableOrNull("ACCT")!.rowCount).toBeGreaterThan(0);
      },
    );

    it("still reports the scheme and password state from page 0", () => {
      // Page 0 is never encrypted, so both survive the decrypt untouched.
      const buffer = readMnyFixture("money2008Pwd");
      openMnyFile(buffer, "Test12345");

      const reopened = openDecryptedMnyFile(buffer);

      expect(reopened.scheme).toBe("new-sha1");
      expect(reopened.passwordProtected).toBe(true);
    });

    it("reports an unprotected file as unprotected", () => {
      const buffer = readMnyFixture("money2001");
      openMnyFile(buffer);

      const reopened = openDecryptedMnyFile(buffer);

      expect(reopened.scheme).toBe("old");
      expect(reopened.passwordProtected).toBe(false);
    });

    it("guards the defect: decrypting a second time re-encrypts the file", () => {
      // RC4 is symmetric, so `openMnyFile` on already-plaintext bytes runs the
      // cipher back over pages 1..0xE. The only symptom is an unreadable page
      // structure from a layer that looks unrelated, which is why this needs a
      // test naming it rather than a comment.
      const buffer = readMnyFixture("money2001");
      openMnyFile(buffer);

      expect(() => openMnyFile(buffer)).toThrow(MnyUnreadableDatabaseError);
    });
  });

  it("returns null for a table the Money version does not have", () => {
    // Money 2001 predates scheduled bills; this absence crash-looped the
    // PR #192 proof of concept.
    const db = open("money2001");

    expect(db.hasTable("BILL")).toBe(false);
    expect(db.getTableOrNull("BILL")).toBeNull();
    expect(db.getTableOrNull("NoSuchTable")).toBeNull();
  });

  it("exposes BILL on Money 2002 and later", () => {
    expect(open("money2002").getTableOrNull("BILL")).not.toBeNull();
    expect(open("money2008").getTableOrNull("BILL")).not.toBeNull();
  });

  it("caches table handles", () => {
    const db = open("money2002");

    expect(db.getTableOrNull("ACCT")).toBe(db.getTableOrNull("ACCT"));
  });
});

describe("MnyTable", () => {
  it("exposes the column set of the file's version of the table", () => {
    const table = open("money2008").getTableOrNull("CRNC");

    expect(table?.name).toBe("CRNC");
    expect(table?.columnNames).toEqual(
      expect.arrayContaining(["hcrnc", "szIsoCode"]),
    );
    expect(table?.hasColumn("szIsoCode")).toBe(true);
    expect(table?.hasColumn("szNoSuchColumn")).toBe(false);
  });

  it("reads all columns by default", () => {
    const table = open("money2001").getTableOrNull("CRNC")!;

    const rows = table.rows();

    expect(rows).toHaveLength(table.rowCount);
    // jackcess-encrypt pins the first CRNC row of each fixture.
    expect(rows[0]).toMatchObject({ hcrnc: 1, szIsoCode: "ARS" });
  });

  it("drops requested columns the file does not have", () => {
    const table = open("money2008").getTableOrNull("CRNC")!;

    const rows = table.rows(["szIsoCode", "szNoSuchColumn"]);

    expect(rows[0]).toEqual({ szIsoCode: "ARS" });
  });

  it("still returns one row per record when no requested column exists", () => {
    const table = open("money2002").getTableOrNull("CRNC")!;

    const rows = table.rows(["szNoSuchColumn"]);

    expect(rows).toHaveLength(table.rowCount);
    expect(rows[0]).toEqual({});
  });

  it("reads the ACCT and TRN row counts of a Money 2002 file", () => {
    const db = open("money2002");

    expect(db.getTableOrNull("ACCT")?.rowCount).toBe(3);
    expect(db.getTableOrNull("TRN")?.rowCount).toBe(60);
  });
});

/**
 * `mdb-reader` writes into the buffer it reads, and a second read of those
 * bytes returns every currency value with its sign stripped -- row counts,
 * dates and text all stay correct, so nothing downstream looks wrong until a
 * ledger of pure credits arrives.
 *
 * The wizard reads a buffer twice by design: `POST /parse` reads the upload
 * and stages those same bytes, and the background job reads them again. That
 * shipped as "every imported transaction is a credit, including both sides of
 * a transfer", with account opening balances absolute too because they share
 * `toAmount`.
 *
 * These guard the mechanism rather than the symptom: no committed fixture has
 * a negative currency value, so an amount assertion would pass on the broken
 * reader. Buffer identity would not.
 */
describe("reading a .mny buffer leaves it reusable", () => {
  const TABLES = ["ACCT", "TRN", "CRNC", "PAY", "CAT"];

  function readEverything(db: ReturnType<typeof openDecryptedMnyFile>) {
    return TABLES.map((name) => db.getTableOrNull(name)?.rows() ?? null);
  }

  it.each(Object.keys(MNY_FIXTURES) as MnyFixtureName[])(
    "does not modify the bytes of %s while reading them",
    (fixture) => {
      const buffer = readMnyFixture(fixture);
      decryptMsisamInPlace(buffer, MNY_FIXTURES[fixture].password);
      const pristine = Buffer.from(buffer);

      readEverything(openDecryptedMnyFile(buffer));

      expect(Buffer.compare(buffer, pristine)).toBe(0);
    },
  );

  it.each(Object.keys(MNY_FIXTURES) as MnyFixtureName[])(
    "returns identical rows when %s is read a second time",
    (fixture) => {
      const buffer = readMnyFixture(fixture);
      decryptMsisamInPlace(buffer, MNY_FIXTURES[fixture].password);

      const first = readEverything(openDecryptedMnyFile(buffer));
      const second = readEverything(openDecryptedMnyFile(buffer));

      expect(second).toEqual(first);
    },
  );

  it("keeps the sign of a negative currency value on a re-read", () => {
    // Built here rather than taken from a fixture: the sample files happen to
    // hold no negative amount, which is exactly why this went unnoticed.
    const buffer = readMnyFixture("money2002");
    decryptMsisamInPlace(buffer, MNY_FIXTURES.money2002.password);

    const amounts = (db: ReturnType<typeof openDecryptedMnyFile>) =>
      (db.getTableOrNull("TRN")?.rows(["amt"]) ?? []).map((row) =>
        Number(row.amt),
      );

    const first = amounts(openDecryptedMnyFile(buffer));
    const second = amounts(openDecryptedMnyFile(buffer));

    expect(first.some((amount) => amount !== 0)).toBe(true);
    expect(second).toEqual(first);
  });
});
