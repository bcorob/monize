import * as crypto from "crypto";
import { Transform, TransformCallback } from "stream";
import {
  assertSupportedKdf,
  BackupDecryptionError,
  deriveKey,
  FRAME_LENGTH_BYTES,
  FRAMED_HEADER_LENGTH,
  frameNonce,
  framedHeader,
  MAGIC,
  NONCE_PREFIX_LENGTH,
  SALT_LENGTH,
  TAG_LENGTH,
} from "./backup-envelope";

/**
 * The framed (v2) encrypted-backup container: an AES-256-GCM stream the export
 * can write as it goes.
 *
 * AES-GCM's auth tag covers the whole message, so a single-tag envelope cannot be
 * emitted until the last byte of plaintext is known -- which is why the encrypted
 * export held the entire artifact in memory and why the memory ceiling that
 * refused large encrypted exports existed at all (issue #1070). Sealing fixed-size
 * frames instead makes the ciphertext writable incrementally, at the cost of 20
 * bytes per frame and a construction that has to defend the boundaries between
 * them. `backup-envelope.ts` documents the format and what each field defends.
 */

/**
 * Plaintext per frame. 256 KiB keeps the per-frame overhead under 0.01% and keeps
 * the writer's resident buffer to a quarter of a megabyte.
 */
export const FRAME_PLAINTEXT_BYTES = 256 * 1024;

/**
 * Largest frame a decoder will accept, so a hostile envelope cannot ask for an
 * allocation by declaring one. Generously above what the writer emits, because a
 * future writer may choose a larger frame and old files must still open.
 */
export const MAX_FRAME_CIPHERTEXT_BYTES = 16 * 1024 * 1024;

/**
 * A Transform that turns plaintext into a v2 envelope.
 *
 * The key is derived before the stream is built (scrypt is ~100ms and belongs on
 * the threadpool, not in a `_transform`), so this is `async` -- callers await the
 * transform, then pipe into it.
 */
export async function createBackupEncryptStream(
  password: string,
): Promise<Transform> {
  if (!password) {
    throw new Error("Backup encryption requires a non-empty password");
  }
  const salt = crypto.randomBytes(SALT_LENGTH);
  const noncePrefix = crypto.randomBytes(NONCE_PREFIX_LENGTH);
  const key = await deriveKey(password, salt);
  return createFramedEncryptStream(
    key,
    framedHeader(salt, noncePrefix),
    noncePrefix,
  );
}

/**
 * The frame sealer both framed versions share: `header` goes out first and is
 * the AAD of every frame, and `key` seals them. v2 derives `key` from the
 * password; v3 (`backup-key-wrap.ts`) derives it from a wrapped data key.
 */
