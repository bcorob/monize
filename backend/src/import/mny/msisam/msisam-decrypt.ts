import { createHash } from "crypto";

import {
  MnyPasswordIncorrectError,
  MnyPasswordRequiredError,
} from "../mny-errors";
import {
  JET_PAGE_SIZE,
  LENGTH_ENGINE_NAME,
  MnyFileHeader,
  MsisamEncryptionScheme,
  OFFSET_CRYPT_CHECK_START,
  OFFSET_ENGINE_NAME,
  OFFSET_HEADER_DATE,
  OFFSET_PASSWORD,
  OFFSET_SALT,
  SIZE_CRYPT_CHECK,
  SIZE_PASSWORD,
  SIZE_SALT,
  readMnyFileHeader,
} from "./jet-header";
import { MnyFileFormat } from "../model/mny-money99";
import { rc4, rc4InPlace } from "./rc4";

/**
 * MSISAM (`.mny`) page decryption.
 *
 * Microsoft Money files are always encrypted, even when the user never set a
 * password -- a blank password feeds the same key derivation. Only file pages
 * 1..0xE are encrypted, so decrypting a 200 MB file is ~56 KB of cipher work.
 * Once those pages are plaintext the file is an ordinary Jet 4 database that
 * `mdb-reader` reads through its no-op MSISAM codec path.
 *
 * The algorithm is ported (not copied) from jackcess-encrypt's
 * `MSISAMCryptCodecHandler` and `JetCryptCodecHandler` (Apache-2.0).
 */

/** Highest file page that carries encrypted bytes. */
const MAX_ENCRYPTED_PAGE = 0x0e;
/** Password digest length; SHA-1 output is truncated to this. */
const PASSWORD_DIGEST_LENGTH = 0x10;
/** Length of the salt prefix reused in the per-page key. */
const BASE_SALT_LENGTH = 0x04;
/** Length of the Jet-style encoding key used by the "old" scheme. */
const ENCODING_KEY_LENGTH = 0x04;
/** Trailing header region the old scheme masks a second time. */
const TRAILING_PWD_LEN = 20;

export interface MsisamDecryptResult {
  /** The same buffer that was passed in, now holding plaintext pages. */
  readonly buffer: Buffer;
  /** `jet3` for Money 97-99, which this function leaves untouched. */
  readonly format: MnyFileFormat;
  /** Key-derivation scheme the file uses. */
  readonly scheme: MsisamEncryptionScheme;
  /** True when a non-blank password was needed to open the file. */
  readonly passwordProtected: boolean;
}

/**
 * Returns a copy of `key` with `pageNumber` XORed into the four bytes at
 * `offset`, which is how MSISAM and Jet derive a per-page RC4 key.
 */
function applyPageNumber(
  key: Buffer,
  offset: number,
  pageNumber: number,
): Buffer {
  const pageKey = Buffer.from(key);
  pageKey.writeInt32LE(pageNumber, offset);
  for (let i = offset; i < offset + 4; i++) {
    pageKey[i] ^= key[i];
  }
  return pageKey;
}

/**
 * Digests the password for the "new" scheme: uppercased, UTF-16LE, zero-padded
 * to 0x28 bytes, hashed with SHA-1 or MD5, truncated to 16 bytes.
 */
function passwordDigest(
  password: string,
  scheme: MsisamEncryptionScheme,
): Buffer {
  const padded = Buffer.alloc(SIZE_PASSWORD);
  const encoded = Buffer.from(password.toUpperCase(), "utf16le");
  encoded.copy(padded, 0, 0, Math.min(SIZE_PASSWORD, encoded.length));

  return createHash(scheme === "new-sha1" ? "sha1" : "md5")
    .update(padded)
    .digest()
    .subarray(0, PASSWORD_DIGEST_LENGTH);
}

/**
 * XOR-folds `data` into the four-byte `salt`, in place. Both steps of the old
 * scheme's key derivation use this.
 */
