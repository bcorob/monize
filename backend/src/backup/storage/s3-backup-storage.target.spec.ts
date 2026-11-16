const mockSend = jest.fn();

jest.mock("@smithy/node-http-handler", () => ({
  NodeHttpHandler: jest
    .fn()
    .mockImplementation((cfg) => ({ kind: "handler", cfg })),
}));

jest.mock("@aws-sdk/client-s3", () => ({
  S3Client: jest.fn().mockImplementation((cfg) => ({ send: mockSend, cfg })),
  PutObjectCommand: jest.fn().mockImplementation((input) => ({
    kind: "put",
    input,
  })),
  GetObjectCommand: jest.fn().mockImplementation((input) => ({
    kind: "get",
    input,
  })),
  DeleteObjectCommand: jest.fn().mockImplementation((input) => ({
    kind: "delete",
    input,
  })),
  CopyObjectCommand: jest.fn().mockImplementation((input) => ({
    kind: "copy",
    input,
  })),
  HeadBucketCommand: jest.fn().mockImplementation((input) => ({
    kind: "head-bucket",
    input,
  })),
  ListObjectsV2Command: jest.fn().mockImplementation((input) => ({
    kind: "list",
    input,
  })),
}));

import { BadRequestException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHash } from "crypto";
import { Readable } from "stream";
import { S3Client } from "@aws-sdk/client-s3";

import { S3BackupStorageTarget } from "./s3-backup-storage.target";
import { BackupStoreLocation } from "./backup-storage.interface";

const USER_ID = "22222222-2222-4222-8222-222222222222";
const ARTIFACT = "monize-backup-daily-2026-09-14.mzbe";
/** `<prefix><ab>/<cd>/<userId>/`, the local layout in key form. */
const PREFIX = `backups/22/22/${USER_ID}/`;

/**
 * The `s3` storage target: the keys it composes, the commands it sends, and the
 * two things it refuses.
 *
 * The destination is a double rather than a bucket, in the style of
 * `s3-storage.provider.spec.ts`: what is under test here is which command is
 * constructed and what is in it. That an aborted upload leaves the key absent,
 * and that a checksum mismatch is refused by the service rather than accepted,
 * are properties of S3 and are proven against MinIO in
 * `test/integration/backup-store-s3.integration.spec.ts`. The deadline is proven
 * against a genuinely stalled socket in `*.deadline.spec.ts`.
 */
