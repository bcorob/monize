import * as crypto from "crypto";
import { promisify } from "util";

/**
 * The encrypted-backup envelope, shared by both container versions.
 *
 * Monize has two, and the second exists because the first cannot stream:
 *
 * ```
 * v1 (monolithic)
 *   bytes  0..3   magic       "MZBE"
 *   byte   4      version     0x01
 *   byte   5      kdf         0x01 = scrypt
 *   bytes  6..21  salt        16 bytes
 *   bytes 22..33  iv          12 bytes
 *   bytes 34..49  authTag     16 bytes
 *   bytes 50..    ciphertext  gzip(JSON)
 *
 * v2 (framed)
 *   bytes  0..3   magic       "MZBE"
 *   byte   4      version     0x02
 *   byte   5      kdf         0x01 = scrypt
 *   bytes  6..21  salt        16 bytes
 *   bytes 22..28  noncePrefix 7 bytes
 *   bytes 29..    frames      [uint32 BE length][ciphertext||tag] ...
 *
 * v3 (framed, key-wrapped)
 *   bytes  0..3   magic       "MZBE"
 *   byte   4      version     0x03
 *   byte   5      kdf         0x01 = scrypt
 *   bytes  6..81  wrappedKey  salt(16) iv(12) tag(16) wrappedDataKey(32)
 *   bytes 82..97  keySalt     16 bytes
 *   bytes 98..104 noncePrefix 7 bytes
 *   bytes 105..   frames      [uint32 BE length][ciphertext||tag] ...
 * ```
 *
 * A v1 auth tag covers the whole payload, so it cannot be computed until the last
 * byte of plaintext exists -- which is why the encrypted export buffered the
 * entire artifact in memory (issue #1070). v2 authenticates each frame on its
 * own, so the writer can emit as it goes.
 *
 * Every field a v2 frame needs to be unambiguous is in its nonce, following the
 * STREAM construction: `noncePrefix || counter || finalFlag`. A frame therefore
 * cannot be reordered (the counter is different), duplicated (likewise), moved
 * into another file (the prefix and the key are different), or dropped from the
 * end -- the frame that would become last was sealed with `finalFlag = 0` and is
 * opened expecting `1`. Truncation is the attack a naive chunked format gets
 * wrong: without the flag, half a backup decrypts cleanly and restores as if it
 * were the whole thing.
 *
 * The header is additional authenticated data for every frame, so the salt and
 * the prefix cannot be swapped either.
 *
 * v3 is v2's frames under a random per-user data key instead of a key derived
 * from the password, with that data key wrapped under the password in the
 * header (`backup-key-wrap.ts`). It exists so the automatic backup can be
 * encrypted by a cron that holds the data key and never the password, while the
 * file still opens with the password alone (docs/specs/backup-envelope-key-wrapping.md).
 */

/**
 * scrypt at N=32768 takes roughly 100ms of pure CPU. `scryptSync` spent that on
 * the event loop, and a restore tries up to three candidate passwords -- so one
 * request stalled every other request in the process for about a third of a
 * second. The async form runs the derivation on the libuv threadpool instead.
 */
const scryptAsync = promisify(crypto.scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: crypto.ScryptOptions,
) => Promise<Buffer>;

export const MAGIC = Buffer.from("MZBE", "ascii");
/** Monolithic AES-256-GCM over the whole payload. Still written by the support export. */
export const VERSION_MONOLITHIC = 0x01;
/** Framed AES-256-GCM, written by every streaming export under a typed password. */
export const VERSION_FRAMED = 0x02;
/** Framed AES-256-GCM under a password-wrapped data key, written by the automatic backup. */
export const VERSION_KEY_WRAPPED = 0x03;
export const KDF_SCRYPT = 0x01;
export const SALT_LENGTH = 16;
export const IV_LENGTH = 12;
export const TAG_LENGTH = 16;
export const NONCE_PREFIX_LENGTH = 7;
/** Frame counter (4) + final flag (1) fill the rest of the 12-byte GCM nonce. */
export const FRAME_COUNTER_LENGTH = 4;
export const FRAME_LENGTH_BYTES = 4;
/** A data key, and the key a password derives to wrap it. */
export const DATA_KEY_LENGTH = 32;
/** salt || iv || tag || wrapped data key. */
export const WRAPPED_KEY_LENGTH =
  SALT_LENGTH + IV_LENGTH + TAG_LENGTH + DATA_KEY_LENGTH;
