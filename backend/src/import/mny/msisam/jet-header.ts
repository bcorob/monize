import {
  MnyFileTruncatedError,
  MnyNotAMoneyFileError,
  MnyUnsupportedVersionError,
} from "../mny-errors";
import { MnyFileFormat } from "../model/mny-money99";

/**
 * Jet 4 / MSISAM database-definition page (page 0) decoding.
 *
 * A `.mny` file is a Jet 4 page-structured database whose engine name reads
 * "MSISAM Database" instead of "Standard Jet DB". Page 0 carries the crypto
 * parameters, but bytes 0x18..0x95 of it are obfuscated with a fixed mask --
 * every offset in that window (the salt at 0x72 included) must be read from
 * the de-masked copy, never from the raw file bytes.
 *
 * Offsets and the mask table follow jackcess (Apache-2.0) `JetFormat`,
 * `PageChannel.applyHeaderMask` and jackcess-encrypt `MSISAMCryptCodecHandler`.
 */

/** Jet 4 page size. MSISAM files are always Jet 4. */
export const JET_PAGE_SIZE = 4096;

export const OFFSET_ENGINE_NAME = 0x04;
export const LENGTH_ENGINE_NAME = 0x0f;
export const OFFSET_VERSION_BYTE = 0x14;
export const OFFSET_MASKED_HEADER = 0x18;
export const OFFSET_PASSWORD = 0x42;
export const SIZE_PASSWORD = 0x28;
export const OFFSET_HEADER_DATE = 0x72;
/** MSISAM reuses the creation-date field as its 8-byte crypto salt. */
export const OFFSET_SALT = 0x72;
export const SIZE_SALT = 8;
export const OFFSET_ENCRYPTION_FLAGS = 0x298;
export const OFFSET_CRYPT_CHECK_START = 0x2e9;
export const SIZE_CRYPT_CHECK = 4;

/** Engine-name string that identifies a Microsoft Money database. */
export const MSISAM_ENGINE_NAME = "MSISAM Database";
/** Engine-name string of a plain Access database. */
export const JET_ENGINE_NAME = "Standard Jet DB";

/**
 * Version byte of Jet 3 files. Money 97-99 write a plain, unencrypted Jet 3
 * database under the Access engine name; `mdb-reader` reads it directly.
 */
export const VERSION_JET3 = 0x00;
/** Version byte of Jet 4 files -- Money 2001 through Money Plus Sunset. */
export const VERSION_JET4 = 0x01;

/** Bit in the encryption flags marking the hash-based ("new") MSISAM scheme. */
export const FLAG_NEW_ENCRYPTION = 0x06;
/** Bit selecting SHA-1 over MD5 for the password digest. */
export const FLAG_USE_SHA1 = 0x20;

/**
 * Fixed mask applied to page-0 bytes 0x18..0x95, from jackcess
 * `JetFormat.BASE_HEADER_MASK`.
 */
export const HEADER_MASK = Buffer.from([
  0xb5, 0x6f, 0x03, 0x62, 0x61, 0x08, 0xc2, 0x55, 0xeb, 0xa9, 0x67, 0x72, 0x43,
  0x3f, 0x00, 0x9c, 0x7a, 0x9f, 0x90, 0xff, 0x80, 0x9a, 0x31, 0xc5, 0x79, 0xba,
  0xed, 0x30, 0xbc, 0xdf, 0xcc, 0x9d, 0x63, 0xd9, 0xe4, 0xc3, 0x7b, 0x42, 0xfb,
  0x8a, 0xbc, 0x4e, 0x86, 0xfb, 0xec, 0x37, 0x5d, 0x44, 0x9c, 0xfa, 0xc6, 0x5e,
  0x28, 0xe6, 0x13, 0xb6, 0x8a, 0x60, 0x54, 0x94, 0x7b, 0x36, 0xf5, 0x72, 0xdf,
  0xb1, 0x77, 0xf4, 0x13, 0x43, 0xcf, 0xaf, 0xb1, 0x33, 0x34, 0x61, 0x79, 0x5b,
  0x92, 0xb5, 0x7c, 0x2a, 0x05, 0xf1, 0x7c, 0x99, 0x01, 0x1b, 0x98, 0xfd, 0x12,
  0x4f, 0x4a, 0x94, 0x6c, 0x3e, 0x60, 0x26, 0x5f, 0x95, 0xf8, 0xd0, 0x89, 0x24,
  0x85, 0x67, 0xc6, 0x1f, 0x27, 0x44, 0xd2, 0xee, 0xcf, 0x65, 0xed, 0xff, 0x07,
  0xc7, 0x46, 0xa1, 0x78, 0x16, 0x0c, 0xed, 0xe9, 0x2d, 0x62, 0xd4,
]);

