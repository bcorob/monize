import { ConfigService } from "@nestjs/config";
import { createHash, randomUUID } from "crypto";

import { S3BackupStorageTarget } from "@/backup/storage/s3-backup-storage.target";
import { BackupStoreLocation } from "@/backup/storage/backup-storage.interface";

/**
 * The `s3` backup store against a real S3-compatible service (MinIO).
 *
 * The unit suite proves which command is constructed and what is in it. What it
 * cannot prove is the half of INV-BACKUP-006 that belongs to the service rather
 * than to our code: **S3 applies an object to its key only on a complete,
 * checksum-matching upload.** A double that resolves whatever it is handed
 * demonstrates none of that, which is exactly the shape VER-001
 * (`docs/verification-contract.md`) rules out for a claim about an external
 * system. So the checks here are the ones that need a server: a declared
 * checksum that does not match the bytes is refused rather than accepted, an
 * aborted upload leaves the key absent, and a full hourly cycle -- publish,
 * promote, list, prune -- round-trips through a real bucket.
 *
 * **This suite is gated on `BACKUP_STORE_S3_TEST_ENDPOINT`.** It runs wherever a
 * MinIO (or other S3-compatible) endpoint is reachable, and the
 * `backend-integration-tests` CI job is where it is meant to run -- that job has
 * only `postgres` today, and adding the service is the last step of task S2 of
 * the horizontal-scaling plan (`docs/specs/horizontal-scaling.md`, WP7); the
 * retired task record held the exact service block and why it was not in this
 * commit. The gate is deliberately one
 * variable and deliberately loud in this comment rather than a bare `describe.skip`:
 * a suite that quietly discovers nothing is a suite nobody notices is not running.
 */
const ENDPOINT = process.env.BACKUP_STORE_S3_TEST_ENDPOINT;
const BUCKET = process.env.BACKUP_STORE_S3_TEST_BUCKET ?? "monize-store-test";