function hashSalt(salt: Buffer, data: Buffer): void {
  let hash = salt.readInt32LE(0);
  for (let pos = 0; pos < data.length; pos++) {
    hash = (hash ^ ((data[pos] & 0xff) << (pos % 0x18))) | 0;
  }
  salt.writeInt32LE(hash, 0);
}

/**
 * Derives the four-byte encoding key of the pre-2002 ("old") scheme. It uses
 * no password at all -- the key comes from the header's stored password field,
 * the creation-date mask and the engine-name string.
 */
function deriveOldEncodingKey(page: Buffer): Buffer {
  const encodingKey = Buffer.from(
    page.subarray(OFFSET_SALT, OFFSET_SALT + ENCODING_KEY_LENGTH),
  );

  const fullHashData = Buffer.from(
    page.subarray(OFFSET_PASSWORD, OFFSET_PASSWORD + SIZE_PASSWORD * 2),
  );
  const pwdMask = Buffer.alloc(4);
  pwdMask.writeInt32LE(
    Math.trunc(page.readDoubleLE(OFFSET_HEADER_DATE)) | 0,
    0,
  );

  for (let i = 0; i < SIZE_PASSWORD; i++) {
    fullHashData[i] ^= pwdMask[i % pwdMask.length];
  }
  const trailingOffset = fullHashData.length - TRAILING_PWD_LEN;
  for (let i = 0; i < TRAILING_PWD_LEN; i++) {
    fullHashData[trailingOffset + i] ^= pwdMask[i % pwdMask.length];
  }

  const hashData = Buffer.alloc(SIZE_PASSWORD);
  for (let pos = 0; pos < SIZE_PASSWORD; pos++) {
    hashData[pos] = fullHashData[pos * 2];
  }

  hashSalt(encodingKey, hashData);
  hashSalt(
    encodingKey,
    Buffer.from(
      page.subarray(
        OFFSET_ENGINE_NAME,
        OFFSET_ENGINE_NAME + LENGTH_ENGINE_NAME,
      ),
    ),
  );
  return encodingKey;
}

/** Reads the four crypt-check bytes, whose position is salt-dependent. */
function cryptCheckBytes(page: Buffer): Buffer {
  const offset = OFFSET_CRYPT_CHECK_START + page[OFFSET_SALT];
  return page.subarray(offset, offset + SIZE_CRYPT_CHECK);
}

/**
 * Verifies a candidate password for the "new" scheme by decrypting the check
 * bytes and comparing them against the salt prefix.
 */
function verifyPassword(
  page: Buffer,
  scheme: MsisamEncryptionScheme,
  password: string,
): boolean {
  const salt = page.subarray(OFFSET_SALT, OFFSET_SALT + SIZE_SALT);
  const testKey = Buffer.concat([passwordDigest(password, scheme), salt]);
  const decrypted = rc4(testKey, cryptCheckBytes(page));
  return decrypted.equals(salt.subarray(0, BASE_SALT_LENGTH));
}

/**
 * Resolves the password for a "new" scheme file and returns the per-page key
 * factory.
 *
 * Blank crypt-check bytes mean the file was never password protected. A file
 * with non-blank check bytes is not necessarily protected either -- Money Plus
 * writes them for unprotected files too, and they verify against the blank
 * password. Only when the blank password fails is a real password needed.
 */
function resolveNewSchemeKey(
  page: Buffer,
  scheme: MsisamEncryptionScheme,
  password: string | undefined,
): { keyFor: (pageNumber: number) => Buffer; passwordProtected: boolean } {
  const hasCheckBytes = cryptCheckBytes(page).some((byte) => byte !== 0);
  const passwordProtected = hasCheckBytes && !verifyPassword(page, scheme, "");

  let effectivePassword = "";
  if (passwordProtected) {
    if (!password) {
      throw new MnyPasswordRequiredError();
    }
    if (!verifyPassword(page, scheme, password)) {
      throw new MnyPasswordIncorrectError();
    }
    effectivePassword = password;
  }

  const digest = passwordDigest(effectivePassword, scheme);
  const baseHash = Buffer.concat([
    digest,
    page.subarray(OFFSET_SALT, OFFSET_SALT + BASE_SALT_LENGTH),
  ]);

  return {
    keyFor: (pageNumber) =>
      applyPageNumber(baseHash, PASSWORD_DIGEST_LENGTH, pageNumber),
    passwordProtected,
  };
}