/** HKDF salt deriving one file's frame key from the data key. */
export const KEY_SALT_LENGTH = 16;

export const MONOLITHIC_HEADER_LENGTH =
  MAGIC.length + 2 + SALT_LENGTH + IV_LENGTH + TAG_LENGTH;
export const FRAMED_HEADER_LENGTH =
  MAGIC.length + 2 + SALT_LENGTH + NONCE_PREFIX_LENGTH;
export const KEY_WRAPPED_HEADER_LENGTH =
  MAGIC.length + 2 + WRAPPED_KEY_LENGTH + KEY_SALT_LENGTH + NONCE_PREFIX_LENGTH;

const KEY_LENGTH = DATA_KEY_LENGTH;
const SCRYPT_N = 1 << 15; // 32768; tuned for ~100ms on modern hardware
const SCRYPT_R = 8;
const SCRYPT_P = 1;

export function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
  return scryptAsync(password, salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 64 * 1024 * 1024,
  });
}

export class BackupDecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackupDecryptionError";
  }
}

/**
 * The envelope version `buf` carries, or null if it is not a Monize envelope.
 *
 * `Buffer.isBuffer` guard is defensive: Express body-parser may deliver a string
 * or parsed JSON object depending on upstream middleware, and CodeQL's taint flow
 * flags `.length` access on the untyped form. Narrow here so callers can trust
 * the typed signature.
 */
export function backupEnvelopeVersion(buf: Buffer): number | null {
  // CodeQL js/type-confusion-through-parameter-tampering: it doesn't model
  // Buffer.isBuffer as a type guard, so narrow with the typeof/Array.isArray
  // checks the rule recognises before accessing .length.
  if (typeof buf === "string" || Array.isArray(buf)) return null;
  if (!Buffer.isBuffer(buf)) return null;
  if (buf.length < FRAMED_HEADER_LENGTH) return null;
  if (!buf.subarray(0, MAGIC.length).equals(MAGIC)) return null;
  const version = buf[MAGIC.length];
  if (version === VERSION_FRAMED) return VERSION_FRAMED;
  if (version === VERSION_KEY_WRAPPED) {
    return buf.length >= KEY_WRAPPED_HEADER_LENGTH ? VERSION_KEY_WRAPPED : null;
  }
  if (version === VERSION_MONOLITHIC) {
    // A v1 envelope shorter than its own header is not a v1 envelope.
    return buf.length >= MONOLITHIC_HEADER_LENGTH ? VERSION_MONOLITHIC : null;
  }
  return null;
}

/**
 * The 12-byte GCM nonce for frame `counter`.
 *
 * `final` is part of the nonce rather than of the AAD so that a truncated stream
 * fails to authenticate rather than merely failing a length check somebody might
 * later decide to relax.
 */
export function frameNonce(
  prefix: Buffer,
  counter: number,
  final: boolean,
): Buffer {
  const nonce = Buffer.alloc(IV_LENGTH);
  prefix.copy(nonce, 0, 0, NONCE_PREFIX_LENGTH);
  nonce.writeUInt32BE(counter, NONCE_PREFIX_LENGTH);
  nonce[NONCE_PREFIX_LENGTH + FRAME_COUNTER_LENGTH] = final ? 1 : 0;
  return nonce;
}

/** The framed header, which is also the AAD every frame is sealed against. */
export function framedHeader(salt: Buffer, noncePrefix: Buffer): Buffer {
  return Buffer.concat([
    MAGIC,
    Buffer.from([VERSION_FRAMED, KDF_SCRYPT]),
    salt,
    noncePrefix,
  ]);
}

/** Reads the kdf byte, refusing anything this build cannot derive a key with. */
export function assertSupportedKdf(envelope: Buffer): void {
  const kdf = envelope[MAGIC.length + 1];
  if (kdf !== KDF_SCRYPT) {
    throw new BackupDecryptionError(
      `Unsupported key derivation function: ${kdf}`,
    );
  }
}
