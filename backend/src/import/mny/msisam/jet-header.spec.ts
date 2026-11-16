import { readMnyFixture } from "../__fixtures__/mny-fixtures";
import {
  MnyFileTruncatedError,
  MnyImportError,
  MnyNotAMoneyFileError,
  MnyUnsupportedVersionError,
} from "../mny-errors";
import {
  HEADER_MASK,
  JET_ENGINE_NAME,
  JET_PAGE_SIZE,
  MSISAM_ENGINE_NAME,
  OFFSET_ENGINE_NAME,
  OFFSET_MASKED_HEADER,
  OFFSET_SALT,
  OFFSET_VERSION_BYTE,
  VERSION_JET3,
  demaskHeaderPage,
  readMnyFileHeader,
} from "./jet-header";

/** Runs `fn` and returns the MnyImportError it throws. */
function caught(fn: () => unknown): MnyImportError {
  try {
    fn();
  } catch (error) {
    return error as MnyImportError;
  }
  throw new Error("expected the call to throw");
}

describe("demaskHeaderPage", () => {
  it("rejects a file shorter than one page", () => {
    const error = caught(() => demaskHeaderPage(Buffer.alloc(128)));

    expect(error).toBeInstanceOf(MnyFileTruncatedError);
    expect(error.code).toBe("mnyFileTruncated");
  });

  it("does not modify the source buffer", () => {
    const file = readMnyFixture("money2008");
    const before = Buffer.from(file.subarray(0, JET_PAGE_SIZE));

    demaskHeaderPage(file);

    expect(file.subarray(0, JET_PAGE_SIZE).equals(before)).toBe(true);
  });

  it("only rewrites the masked window", () => {
    const file = readMnyFixture("money2008");

    const page = demaskHeaderPage(file);

    expect(
      page
        .subarray(0, OFFSET_MASKED_HEADER)
        .equals(file.subarray(0, OFFSET_MASKED_HEADER)),
    ).toBe(true);
    const afterMask = OFFSET_MASKED_HEADER + HEADER_MASK.length;
    expect(
      page
        .subarray(afterMask, JET_PAGE_SIZE)
        .equals(file.subarray(afterMask, JET_PAGE_SIZE)),
    ).toBe(true);
  });

  it("is its own inverse", () => {
    const file = readMnyFixture("money2002");

    const twice = demaskHeaderPage(demaskHeaderPage(file));

    expect(twice.equals(file.subarray(0, JET_PAGE_SIZE))).toBe(true);
  });

  it("reveals a salt that differs between two otherwise identical files", () => {
    // money2008.mny and money2008-pwd.mny share every header byte except the
    // salt. Reading the salt from the raw file rather than the de-masked page
    // silently yields the wrong key and a file full of garbage pages.
    const plain = demaskHeaderPage(readMnyFixture("money2008"));
    const withPassword = demaskHeaderPage(readMnyFixture("money2008Pwd"));

    expect(plain[OFFSET_SALT]).not.toBe(withPassword[OFFSET_SALT]);
  });
});

describe("readMnyFileHeader", () => {
  it.each([
    ["money2001", "old", 0x01],
    ["money2001Pwd", "old", 0x01],
    ["money2002", "new-md5", 0x05],
    ["money2008", "new-sha1", 0x3d],
    ["money2008Pwd", "new-sha1", 0x3d],
  ] as const)("reads %s as the %s scheme", (fixture, scheme, flags) => {
    const header = readMnyFileHeader(readMnyFixture(fixture));

    expect(header.engineName).toBe(MSISAM_ENGINE_NAME);
    expect(header.versionByte).toBe(0x01);
    expect(header.encryptionFlags).toBe(flags);
    expect(header.scheme).toBe(scheme);
  });

  it("rejects a truncated file", () => {
    expect(() => readMnyFileHeader(Buffer.alloc(16))).toThrow(
      MnyFileTruncatedError,
    );
  });

  it("rejects a plain Access database", () => {
    // The engine name sits below the masked window, so it can be patched in
    // the raw file bytes.
    const file = readMnyFixture("money2008");
    file.write(JET_ENGINE_NAME, OFFSET_ENGINE_NAME, "latin1");

    const error = caught(() => readMnyFileHeader(file));

    expect(error).toBeInstanceOf(MnyNotAMoneyFileError);
    expect(error.code).toBe("mnyNotAMoneyFile");
    expect(error.message).toContain(JET_ENGINE_NAME);
  });

  it("rejects an MSISAM file that is not Jet 4", () => {
    const file = readMnyFixture("money2001");
    file[OFFSET_VERSION_BYTE] = VERSION_JET3;

    const error = caught(() => readMnyFileHeader(file));

    expect(error).toBeInstanceOf(MnyUnsupportedVersionError);
    expect(error.code).toBe("mnyUnsupportedVersion");
    expect(error.message).toContain("0x0");
  });

  it("reads a Money 97-99 file as an unencrypted Jet 3 database", () => {
    const header = readMnyFileHeader(readMnyFixture("money99"));

    expect(header).toMatchObject({
      engineName: JET_ENGINE_NAME,
      versionByte: VERSION_JET3,
      format: "jet3",
      scheme: "none",
    });
  });

  it("reads every Money 2001+ fixture as MSISAM", () => {
    expect(readMnyFileHeader(readMnyFixture("money2001")).format).toBe(
      "msisam",
    );
  });
});
