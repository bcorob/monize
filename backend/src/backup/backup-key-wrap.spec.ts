import { Readable, Transform } from "stream";
import { pipeline } from "stream/promises";
import {
  createKeyWrappedEncryptStream,
  createWrappedBackupKey,
  decodeKeyColumn,
  loginPasswordRef,
  sameLoginPasswordRef,
  unwrapBackupKey,
  WrappedBackupKey,
} from "./backup-key-wrap";
import {
  BackupDecryptionError,
  decryptBackup,
  decryptBackupWithDataKey,
  encryptBackup,
  isEncryptedBackup,
} from "./backup-crypto.util";
import { createBackupEncryptStream } from "./backup-stream-crypto";
import {
  KEY_WRAPPED_HEADER_LENGTH,
  VERSION_KEY_WRAPPED,
  WRAPPED_KEY_LENGTH,
} from "./backup-envelope";

async function collect(stream: Transform, payload: Buffer): Promise<Buffer> {
  const chunks: Buffer[] = [];
  await pipeline(
    Readable.from([payload]),
    stream,
    async (source: AsyncIterable<Buffer>) => {
      for await (const chunk of source) chunks.push(chunk);
    },
  );
  return Buffer.concat(chunks);
}

function sealUnder(key: WrappedBackupKey, payload: Buffer): Promise<Buffer> {
  return collect(createKeyWrappedEncryptStream(key), payload);
}

/**
 * The key-wrapped (v3) container the automatic backup writes
 * (docs/specs/backup-envelope-key-wrapping.md): encrypted under a data key the
 * server holds, opened with the user's password alone.
 */
describe("backup-key-wrap", () => {
  const password = "correct horse battery staple";
  // Larger than one 256 KiB frame, so the frame chain is exercised too.
  const payload = Buffer.alloc(600 * 1024, 7);
  let key: WrappedBackupKey;

  beforeAll(async () => {
    key = await createWrappedBackupKey(password);
  });

  it("wraps a random 32-byte key that only the password unwraps", async () => {
    expect(key.dataKey).toHaveLength(32);
    expect(key.wrap).toHaveLength(WRAPPED_KEY_LENGTH);
    expect(key.wrap.includes(key.dataKey)).toBe(false);
    expect(
      (await unwrapBackupKey(key.wrap, password)).equals(key.dataKey),
    ).toBe(true);
    await expect(unwrapBackupKey(key.wrap, "wrong")).rejects.toThrow(
      BackupDecryptionError,
    );
  });

  it("makes a fresh key every time, even under the same password", async () => {
    const again = await createWrappedBackupKey(password);
    expect(again.dataKey.equals(key.dataKey)).toBe(false);
  });

  it("writes a v3 envelope that opens with the password, as every restore does", async () => {
    const envelope = await sealUnder(key, payload);

    expect(isEncryptedBackup(envelope)).toBe(true);
    expect(envelope[4]).toBe(VERSION_KEY_WRAPPED);
    // The wrap travels in the header, so the file is self-contained.
    expect(envelope.subarray(6, 6 + WRAPPED_KEY_LENGTH).equals(key.wrap)).toBe(
      true,
    );
    expect((await decryptBackup(envelope, password)).equals(payload)).toBe(
      true,
    );
  });

  it("opens with the data key itself, and refuses another key", async () => {
    const envelope = await sealUnder(key, payload);
    const other = await createWrappedBackupKey(password);

    expect(
      (await decryptBackupWithDataKey(envelope, key.dataKey)).equals(payload),
    ).toBe(true);
    await expect(
      decryptBackupWithDataKey(envelope, other.dataKey),
    ).rejects.toThrow(BackupDecryptionError);
  });

  it("refuses a wrong password", async () => {
    const envelope = await sealUnder(key, payload);
    await expect(decryptBackup(envelope, "wrong")).rejects.toThrow(
      BackupDecryptionError,
    );
  });

  it("gives two files under one data key different frame keys", async () => {
    const a = await sealUnder(key, payload);
    const b = await sealUnder(key, payload);
    expect(a.equals(b)).toBe(false);
    // Same wrap, different per-file salt and nonce prefix.
    expect(
      a
        .subarray(6 + WRAPPED_KEY_LENGTH, KEY_WRAPPED_HEADER_LENGTH)
        .equals(b.subarray(6 + WRAPPED_KEY_LENGTH, KEY_WRAPPED_HEADER_LENGTH)),
    ).toBe(false);
  });

  it("authenticates the header: a swapped per-file salt fails", async () => {
    const envelope = await sealUnder(key, payload);
    envelope[6 + WRAPPED_KEY_LENGTH] ^= 0xff;
    await expect(decryptBackup(envelope, password)).rejects.toThrow(
      BackupDecryptionError,
    );
  });

  it("refuses a file truncated at a frame boundary", async () => {
    const envelope = await sealUnder(key, payload);
    // Header, then the first frame only: its length prefix says where it ends.
    const firstFrameLength = envelope.readUInt32BE(KEY_WRAPPED_HEADER_LENGTH);
    const truncated = envelope.subarray(
      0,
      KEY_WRAPPED_HEADER_LENGTH + 4 + firstFrameLength,
    );
    await expect(decryptBackup(truncated, password)).rejects.toThrow(
      BackupDecryptionError,
    );
  });

  it("does not open a v2 file with a data key", async () => {
    const v2 = await collect(
      await createBackupEncryptStream(password),
      payload,
    );
    await expect(decryptBackupWithDataKey(v2, key.dataKey)).rejects.toThrow(
      BackupDecryptionError,
    );
  });

  describe("files written before v3 still open with their password", () => {
    it("v1 (monolithic)", async () => {
      const v1 = await encryptBackup(payload, password);
      expect(v1[4]).toBe(1);
      expect((await decryptBackup(v1, password)).equals(payload)).toBe(true);
    });

    it("v2 (framed, password-derived key)", async () => {
      const v2 = await collect(
        await createBackupEncryptStream(password),
        payload,
      );
      expect(v2[4]).toBe(2);
      expect((await decryptBackup(v2, password)).equals(payload)).toBe(true);
    });
  });

  describe("decodeKeyColumn", () => {
    it("accepts exactly the stored length", () => {
      const value = key.dataKey.toString("base64");
      expect(decodeKeyColumn(value, 32)?.equals(key.dataKey)).toBe(true);
      expect(decodeKeyColumn(value, 31)).toBeNull();
    });

    it("refuses a value base64 decoding would silently repair", () => {
      // `Buffer.from(v, "base64")` drops characters outside the alphabet, so a
      // corrupted column could still decode to 32 bytes of the wrong key.
      const value = key.dataKey.toString("base64");
      expect(
        decodeKeyColumn(`${value.slice(0, 10)}!${value.slice(10)}`, 32),
      ).toBeNull();
    });
  });

  describe("loginPasswordRef", () => {
    it("names a hash without containing it, and compares in constant time", () => {
      const ref = loginPasswordRef("$2a$12$abcdefghijklmnopqrstuv");
      expect(ref).toMatch(/^[0-9a-f]{64}$/);
      expect(sameLoginPasswordRef(ref, ref)).toBe(true);
      expect(
        sameLoginPasswordRef(ref, loginPasswordRef("$2a$12$different")),
      ).toBe(false);
      expect(sameLoginPasswordRef(ref, "short")).toBe(false);
    });
  });
});