describe("S3BackupStorageTarget", () => {
  const ENV: Record<string, string> = {
    BACKUP_STORE_S3_BUCKET: "monize-store",
    BACKUP_STORE_S3_PREFIX: "backups/",
    BACKUP_STORE_S3_REGION: "us-east-1",
  };

  const targetFor = (
    overrides: Record<string, string | undefined> = {},
  ): S3BackupStorageTarget =>
    new S3BackupStorageTarget({
      get: (key: string) => ({ ...ENV, ...overrides })[key],
    } as unknown as ConfigService);

  let target: S3BackupStorageTarget;
  let location: BackupStoreLocation;

  beforeEach(async () => {
    mockSend.mockReset();
    (S3Client as unknown as jest.Mock).mockClear();
    target = targetFor();
    location = await target.resolveLocation(USER_ID);
  });

  describe("the namespace", () => {
    it("keeps the sharded key layout the local target writes", () => {
      expect(location.display).toBe(`s3://monize-store/${PREFIX}`);
      expect(location.target).toBe("s3");
    });

    it("refuses a user id that is not shardable", async () => {
      await expect(target.resolveLocation("../../etc")).rejects.toThrow(
        BadRequestException,
      );
    });

    it("refuses a handle another target produced", async () => {
      const foreign: BackupStoreLocation = {
        target: "local",
        display: "/data/backups",
      };

      await expect(target.list(foreign)).rejects.toThrow(/not "s3"/);
    });
  });

  describe("the location is the deployment's, not a user's", () => {
    it("has nothing for a user to choose", () => {
      expect(target.locationSelectable).toBe(false);
    });

    it("refuses a folder a user asks to store", () => {
      expect(() => target.acceptBase()).toThrow(BadRequestException);
    });

    it("answers a refusal from validateFolder rather than walking a filesystem", async () => {
      await expect(target.validateFolder()).resolves.toEqual({
        valid: false,
        error: expect.stringContaining("no folder to browse"),
      });
      expect(mockSend).not.toHaveBeenCalled();
    });

    it("refuses to browse folders", async () => {
      await expect(target.browseFolders()).rejects.toThrow(BadRequestException);
    });

    it("ignores a folderPath left over from a local deployment", () => {
      // The column may still hold a container directory. Honouring it would be
      // honouring a path that means nothing in a bucket.
      expect(target.resolveBase()).toBe("s3://monize-store/backups/");
    });
  });

  describe("publishing (INV-BACKUP-006)", () => {
    it("declares the length and the checksum so the destination verifies the bytes", async () => {
      mockSend.mockResolvedValue({});
      const bytes = Buffer.from("artifact bytes");

      await target.publish(location, ARTIFACT, bytes);

      expect(mockSend.mock.calls[0][0]).toEqual({
        kind: "put",
        input: {
          Bucket: "monize-store",
          Key: `${PREFIX}${ARTIFACT}`,
          Body: bytes,
          ContentLength: bytes.length,
          // S3 recomputes this over what it received and refuses a mismatch, so
          // a corrupted transfer fails rather than being published.
          ChecksumSHA256: createHash("sha256").update(bytes).digest("base64"),
        },
      });
    });

    it("does not send IfNoneMatch: republishing a day's artifact is intended", async () => {
      // Unlike the off-machine uploader, which is append-only (INV-BACKUP-004).
      // A same-day re-export replaces that day's artifact with what the export
      // just produced, and the run is claimed so two cannot interleave.
      mockSend.mockResolvedValue({});

      await target.publish(location, ARTIFACT, Buffer.from("x"));

      expect(mockSend.mock.calls[0][0].input.IfNoneMatch).toBeUndefined();
    });

    it("refuses a filename carrying a separator", async () => {
      await expect(
        target.publish(
          location,
          "../../other-user/artifact.mzbe",
          Buffer.from("x"),
        ),
      ).rejects.toThrow(BadRequestException);
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  describe("promoting", () => {
    it("copies server-side rather than pulling the artifact through this process", async () => {
      mockSend.mockResolvedValue({});

      await target.promote(
        location,
        ARTIFACT,
        "monize-backup-weekly-2026-09-14.mzbe",
      );

      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(mockSend.mock.calls[0][0]).toEqual({
        kind: "copy",
        input: {
          Bucket: "monize-store",
          CopySource: encodeURI(`monize-store/${PREFIX}${ARTIFACT}`),
          Key: `${PREFIX}monize-backup-weekly-2026-09-14.mzbe`,
        },
      });
    });
  });

  describe("listing", () => {
    it("reports every object directly under this user's prefix", async () => {
      const modified = new Date("2026-09-14T02:00:00Z");
      mockSend.mockResolvedValue({
        Contents: [
          { Key: `${PREFIX}${ARTIFACT}`, Size: 42, LastModified: modified },
        ],
        IsTruncated: false,
      });

      await expect(target.list(location)).resolves.toEqual([
        {
          name: ARTIFACT,
          sizeBytes: 42,
          modifiedAt: modified,
          // This target has never had a layout without an owner in the key, so
          // the pre-namespacing history the local target sweeps has no
          // counterpart here.
          legacy: false,
        },
      ]);
    });

    it("skips a key with a further slash in it, which is not an artifact we wrote", async () => {
      mockSend.mockResolvedValue({
        Contents: [
          {
            Key: `${PREFIX}nested/${ARTIFACT}`,
            Size: 1,
            LastModified: new Date(),
          },
        ],
        IsTruncated: false,
      });

      await expect(target.list(location)).resolves.toEqual([]);
    });

    it("pages to the end rather than acting on a truncated view", async () => {
      // Retention deletes against this listing. A partial one would make it
      // count fewer artifacts than the store holds and keep too many.
      mockSend
        .mockResolvedValueOnce({
          Contents: [
            { Key: `${PREFIX}a.mzbe`, Size: 1, LastModified: new Date() },
          ],
          IsTruncated: true,
          NextContinuationToken: "page-2",
        })
        .mockResolvedValueOnce({
          Contents: [
            { Key: `${PREFIX}b.mzbe`, Size: 1, LastModified: new Date() },
          ],
          IsTruncated: false,
        });

      const entries = await target.list(location);

      expect(entries.map((e) => e.name)).toEqual(["a.mzbe", "b.mzbe"]);
      expect(mockSend.mock.calls[1][0].input.ContinuationToken).toBe("page-2");
    });

    it("is empty rather than an error when the store holds nothing for this user", async () => {
      mockSend.mockResolvedValue({ IsTruncated: false });

      await expect(target.list(location)).resolves.toEqual([]);
    });
  });

  describe("opening", () => {
    it("streams the object under the composed key", async () => {
      const stream = Readable.from([Buffer.from("artifact")]);
      mockSend.mockResolvedValue({ Body: stream, ContentLength: 8 });

      const opened = await target.open(location, ARTIFACT);

      expect(opened).toEqual({ filename: ARTIFACT, sizeBytes: 8, stream });
      expect(mockSend.mock.calls[0][0]).toEqual({
        kind: "get",
        input: { Bucket: "monize-store", Key: `${PREFIX}${ARTIFACT}` },
      });
    });

    it("answers null for a key the bucket does not hold", async () => {
      mockSend.mockRejectedValue(
        Object.assign(new Error("nope"), { name: "NoSuchKey" }),
      );

      await expect(target.open(location, ARTIFACT)).resolves.toBeNull();
    });

    it("lets any other failure through rather than reporting it as absent", async () => {
      // A 403 is not "no such artifact": answering null would turn a
      // misconfigured credential into a 404 nobody can act on.
      mockSend.mockRejectedValue(
        Object.assign(new Error("denied"), {
          name: "AccessDenied",
          $metadata: { httpStatusCode: 403 },
        }),
      );

      await expect(target.open(location, ARTIFACT)).rejects.toThrow("denied");
    });
  });

  describe("removing", () => {
    it("deletes the composed key", async () => {
      mockSend.mockResolvedValue({});

      await target.remove(location, {
        name: ARTIFACT,
        sizeBytes: 1,
        modifiedAt: new Date(),
        legacy: false,
      });

      expect(mockSend.mock.calls[0][0]).toEqual({
        kind: "delete",
        input: { Bucket: "monize-store", Key: `${PREFIX}${ARTIFACT}` },
      });
    });
  });

  describe("sweeping incomplete writes", () => {
    it("has nothing to sweep and says so without a round trip", async () => {
      // A single PutObject has no intermediate state: the key either has the
      // complete object or has nothing.
      await expect(target.sweepIncomplete()).resolves.toBe(0);
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  describe("the capability report", () => {
    it("probes with HeadBucket rather than writing into somebody's recovery points", async () => {
      mockSend
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ Contents: [], IsTruncated: false });

      await expect(target.describeStore(USER_ID)).resolves.toEqual({
        available: true,
        location: "s3://monize-store/backups/",
        locationSelectable: false,
        artifactCount: 0,
      });
      expect(mockSend.mock.calls[0][0].kind).toBe("head-bucket");
    });

    it("reports a bucket it cannot reach, with the reason", async () => {
      mockSend.mockRejectedValue(new Error("NoSuchBucket"));

      const capability = await target.describeStore(USER_ID);

      expect(capability).toMatchObject({
        available: false,
        location: "s3://monize-store/backups/",
        locationSelectable: false,
        reason: expect.stringContaining("NoSuchBucket"),
      });
      expect(capability.artifactCount).toBeUndefined();
    });

    it("describes an unconfigured store instead of throwing at the settings screen", async () => {
      const unconfigured = targetFor({ BACKUP_STORE_S3_BUCKET: undefined });

      const capability = await unconfigured.describeStore(USER_ID);

      expect(capability.available).toBe(false);
      expect(capability.location).toBe("s3://(unconfigured)");
      expect(capability.reason).toContain("BACKUP_STORE_S3_BUCKET must be set");
    });
  });

  describe("the store and the off-machine copy are two places (INV-BACKUP-007)", () => {
    it("refuses a store configured at the off-machine destination's own location", async () => {
      const collided = targetFor({
        BACKUP_STORE_S3_BUCKET: "one-bucket",
        BACKUP_STORE_S3_PREFIX: "backups/",
        BACKUP_S3_BUCKET: "one-bucket",
        BACKUP_S3_PREFIX: "backups/offsite/",
      });

      // The refusal lands on the first operation that needs the store's
      // configuration -- here resolving the user's namespace -- with a message
      // naming both locations. One bucket holding the store and its off-machine
      // copy is a 3-2-1 arrangement that is actually a 1. The boot matrix
      // refuses the same deployment before it serves traffic; this is the
      // backstop for a store bound after one.
      await expect(collided.resolveLocation(USER_ID)).rejects.toThrow(
        /INV-BACKUP-007/,
      );
      expect(mockSend).not.toHaveBeenCalled();
    });

    it("accepts a store and a destination in two different buckets", async () => {
      const separated = targetFor({
        BACKUP_STORE_S3_BUCKET: "monize-store",
        BACKUP_S3_BUCKET: "monize-offsite",
      });
      mockSend.mockResolvedValue({});

      await expect(
        separated.publish(
          await separated.resolveLocation(USER_ID),
          ARTIFACT,
          Buffer.from("x"),
        ),
      ).resolves.toBeUndefined();
    });
  });

  describe("the transport", () => {
    it("builds one client, pinned to the shared attempt ceiling and deadline", async () => {
      mockSend.mockResolvedValue({});

      await target.publish(location, ARTIFACT, Buffer.from("x"));
      await target.publish(location, ARTIFACT, Buffer.from("y"));

      expect(S3Client as unknown as jest.Mock).toHaveBeenCalledTimes(1);
      const cfg = (S3Client as unknown as jest.Mock).mock.calls[0][0];
      expect(cfg.maxAttempts).toBe(3);
      expect(cfg.region).toBe("us-east-1");
      expect(cfg.requestHandler).toBeDefined();
    });

    it("omits credentials rather than signing with half a key pair", async () => {
      const halved = targetFor({ BACKUP_STORE_S3_ACCESS_KEY_ID: "key" });
      mockSend.mockResolvedValue({});

      await halved.publish(
        await halved.resolveLocation(USER_ID),
        ARTIFACT,
        Buffer.from("x"),
      );

      const cfg = (S3Client as unknown as jest.Mock).mock.calls[0][0];
      expect(cfg.credentials).toBeUndefined();
    });
  });
});