describe("s3 backup store", () => {
  it("names the variable that turns the bucket-backed checks on", () => {
    // Always discovered, so the file reports its own state rather than
    // vanishing from the run. When the endpoint is set, everything below runs.
    expect(typeof BUCKET).toBe("string");
  });

  (ENDPOINT ? describe : describe.skip)("against a real bucket", () => {
    const USER_ID = "22222222-2222-4222-8222-222222222222";
    const DAILY = "monize-backup-daily-2026-09-14.mzbe";
    const WEEKLY = "monize-backup-weekly-2026-09-14.mzbe";

    let target: S3BackupStorageTarget;
    let location: BackupStoreLocation;
    let prefix: string;

    const config = (
      overrides: Record<string, string | undefined> = {},
    ): ConfigService =>
      ({
        get: (key: string) =>
          ({
            BACKUP_STORE_S3_BUCKET: BUCKET,
            BACKUP_STORE_S3_PREFIX: prefix,
            BACKUP_STORE_S3_ENDPOINT: ENDPOINT,
            BACKUP_STORE_S3_FORCE_PATH_STYLE: "true",
            BACKUP_STORE_S3_REGION: "us-east-1",
            BACKUP_STORE_S3_ACCESS_KEY_ID:
              process.env.BACKUP_STORE_S3_TEST_ACCESS_KEY_ID ?? "minioadmin",
            BACKUP_STORE_S3_SECRET_ACCESS_KEY:
              process.env.BACKUP_STORE_S3_TEST_SECRET_ACCESS_KEY ??
              "minioadmin",
            ...overrides,
          })[key],
      }) as unknown as ConfigService;

    beforeEach(async () => {
      // A fresh prefix per test, so one test's retention pass can never see
      // another's artifacts and the suite needs no teardown to be correct.
      prefix = `it-${randomUUID()}/`;
      target = new S3BackupStorageTarget(config());
      location = await target.resolveLocation(USER_ID);
    });

    const bytesOf = async (name: string): Promise<Buffer | null> => {
      const opened = await target.open(location, name);
      if (!opened) return null;
      const chunks: Buffer[] = [];
      for await (const chunk of opened.stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    };

    it("reports the bucket as writable without writing an artifact into it", async () => {
      const capability = await target.describeStore(USER_ID);

      expect(capability).toMatchObject({
        available: true,
        locationSelectable: false,
        // Nothing has been published under this test's prefix, and the probe is
        // a HeadBucket rather than a put, so the count is a true zero.
        artifactCount: 0,
      });
    });

    it("publishes an artifact whole, and reads back exactly those bytes", async () => {
      const bytes = Buffer.from(`artifact ${randomUUID()}`);

      await target.publish(location, DAILY, bytes);

      expect(await bytesOf(DAILY)).toEqual(bytes);
      const [entry] = await target.list(location);
      expect(entry).toMatchObject({
        name: DAILY,
        sizeBytes: bytes.length,
        legacy: false,
      });
    });

    it("is refused by the destination when the declared checksum does not match", async () => {
      // The half of INV-BACKUP-006 that is the service's rather than ours: the
      // destination recomputes the SHA-256 over what it received and rejects a
      // mismatch, so a corrupted transfer fails instead of being recorded as a
      // recovery point. Sending a checksum for different bytes is how that is
      // provoked without a lossy network.
      const bytes = Buffer.from("the real artifact");
      const wrong = createHash("sha256").update("other bytes").digest("base64");

      await expect(
        publishWithChecksum(target, location, DAILY, bytes, wrong),
      ).rejects.toThrow();

      // And the key is absent: a refused upload is not applied.
      expect(await bytesOf(DAILY)).toBeNull();
    });

    it("leaves the previous artifact intact when a publish is aborted", async () => {
      const good = Buffer.from("the good artifact");
      await target.publish(location, DAILY, good);

      const aborting = new S3BackupStorageTarget(
        config({ BACKUP_STORE_S3_REQUEST_TIMEOUT_MS: "1" }),
      );
      await expect(
        aborting.publish(
          await aborting.resolveLocation(USER_ID),
          DAILY,
          Buffer.alloc(8 * 1024 * 1024, 0x61),
        ),
      ).rejects.toThrow();

      expect(await bytesOf(DAILY)).toEqual(good);
    });

    it("promotes server-side, producing a second complete artifact", async () => {
      const bytes = Buffer.from(`artifact ${randomUUID()}`);
      await target.publish(location, DAILY, bytes);

      await target.promote(location, DAILY, WEEKLY);

      expect(await bytesOf(WEEKLY)).toEqual(bytes);
      expect((await target.list(location)).map((e) => e.name).sort()).toEqual(
        [DAILY, WEEKLY].sort(),
      );
    });

    it("carries one hourly cycle end to end: publish, promote, list, prune", async () => {
      // The acceptance of task S2. Seven dailies written oldest-first, the
      // newest promoted to weekly, then the three oldest pruned the way
      // retention prunes -- by listing the store and removing the entries past
      // the limit.
      const dailies = [8, 9, 10, 11, 12, 13, 14].map(
        (day) => `monize-backup-daily-2026-09-${day}.mzbe`,
      );
      for (const name of dailies) {
        await target.publish(location, name, Buffer.from(name));
      }
      await target.promote(location, dailies[dailies.length - 1], WEEKLY);

      const kept = 4;
      const stored = (await target.list(location))
        .filter((e) => e.name.includes("-daily-"))
        .sort((a, b) => b.name.localeCompare(a.name));
      for (const entry of stored.slice(kept)) {
        await target.remove(location, entry);
      }

      const remaining = (await target.list(location)).map((e) => e.name).sort();
      expect(remaining).toEqual(
        [...dailies.slice(dailies.length - kept), WEEKLY].sort(),
      );
      // Every surviving artifact is still its own complete bytes: a prune moved
      // nothing and rewrote nothing.
      for (const name of dailies.slice(dailies.length - kept)) {
        expect(await bytesOf(name)).toEqual(Buffer.from(name));
      }
      expect(await bytesOf(WEEKLY)).toEqual(
        Buffer.from(dailies[dailies.length - 1]),
      );
    });

    it("deletes idempotently, so a retention pass may repeat", async () => {
      const entry = {
        name: DAILY,
        sizeBytes: 0,
        modifiedAt: new Date(),
        legacy: false,
      };

      await expect(target.remove(location, entry)).resolves.toBeUndefined();
      await expect(target.remove(location, entry)).resolves.toBeUndefined();
    });

    it("answers null for a name the bucket does not hold", async () => {
      expect(await target.open(location, DAILY)).toBeNull();
    });
  });
});

/**
 * A publish that declares a checksum of the caller's choosing.
 *
 * `publish` always declares the checksum of the bytes it is given, which is the
 * point of it -- so provoking a mismatch means going around it, once, here,
 * rather than adding a parameter to the production interface that exists only
 * for a test.
 */
async function publishWithChecksum(
  target: S3BackupStorageTarget,
  location: BackupStoreLocation,
  filename: string,
  bytes: Buffer,
  checksumBase64: string,
): Promise<void> {
  const { PutObjectCommand } = await import("@aws-sdk/client-s3");
  const internals = target as unknown as {
    client(): { send(command: unknown, options: unknown): Promise<unknown> };
    storeConfig(): { bucket: string; deadlineMs: number };
    objectKey(location: BackupStoreLocation, filename: string): string;
  };
  await internals.client().send(
    new PutObjectCommand({
      Bucket: internals.storeConfig().bucket,
      Key: internals.objectKey(location, filename),
      Body: bytes,
      ContentLength: bytes.length,
      ChecksumSHA256: checksumBase64,
    }),
    {},
  );
}
