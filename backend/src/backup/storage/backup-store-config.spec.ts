import {
  assertStoreAndOffsiteDiffer,
  BackupStoreS3Config,
  normalizeStorePrefix,
  resolveBackupStoreProvider,
  resolveBackupStoreS3Config,
  sharesLocation,
} from "./backup-store-config";

/**
 * Which target a deployment selects, how an `s3` store reads its configuration,
 * and the one rule that keeps the store and the off-machine copy apart
 * (INV-BACKUP-007).
 *
 * Pure over a getter, so the whole table is a unit test rather than a set of
 * container starts and nothing here mutates `process.env`.
 */
describe("backup store configuration", () => {
  const get =
    (values: Record<string, string | undefined>) =>
    (name: string): string | undefined =>
      values[name];

  describe("which target is selected", () => {
    it("is local when nothing says otherwise", () => {
      expect(resolveBackupStoreProvider(get({}))).toBe("local");
      expect(
        resolveBackupStoreProvider(get({ BACKUP_STORAGE_PROVIDER: "" })),
      ).toBe("local");
    });

    it.each([
      ["s3", "s3"],
      ["S3", "s3"],
      ["  local  ", "local"],
    ])("reads %s as %s", (configured, expected) => {
      expect(
        resolveBackupStoreProvider(
          get({ BACKUP_STORAGE_PROVIDER: configured }),
        ),
      ).toBe(expected);
    });

    it("refuses a name it does not know rather than falling back to local", () => {
      // A typo here would otherwise put a deployment's recovery points on a
      // pod's disk while its operator believed they were in a bucket, and a
      // backup that is somewhere other than where you think it is has already
      // failed.
      expect(() =>
        resolveBackupStoreProvider(
          get({ BACKUP_STORAGE_PROVIDER: "S3-bucket" }),
        ),
      ).toThrow(/not a backup storage target/);
    });
  });

  describe("the s3 store's configuration", () => {
    const configured = {
      BACKUP_STORE_S3_BUCKET: "monize-store",
      BACKUP_STORE_S3_PREFIX: "backups",
      BACKUP_STORE_S3_REGION: "eu-west-2",
      BACKUP_STORE_S3_ENDPOINT: "http://minio:9000",
      BACKUP_STORE_S3_FORCE_PATH_STYLE: "true",
      BACKUP_STORE_S3_ACCESS_KEY_ID: "key",
      BACKUP_STORE_S3_SECRET_ACCESS_KEY: "secret",
    };

    it("reads every variable, normalising the prefix to one trailing slash", () => {
      expect(resolveBackupStoreS3Config(get(configured))).toEqual({
        bucket: "monize-store",
        prefix: "backups/",
        region: "eu-west-2",
        endpoint: "http://minio:9000",
        forcePathStyle: true,
        credentials: { accessKeyId: "key", secretAccessKey: "secret" },
        deadlineMs: 300000,
      });
    });

    it("refuses to resolve without a bucket, naming the variable", () => {
      expect(() => resolveBackupStoreS3Config(get({}))).toThrow(
        /BACKUP_STORE_S3_BUCKET must be set/,
      );
    });

    it("falls back to the default credential chain rather than signing with half a key pair", () => {
      const config = resolveBackupStoreS3Config(
        get({
          BACKUP_STORE_S3_BUCKET: "monize-store",
          BACKUP_STORE_S3_ACCESS_KEY_ID: "key",
        }),
      );

      expect(config.credentials).toBeUndefined();
    });

    it("compares the boolean as the string it is", () => {
      expect(
        resolveBackupStoreS3Config(
          get({
            BACKUP_STORE_S3_BUCKET: "monize-store",
            BACKUP_STORE_S3_FORCE_PATH_STYLE: "TRUE",
          }),
        ).forcePathStyle,
      ).toBe(false);
    });

    it("clamps a configured deadline down but never up", () => {
      const shorter = resolveBackupStoreS3Config(
        get({
          BACKUP_STORE_S3_BUCKET: "b",
          BACKUP_STORE_S3_REQUEST_TIMEOUT_MS: "1000",
        }),
      );
      const longer = resolveBackupStoreS3Config(
        get({
          BACKUP_STORE_S3_BUCKET: "b",
          BACKUP_STORE_S3_REQUEST_TIMEOUT_MS: "99999999",
        }),
      );

      expect(shorter.deadlineMs).toBe(1000);
      expect(longer.deadlineMs).toBe(300000);
    });

    it("does not read the off-machine destination's variables", () => {
      // The whole of INV-BACKUP-007's naming half: BACKUP_S3_* belongs to the
      // off-machine copy, and a store that read it would default the two to one
      // bucket.
      expect(() =>
        resolveBackupStoreS3Config(
          get({ BACKUP_S3_BUCKET: "monize-offsite", BACKUP_S3_PREFIX: "x/" }),
        ),
      ).toThrow(/BACKUP_STORE_S3_BUCKET must be set/);
    });
  });

  describe("the store and the off-machine copy are two places (INV-BACKUP-007)", () => {
    const store = (
      overrides: Partial<BackupStoreS3Config> = {},
    ): BackupStoreS3Config => ({
      bucket: "monize-store",
      prefix: "backups/",
      forcePathStyle: false,
      deadlineMs: 300000,
      ...overrides,
    });

    it("accepts two different buckets", () => {
      expect(
        sharesLocation(store(), {
          bucket: "monize-offsite",
          prefix: "backups/",
        }),
      ).toBe(false);
    });

    it("accepts the same bucket name on two different endpoints", () => {
      expect(
        sharesLocation(store({ endpoint: "http://minio:9000" }), {
          bucket: "monize-store",
          prefix: "backups/",
        }),
      ).toBe(false);
    });

    it("refuses the same bucket and prefix", () => {
      expect(
        sharesLocation(store(), { bucket: "monize-store", prefix: "backups/" }),
      ).toBe(true);
    });

    it("refuses a trailing-slash difference, which is not a difference", () => {
      expect(
        sharesLocation(store({ prefix: "backups" }), {
          bucket: "monize-store",
          prefix: "backups///",
        }),
      ).toBe(true);
    });

    it("refuses a prefix that is a parent of the other, either way round", () => {
      // `backups/` and `backups/store/` are not separate failure domains.
      expect(
        sharesLocation(store({ prefix: "backups/store/" }), {
          bucket: "monize-store",
          prefix: "backups/",
        }),
      ).toBe(true);
      expect(
        sharesLocation(store({ prefix: "backups/" }), {
          bucket: "monize-store",
          prefix: "backups/offsite/",
        }),
      ).toBe(true);
    });

    it("refuses the bucket root against any prefix, which contains everything", () => {
      expect(
        sharesLocation(store({ prefix: undefined }), {
          bucket: "monize-store",
          prefix: "offsite/",
        }),
      ).toBe(true);
    });

    it("accepts a sibling whose name merely begins the same way", () => {
      // `backups/` must not match `backups-old/`: the normalised trailing slash
      // is what makes the containment test a prefix test.
      expect(
        sharesLocation(store({ prefix: "backups/" }), {
          bucket: "monize-store",
          prefix: "backups-old/",
        }),
      ).toBe(false);
    });

    it("passes a deployment with no off-machine destination at all", () => {
      expect(() => assertStoreAndOffsiteDiffer(store(), null)).not.toThrow();
    });

    it("refuses at the boot, naming both locations", () => {
      expect(() =>
        assertStoreAndOffsiteDiffer(store(), {
          bucket: "monize-store",
          prefix: "backups/",
        }),
      ).toThrow(/INV-BACKUP-007/);
    });
  });

  describe("prefix normalisation", () => {
    it.each([
      [undefined, undefined],
      ["", undefined],
      ["   ", undefined],
      ["/", undefined],
      ["backups", "backups/"],
      ["backups/", "backups/"],
      ["backups///", "backups/"],
    ])("reads %s as %s", (given, expected) => {
      expect(normalizeStorePrefix(given)).toBe(expected);
    });
  });
});