/**
 * Which of the two MSISAM key-derivation schemes a file uses, or `none` for a
 * Money 97-99 file, which is not MSISAM-encrypted at all.
 */
export type MsisamEncryptionScheme = "new-sha1" | "new-md5" | "old" | "none";

export interface MnyFileHeader {
  /** Engine-name string at offset 0x04, e.g. "MSISAM Database". */
  readonly engineName: string;
  /** Format version byte at offset 0x14. */
  readonly versionByte: number;
  /** Raw encryption flags byte at offset 0x298. */
  readonly encryptionFlags: number;
  /** Key-derivation scheme implied by the flags. */
  readonly scheme: MsisamEncryptionScheme;
  /** `jet3` for Money 97-99, `msisam` for Money 2001 onwards. */
  readonly format: MnyFileFormat;
  /** De-masked copy of page 0. Every crypto offset is read from this. */
  readonly page: Buffer;
}

/**
 * Returns a de-masked copy of page 0. The input file buffer is not modified.
 */
export function demaskHeaderPage(file: Buffer): Buffer {
  if (file.length < JET_PAGE_SIZE) {
    throw new MnyFileTruncatedError(file.length, JET_PAGE_SIZE);
  }

  const page = Buffer.from(file.subarray(0, JET_PAGE_SIZE));
  for (let i = 0; i < HEADER_MASK.length; i++) {
    page[OFFSET_MASKED_HEADER + i] ^= HEADER_MASK[i];
  }
  return page;
}

function readEngineName(page: Buffer): string {
  return page
    .toString(
      "latin1",
      OFFSET_ENGINE_NAME,
      OFFSET_ENGINE_NAME + LENGTH_ENGINE_NAME,
    )
    .replace(/\0+$/, "");
}

function schemeFor(encryptionFlags: number): MsisamEncryptionScheme {
  if ((encryptionFlags & FLAG_NEW_ENCRYPTION) === 0) {
    return "old";
  }
  return (encryptionFlags & FLAG_USE_SHA1) !== 0 ? "new-sha1" : "new-md5";
}

/**
 * Parses and validates the header page of a `.mny` file.
 *
 * @throws MnyFileTruncatedError when the file is shorter than one page
 * A Money 97-99 file carries the plain Access engine name and the Jet 3
 * version byte, exactly as an Access 97 `.mdb` does; `openMnyFile` tells the
 * two apart by Money's tables once the file is open.
 *
 * @throws MnyNotAMoneyFileError when the engine name is neither MSISAM nor a
 *   Jet 3 Access database
 * @throws MnyUnsupportedVersionError for an MSISAM file that is not Jet 4
 */
export function readMnyFileHeader(file: Buffer): MnyFileHeader {
  const page = demaskHeaderPage(file);
  const engineName = readEngineName(page);

  if (
    engineName === JET_ENGINE_NAME &&
    page[OFFSET_VERSION_BYTE] === VERSION_JET3
  ) {
    return {
      engineName,
      versionByte: VERSION_JET3,
      encryptionFlags: 0,
      scheme: "none",
      format: "jet3",
      page,
    };
  }

  if (engineName !== MSISAM_ENGINE_NAME) {
    throw new MnyNotAMoneyFileError(engineName);
  }

  const versionByte = page[OFFSET_VERSION_BYTE];
  if (versionByte !== VERSION_JET4) {
    throw new MnyUnsupportedVersionError(versionByte);
  }

  const encryptionFlags = page[OFFSET_ENCRYPTION_FLAGS];

  return {
    engineName,
    versionByte,
    encryptionFlags,
    scheme: schemeFor(encryptionFlags),
    format: "msisam",
    page,
  };
}
