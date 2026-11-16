import {
  classifyBackupFileName,
  isEncryptedBackupFileName,
  PARTIAL_TIER_NAME,
} from "./backup-file-names";

/**
 * The name is the artifact's identity: retention reads its tier from here, and
 * so does the owner-facing listing. The two used to be one function inside
 * retention, so a listing that grew its own regular expression would have been
 * free to admit something retention would never delete -- or to offer a file
 * for download that this module did not write.
 */
describe("classifyBackupFileName", () => {
  it.each([
    ["monize-backup-daily-2026-04-15.json.gz", "daily", "2026-04-15"],
    ["monize-backup-daily-2026-04-15.mzbe", "daily", "2026-04-15"],
    ["monize-backup-weekly-2026-04-14.json.gz", "weekly", "2026-04-14"],
    ["monize-backup-monthly-26-04.mzbe", "monthly", "2026-04-01"],
    [
      "monize-backup-partial-2026-04-15.json.gz",
      PARTIAL_TIER_NAME,
      "2026-04-15",
    ],
  ])("reads %s as a %s covering %s", (name, tier, day) => {
    expect(classifyBackupFileName(name)).toEqual({
      tier,
      date: new Date(`${day}T00:00:00Z`),
    });
  });

  it.each([
    ".monize-backup-daily-2026-04-15.json.gz.tmp-9f2",
    "monize-backup-daily-2026-04-15.json",
    "monize-backup-daily-2026-04-15.zip",
    "monize-backup-hourly-2026-04-15.json.gz",
    "monize-backup-daily-2026-04-15.json.gz.bak",
    "monize-support-backup-2026-04-15.mzbe",
    "notes.txt",
    "",
  ])("does not recognise %s", (name) => {
    expect(classifyBackupFileName(name)).toBeNull();
  });

  it("rejects a well-shaped name whose date is not a date", () => {
    // The shape matches; the value does not. Retention sorts on this date, so a
    // NaN here would order the whole tier arbitrarily.
    expect(
      classifyBackupFileName("monize-backup-daily-2026-13-45.json.gz"),
    ).toBeNull();
  });

  it("does not match a name that merely contains one", () => {
    expect(
      classifyBackupFileName("copy-of-monize-backup-daily-2026-04-15.json.gz"),
    ).toBeNull();
  });
});

describe("isEncryptedBackupFileName", () => {
  it("reads the envelope extension", () => {
    expect(
      isEncryptedBackupFileName("monize-backup-daily-2026-04-15.mzbe"),
    ).toBe(true);
    expect(
      isEncryptedBackupFileName("monize-backup-daily-2026-04-15.json.gz"),
    ).toBe(false);
  });
});