export function createFramedEncryptStream(
  key: Buffer,
  header: Buffer,
  noncePrefix: Buffer,
): Transform {
  // Pending plaintext, at most one frame's worth. A local buffer that never
  // escapes this closure: the whole point of the format is that nothing else
  // accumulates.
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  let counter = 0;

  const sealFrame = (plaintext: Buffer, final: boolean): Buffer => {
    const cipher = crypto.createCipheriv(
      "aes-256-gcm",
      key,
      frameNonce(noncePrefix, counter, final),
    );
    cipher.setAAD(header);
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const length = Buffer.alloc(FRAME_LENGTH_BYTES);
    length.writeUInt32BE(body.length + TAG_LENGTH, 0);
    counter += 1;
    return Buffer.concat([length, body, cipher.getAuthTag()]);
  };

  const drainFullFrames = (stream: Transform): void => {
    while (pendingBytes >= FRAME_PLAINTEXT_BYTES) {
      const joined = Buffer.concat(pending, pendingBytes);
      stream.push(sealFrame(joined.subarray(0, FRAME_PLAINTEXT_BYTES), false));
      const rest = joined.subarray(FRAME_PLAINTEXT_BYTES);
      pending = rest.length > 0 ? [rest] : [];
      pendingBytes = rest.length;
    }
  };

  const framer = new Transform({
    transform(chunk: Buffer, _encoding, done: TransformCallback) {
      pending.push(chunk);
      pendingBytes += chunk.length;
      try {
        drainFullFrames(this);
      } catch (error) {
        done(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      done();
    },
    flush(done: TransformCallback) {
      try {
        // Always exactly one final frame, even for an empty payload: a file with
        // no final frame is a file whose end nothing authenticates.
        this.push(sealFrame(Buffer.concat(pending, pendingBytes), true));
        pending = [];
        pendingBytes = 0;
        done();
      } catch (error) {
        done(error instanceof Error ? error : new Error(String(error)));
      }
    },
  });

  // The header is not encrypted and does not depend on the payload, so it can go
  // out immediately; it sits in the transform's readable buffer until whatever
  // consumes the stream is attached.
  framer.push(header);
  return framer;
}

/**
 * Opens a v2 envelope held in memory.
 *
 * The restore already has the whole upload on the heap -- `express.raw` buffers
 * it before any of our code runs -- so decryption is not where the streaming
 * problem is, and this returns a Buffer like its v1 counterpart. What it must get
 * right is refusing anything the format does not guarantee: a short frame, a
 * declared length that does not fit, trailing bytes after the final frame, or a
 * stream with no final frame at all.
 */
export async function decryptFramedBackup(
  envelope: Buffer,
  password: string,
): Promise<Buffer> {
  assertSupportedKdf(envelope);
  let offset = MAGIC.length + 2;
  const salt = envelope.subarray(offset, offset + SALT_LENGTH);
  offset += SALT_LENGTH;
  const noncePrefix = envelope.subarray(offset, offset + NONCE_PREFIX_LENGTH);
  const header = envelope.subarray(0, FRAMED_HEADER_LENGTH);

  // Frame boundaries are read before any key is derived: a malformed envelope
  // must not cost 100ms of scrypt to reject.
  const frames = readFrameBoundaries(envelope, FRAMED_HEADER_LENGTH);
  const key = await deriveKey(password, salt);
  return openFrames(envelope, frames, key, header, noncePrefix);
}

export interface FrameBoundary {
  start: number;
  end: number;
}

/**
 * Where each frame of a framed envelope starts and ends, refusing a short frame,
 * a declared length that does not fit, or an envelope with no frames at all.
 * Costs no key derivation, so every framed reader calls it first.
 */
export function readFrameBoundaries(
  envelope: Buffer,
  headerLength: number,
): FrameBoundary[] {
  let offset = headerLength;
  const frames: FrameBoundary[] = [];
  while (offset < envelope.length) {
    if (offset + FRAME_LENGTH_BYTES > envelope.length) {
      throw new BackupDecryptionError(
        "Failed to decrypt backup: the file ends inside a frame header",
      );
    }
    const length = envelope.readUInt32BE(offset);
    offset += FRAME_LENGTH_BYTES;
    if (length < TAG_LENGTH || length > MAX_FRAME_CIPHERTEXT_BYTES) {
      throw new BackupDecryptionError(
        "Failed to decrypt backup: the file declares an unusable frame size",
      );
    }
    if (offset + length > envelope.length) {
      throw new BackupDecryptionError(
        "Failed to decrypt backup: the file ends inside a frame",
      );
    }
    frames.push({ start: offset, end: offset + length });
    offset += length;
  }
  if (frames.length === 0) {
    throw new BackupDecryptionError(
      "Failed to decrypt backup: the file carries no frames",
    );
  }
  return frames;
}

/** Opens every frame under `key`, the last one as final. */
export function openFrames(
  envelope: Buffer,
  frames: FrameBoundary[],
  key: Buffer,
  header: Buffer,
  noncePrefix: Buffer,
): Buffer {
  const plaintext: Buffer[] = [];
  for (const [index, frame] of frames.entries()) {
    const final = index === frames.length - 1;
    const body = envelope.subarray(frame.start, frame.end - TAG_LENGTH);
    const tag = envelope.subarray(frame.end - TAG_LENGTH, frame.end);
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      key,
      frameNonce(noncePrefix, index, final),
    );
    decipher.setAAD(header);
    decipher.setAuthTag(tag);
    try {
      plaintext.push(Buffer.concat([decipher.update(body), decipher.final()]));
    } catch {
      // A tag mismatch is almost always a wrong password. It is also what a
      // truncated file produces, because the frame that became last was sealed
      // as non-final -- so the message covers both without claiming to know
      // which.
      throw new BackupDecryptionError(
        "Failed to decrypt backup: the password is incorrect or the file is corrupt",
      );
    }
  }
  return Buffer.concat(plaintext);
}