/**
 * Reads a file's encryption scheme and password state **without touching a
 * byte of it**.
 *
 * This is what a buffer that has already been decrypted needs: page 0 is never
 * encrypted, so the scheme and the crypt-check verification are still readable
 * from plaintext bytes, and the pages that would be ruined by a second RC4 pass
 * are left alone.
 */
export function readMsisamMetadata(buffer: Buffer): {
  scheme: MsisamEncryptionScheme;
  passwordProtected: boolean;
  format: MnyFileFormat;
} {
  const header = readMnyFileHeader(buffer);
  if (header.scheme === "old" || header.scheme === "none") {
    // The pre-2002 scheme derives its key from the header and uses no password
    // at all, and a Money 97-99 file is not MSISAM-encrypted, so neither is
    // ever password protected.
    return {
      scheme: header.scheme,
      passwordProtected: false,
      format: header.format,
    };
  }

  const hasCheckBytes = cryptCheckBytes(header.page).some((byte) => byte !== 0);
  return {
    format: header.format,
    scheme: header.scheme,
    passwordProtected:
      hasCheckBytes && !verifyPassword(header.page, header.scheme, ""),
  };
}

/**
 * Decrypts the encrypted pages of a `.mny` file **in place** and returns the
 * same buffer, now readable as a plain Jet 4 database.
 *
 * Call this **once** per buffer. RC4 is symmetric, so a second pass over an
 * already-decrypted buffer re-encrypts it, and the only symptom is an
 * unreadable page structure several layers away. Use `readMsisamMetadata` and
 * `openDecryptedMnyFile` for a buffer that has already been through here.
 *
 * The caller hands over ownership of `buffer`; nothing else may hold a
 * reference to it. Decrypting in place is deliberate (ADR-6): it keeps peak
 * memory at one copy of the file rather than two, and only 14 pages are ever
 * written.
 *
 * @param password Money file password, if the user supplied one. Never logged.
 * @throws MnyImportError subclasses for every unreadable-file condition
 */
export function decryptMsisamInPlace(
  buffer: Buffer,
  password?: string,
): MsisamDecryptResult {
  const header: MnyFileHeader = readMnyFileHeader(buffer);
  if (header.format === "jet3") {
    // Money 97-99 write a plain Jet 3 database: there is nothing to decrypt,
    // and a supplied password is ignored rather than rejected.
    return {
      buffer,
      format: header.format,
      scheme: header.scheme,
      passwordProtected: false,
    };
  }

  let keyFor: (pageNumber: number) => Buffer;
  let passwordProtected = false;

  if (header.scheme === "old") {
    // Pre-2002 files derive the key from the header alone; any supplied
    // password is irrelevant and is ignored rather than rejected.
    const encodingKey = deriveOldEncodingKey(header.page);
    keyFor = (pageNumber) => applyPageNumber(encodingKey, 0, pageNumber);
  } else {
    const resolved = resolveNewSchemeKey(header.page, header.scheme, password);
    keyFor = resolved.keyFor;
    passwordProtected = resolved.passwordProtected;
  }

  const lastPage = Math.min(
    MAX_ENCRYPTED_PAGE,
    Math.ceil(buffer.length / JET_PAGE_SIZE) - 1,
  );
  for (let pageNumber = 1; pageNumber <= lastPage; pageNumber++) {
    const start = pageNumber * JET_PAGE_SIZE;
    rc4InPlace(
      keyFor(pageNumber),
      buffer.subarray(start, start + JET_PAGE_SIZE),
    );
  }

  return {
    buffer,
    format: header.format,
    scheme: header.scheme,
    passwordProtected,
  };
}
