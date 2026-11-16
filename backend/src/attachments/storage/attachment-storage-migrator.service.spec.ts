import { ConfigService } from "@nestjs/config";
import { Logger, NotFoundException } from "@nestjs/common";
import { DataSource, EntityManager } from "typeorm";
import { createHash } from "crypto";
import {
  runOutsideActiveScopedManager,
  withScopedDb,
} from "../../common/db/scoped-db";
import { FetchSyncService } from "../../common/jobs/fetch-sync.service";
import { AttachmentOrphanSweeper } from "../attachment-orphan-sweeper.service";
import { getRequestContext } from "../../common/request-context";
import { AttachmentStorageProvider } from "./attachment-storage.interface";
import { AttachmentStorageRegistry } from "./attachment-storage.registry";
import {
  AttachmentStorageMigrator,
  MAX_REPORTED_FAILURES,
  RELOCATION_BATCH,
} from "./attachment-storage-migrator.service";

jest.mock("../../common/db/scoped-db");
const mockedTx = withScopedDb as jest.MockedFunction<typeof withScopedDb>;
const mockedOutsideTx = runOutsideActiveScopedManager as jest.MockedFunction<
  typeof runOutsideActiveScopedManager
>;

/** A real user id: `withUserContext` refuses anything that is not a UUID. */
const OWNER = "11111111-1111-4111-8111-111111111111";
const ATTACHMENT = "22222222-2222-4222-8222-222222222222";
const BYTES = Buffer.from("a scanned receipt");
const DIGEST = createHash("sha256").update(BYTES).digest("hex");

/** An in-memory backend, so "the bytes moved" is a fact about a store. */
interface FakeStore extends AttachmentStorageProvider {
  objects: Map<string, Buffer>;
  save: jest.Mock;
  load: jest.Mock;
  delete: jest.Mock;
  /**
   * The ambient identity each call ran under.
   *
   * `withScopedDb` is mocked in this file, so nothing else here would notice the
   * relocation running with no identity context -- and under RLS that is every
   * statement in it reading zero rows. Recording it at the seam that does the I/O
   * is what makes "each attachment moves under its owner's identity" a fact this
   * suite can fail on.
   */
  contexts: Array<string | undefined>;
}

function makeStore(name: string, addressable = true): FakeStore {
  const objects = new Map<string, Buffer>();
  const contexts: Array<string | undefined> = [];
  const note = (): void => {
    contexts.push(getRequestContext()?.userId);
  };
  return {
    name,
    addressable,
    objects,
    contexts,
    save: jest.fn(async (key: string, data: Buffer) => {
      note();
      objects.set(key, Buffer.from(data));
    }),
    load: jest.fn(async (key: string) => {
      note();
      const found = objects.get(key);
      if (!found) throw new NotFoundException("no such object");
      return found;
    }),
    delete: jest.fn(async (key: string) => {
      note();
      objects.delete(key);
    }),
  };
}

/** One attachment row as the relocation's own queries select it. */
function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ATTACHMENT,
    user_id: OWNER,
    storage_provider: "local",
    storage_key: ATTACHMENT,
    byte_size: String(BYTES.length),
    sha256: DIGEST,
    ...overrides,
  };
}

describe("AttachmentStorageMigrator", () => {
  let source: FakeStore;
  let destination: FakeStore;
  let migrator: AttachmentStorageMigrator;
  let sweeper: jest.Mocked<Pick<AttachmentOrphanSweeper, "sweepKey">>;
  let fetchSync: { withLease: jest.Mock };
  /** Rows the scan returns; emptied as the cursor passes them. */
  let pending: Record<string, unknown>[];
  /** The row the locking re-read finds, or `null` for "gone or already moved". */
  let locked: Record<string, unknown> | null;
  /** Whether clearing the destination intent still finds an unclaimed row. */
  let intentStillOurs: boolean;
  /** Every statement, grouped by the transaction that issued it. */
  let transactions: string[][];
  let blobRepo: { delete: jest.Mock };
  let env: Record<string, string>;

  const statements = (): string[] => transactions.flat();
  const sqlLike = (fragment: string): string[] =>
    statements().filter((sql) => sql.includes(fragment));
  /**
   * Tombstone inserts that are *deletion records* rather than write intents. One
   * row shape means two things, and the lease column is what tells them apart.
   */
  const sourceTombstones = (): string[] =>
    sqlLike("INSERT INTO attachment_blob_tombstones").filter(
      (sql) => !sql.includes("upload_lease_expires_at"),
    );

  /** Build the migrator over `stores`, the first of which is the active one. */
  const build = (stores: FakeStore[], active = stores[0]): void => {
    migrator = new AttachmentStorageMigrator(
      {} as DataSource,
      new AttachmentStorageRegistry(active, stores),
      fetchSync as unknown as FetchSyncService,
      sweeper as unknown as AttachmentOrphanSweeper,
      {
        get: (key: string) => env[key],
      } as unknown as ConfigService,
    );
  };

  beforeEach(() => {
    env = {};
    source = makeStore("local");
    destination = makeStore("s3");
    source.objects.set(ATTACHMENT, BYTES);
    pending = [row()];
    locked = row();
    intentStillOurs = true;
    transactions = [];
    blobRepo = { delete: jest.fn().mockResolvedValue({ affected: 1 }) };
    sweeper = { sweepKey: jest.fn().mockResolvedValue(undefined) };
    fetchSync = {
      withLease: jest.fn(
        async (_job: string, _ms: number, fn: () => Promise<void>) => {
          await fn();
          return true;
        },
      ),
    };

    let current: string[] = [];
    const manager = {
      getRepository: jest.fn(() => blobRepo),
      query: jest.fn(async (sql: string) => {
        const text = String(sql);
        current.push(text);
        if (text.includes("LIMIT 1")) {
          return pending.length > 0 ? [{ n: 1 }] : [];
        }
        if (text.includes("FOR UPDATE")) {
          return locked ? [locked] : [];
        }
        if (text.includes("FROM transaction_attachments")) {
          // The keyset scan. Handing the batch over once is what ends the drain.
          const batch = pending;
          pending = [];
          return batch;
        }
        if (text.includes("INSERT INTO attachment_blob_tombstones")) {
          return [{ id: "t1" }];
        }
        if (text.includes("DELETE FROM attachment_blob_tombstones")) {
          return intentStillOurs ? [[{ id: "t1" }], 1] : [[], 0];
        }
        return [];
      }),
    } as unknown as EntityManager;

    // One group per transaction, so a spec can ask what was in the SAME one --
    // "the flip and the tombstone commit together" is the property, not "both
    // statements ran".
    mockedTx.mockImplementation((_dataSource, fn) => {
      current = [];
      transactions.push(current);
      return fn(manager) as never;
    });
    mockedOutsideTx.mockImplementation((fn) => fn());
    build([destination, source]);
  });

  afterEach(() => jest.clearAllMocks());

  describe("a provider switch", () => {
    it("copies the bytes into the active backend and flips the row", async () => {
      const outcome = await migrator.relocateAll("test");

      expect(outcome).toEqual({
        moved: 1,
        skipped: 0,
        failed: 0,
        unreachable: 0,
        failedIds: [],
      });
      expect(destination.objects.get(ATTACHMENT)).toEqual(BYTES);
      const flip = sqlLike("SET storage_provider")[0];
      expect(flip).toContain("WHERE id = $2 AND storage_provider = $3");
    });

    it("moves each attachment under its owner's identity", async () => {
      await migrator.relocateAll("test");

      // Every statement in the per-row work is one the owner's own RLS policies
      // admit; only the cross-user scan runs under system context. Asserted at
      // the store seam because `withScopedDb` is mocked here.
      expect(source.contexts).toEqual([OWNER]);
      expect(destination.contexts).toEqual([OWNER, OWNER]);
    });

    it("re-reads the row under a lock before writing anything", async () => {
      await migrator.relocateAll("test");

      // The lock is what makes "two replicas cannot both flip this row" true, and
      // what makes every check in the transaction final. Asserted, not inferred
      // from the double's routing.
      const locking = sqlLike("FROM transaction_attachments").find((sql) =>
        sql.includes("FOR UPDATE"),
      );
      expect(locking).toContain("WHERE id = $1 AND storage_provider = $2");
      const lockedAt = statements().indexOf(locking!);
      const flipAt = statements().findIndex((sql) =>
        sql.includes("SET storage_provider"),
      );
      expect(lockedAt).toBeLessThan(flipAt);
      expect(lockedAt).toBeGreaterThan(-1);
    });

    it("binds the batch size rather than interpolating it", async () => {
      await migrator.relocateAll("test");

      // Parameterized SQL only: a constant today is a configurable tomorrow.
      const scan = sqlLike("ORDER BY id")[0];
      expect(scan).toContain("LIMIT $3");
    });

    it("reads the copy back before anything is deleted", async () => {
      await migrator.relocateAll("test");

      // Not "save resolved": the claim the source deletion rests on is that the
      // bytes are readable from the new backend.
      expect(destination.load).toHaveBeenCalledWith(ATTACHMENT);
      const order = destination.save.mock.invocationCallOrder[0];
      expect(destination.load.mock.invocationCallOrder[0]).toBeGreaterThan(
        order,
      );
    });

    it("deletes the source object only after the flip has committed", async () => {
      await migrator.relocateAll("test");

      // Through the sweeper, which is the one place that decides an object may
      // go -- and after the commit, so a failure costs storage, not a receipt.
      expect(sweeper.sweepKey).toHaveBeenCalledWith(ATTACHMENT, "local");
      expect(source.delete).not.toHaveBeenCalled();
    });

    it("records the source object as unreferenced inside the flip", async () => {
      await migrator.relocateAll("test");

      const flipTransaction = transactions.find((group) =>
        group.some((sql) => sql.includes("SET storage_provider")),
      );
      expect(flipTransaction).toBeDefined();
      // A deletion record in the same transaction as the flip: if this process
      // dies before the sweep, the hourly pass still finds the abandoned object.
      expect(
        flipTransaction!.some(
          (sql) =>
            sql.includes("INSERT INTO attachment_blob_tombstones") &&
            !sql.includes("upload_lease_expires_at"),
        ),
      ).toBe(true);
    });

    it("records a destination intent before writing, and clears it in the flip", async () => {
      await migrator.relocateAll("test");

      const intent = sqlLike("INSERT INTO attachment_blob_tombstones")[0];
      expect(intent).toContain("upload_lease_expires_at");
      const flipTransaction = transactions.find((group) =>
        group.some((sql) => sql.includes("SET storage_provider")),
      );
      expect(
        flipTransaction!.some((sql) =>
          sql.includes("DELETE FROM attachment_blob_tombstones"),
        ),
      ).toBe(true);
    });

    it("keeps the row where it is when the sweeper claimed the copy first", async () => {
      intentStillOurs = false;

      const outcome = await migrator.relocateAll("test");

      expect(outcome.failed).toBe(1);
      expect(outcome.moved).toBe(0);
      // The transaction rolled back, so the staged copy is removed and the row
      // still points at the source -- which still has the bytes.
      expect(destination.delete).toHaveBeenCalledWith(ATTACHMENT);
      expect(source.objects.has(ATTACHMENT)).toBe(true);
      expect(sweeper.sweepKey).not.toHaveBeenCalled();
    });
  });

  describe("refusals, before anything is written", () => {
    it("leaves an attachment whose source bytes contradict its row", async () => {
      source.objects.set(ATTACHMENT, Buffer.from("truncated"));

      const outcome = await migrator.relocateAll("test");

      expect(outcome.failed).toBe(1);
      expect(destination.save).not.toHaveBeenCalled();
      expect(sqlLike("SET storage_provider")).toHaveLength(0);
      expect(sweeper.sweepKey).not.toHaveBeenCalled();
    });

    it("leaves an attachment whose backend this deployment cannot address", async () => {
      // s3 active, and the rows say `local` -- but only s3 is registered here,
      // which is the deployment that dropped the old configuration.
      build([destination]);

      const outcome = await migrator.relocateAll("test");

      expect(outcome).toEqual({
        moved: 0,
        skipped: 0,
        failed: 0,
        unreachable: 1,
        failedIds: [],
      });
      expect(destination.save).not.toHaveBeenCalled();
      expect(statements().some((sql) => sql.includes("tombstones"))).toBe(
        false,
      );
    });

    it("writes nothing when the locked row has already been moved", async () => {
      locked = null;

      const outcome = await migrator.relocateAll("test");

      expect(outcome.skipped).toBe(1);
      expect(destination.save).not.toHaveBeenCalled();
      // The intent this pass recorded is dropped rather than left behind for the
      // sweeper to act on against a row that now owns those bytes.
      expect(blobRepo.delete).toHaveBeenCalledWith(
        expect.objectContaining({
          storageProvider: "s3",
          storageKey: ATTACHMENT,
        }),
      );
    });

    it("does not copy the copy back: a failed readback fails the row", async () => {
      destination.load.mockResolvedValue(Buffer.from("something else"));

      const outcome = await migrator.relocateAll("test");

      expect(outcome.failed).toBe(1);
      expect(sqlLike("SET storage_provider")).toHaveLength(0);
      expect(destination.delete).toHaveBeenCalledWith(ATTACHMENT);
    });
  });

  describe("the database provider on either side", () => {
    it("deletes the blob inside the flip when moving out of PostgreSQL", async () => {
      const database = makeStore("database");
      database.objects.set(ATTACHMENT, BYTES);
      pending = [row({ storage_provider: "database" })];
      locked = row({ storage_provider: "database" });
      build([destination, database]);

      const outcome = await migrator.relocateAll("test");

      expect(outcome.moved).toBe(1);
      // A blob is a row, so its removal joins the transaction and needs no
      // tombstone and no post-commit sweep.
      expect(database.delete).toHaveBeenCalledWith(ATTACHMENT);
      expect(sweeper.sweepKey).not.toHaveBeenCalled();
      expect(sourceTombstones()).toHaveLength(0);
    });

    it("takes no intent and no readback when moving into PostgreSQL", async () => {
      const database = makeStore("database");
      build([database, source]);

      const outcome = await migrator.relocateAll("test");

      expect(outcome.moved).toBe(1);
      expect(database.objects.get(ATTACHMENT)).toEqual(BYTES);
      // Bytes that commit with the row need no intent to outlive a rollback, and
      // re-reading them would only ask Postgres whether it meant what it said.
      expect(database.load).not.toHaveBeenCalled();
      expect(sqlLike("upload_lease_expires_at")).toHaveLength(0);
      expect(sweeper.sweepKey).toHaveBeenCalledWith(ATTACHMENT, "local");
    });
  });

  describe("pacing and other replicas", () => {
    it("stops without touching anything when another replica holds the lease", async () => {
      fetchSync.withLease.mockResolvedValue(false);

      const outcome = await migrator.relocateAll("test");

      expect(outcome.moved).toBe(0);
      expect(destination.save).not.toHaveBeenCalled();
    });

    it("asks for the lease once per batch rather than once per drain", async () => {
      // A full batch means "there may be more", so the drain takes the lease
      // again instead of holding one window open for the whole backlog.
      pending = Array.from({ length: RELOCATION_BATCH }, (_, i) =>
        row({ id: `3${i}`.padStart(8, "0") + "-2222-4222-8222-222222222222" }),
      );
      locked = null;

      await migrator.relocateAll("test");

      expect(fetchSync.withLease.mock.calls.length).toBeGreaterThan(1);
      expect(fetchSync.withLease.mock.calls[0][0]).toBe(
        "attachment-relocation",
      );
    });

    it("ends the drain when a whole batch throws, rather than spinning on it", async () => {
      // The lease helper rethrows what the batch threw. Nothing here is broken by
      // stopping: every row it did not move still names its own backend, and :50
      // comes round again.
      fetchSync.withLease.mockRejectedValue(new Error("database down"));

      const outcome = await migrator.relocateAll("test");

      expect(outcome).toEqual({
        moved: 0,
        skipped: 0,
        failed: 0,
        unreachable: 0,
        failedIds: [],
      });
      expect(fetchSync.withLease).toHaveBeenCalledTimes(1);
    });

    it("warns rather than throwing when a staged copy cannot be removed", async () => {
      // The flip rolled back and the compensating delete failed too. The intent
      // recorded before the copy is what makes this promptness rather than the
      // only chance, so it is a warning and an object the sweeper knows about.
      intentStillOurs = false;
      destination.delete.mockRejectedValue(new Error("bucket unreachable"));

      const outcome = await migrator.relocateAll("test");

      expect(outcome.failed).toBe(1);
      expect(source.objects.has(ATTACHMENT)).toBe(true);
    });

    it("names what it could not move once per pass, not once per attachment", async () => {
      // A row that can never move is re-read every hour. The pass says which
      // attachments those are, in one line; the reason per attachment is a level
      // down, so the log an operator reads does not fill up with it.
      const warn = jest.spyOn(Logger.prototype, "warn");
      const debug = jest.spyOn(Logger.prototype, "debug");
      source.objects.delete(ATTACHMENT);

      const outcome = await migrator.relocateAll("test");

      expect(outcome.failed).toBe(1);
      expect(outcome.failedIds).toEqual([ATTACHMENT]);
      const summaries = warn.mock.calls.map((call) => String(call[0]));
      expect(summaries).toHaveLength(1);
      expect(summaries[0]).toContain(ATTACHMENT);
      expect(summaries[0]).toContain("left in place after an error");
      expect(
        debug.mock.calls.some((call) => String(call[0]).includes(ATTACHMENT)),
      ).toBe(true);
    });

    it("caps the named failures so the summary stays one line", async () => {
      const ids = Array.from(
        { length: MAX_REPORTED_FAILURES + 3 },
        (_, i) =>
          `${String(i + 10).padStart(8, "0")}-2222-4222-8222-222222222222`,
      );
      pending = ids.map((id) => row({ id, storage_key: id }));
      // No bytes for any of them, so every row fails.
      source.objects.clear();

      const outcome = await migrator.relocateAll("test");

      expect(outcome.failed).toBe(ids.length);
      expect(outcome.failedIds).toHaveLength(MAX_REPORTED_FAILURES);
    });

    it("writes nothing when the active backend itself is not configured", async () => {
      // `ATTACHMENT_STORAGE_PROVIDER=s3` with no bucket: the boot does not refuse
      // it, so the relocation would otherwise walk the whole table every hour to
      // fail on every row, paying a tombstone write each time.
      const unconfigured = makeStore("s3", false);
      build([unconfigured, source], unconfigured);

      const outcome = await migrator.relocateAll("test");

      expect(outcome).toEqual({
        moved: 0,
        skipped: 0,
        failed: 0,
        unreachable: 0,
        failedIds: [],
      });
      expect(fetchSync.withLease).not.toHaveBeenCalled();
      expect(statements().some((sql) => sql.includes("tombstones"))).toBe(
        false,
      );
    });

    it("does nothing at all when no row is outside the active backend", async () => {
      pending = [];

      const outcome = await migrator.relocateAll("test");

      expect(outcome.moved).toBe(0);
      expect(fetchSync.withLease).not.toHaveBeenCalled();
    });

    it("leaves the attachments alone when the relocation is switched off", async () => {
      env.ATTACHMENT_STORAGE_MIGRATE_ON_SWITCH = "false";
      build([destination, source]);

      const outcome = await migrator.relocateAll("test");

      expect(outcome.moved).toBe(0);
      expect(fetchSync.withLease).not.toHaveBeenCalled();
      expect(destination.save).not.toHaveBeenCalled();
    });

    it("starts on boot without making the boot wait for it", () => {
      const relocate = jest.spyOn(migrator, "relocateAll").mockResolvedValue({
        moved: 0,
        skipped: 0,
        failed: 0,
        unreachable: 0,
        failedIds: [],
      });

      // Returns void, synchronously: Nest awaits bootstrap hooks inside
      // `app.listen()`, so a hook that awaited the copy would hold the port shut.
      expect(migrator.onApplicationBootstrap()).toBeUndefined();
      expect(relocate).toHaveBeenCalledWith("startup");
    });

    it("does not let a failure escape either entry point", async () => {
      // The boot hook's promise floats, and an unhandled rejection terminates the
      // process on Node's default -- a failed copy must not be able to do that.
      jest
        .spyOn(migrator, "relocateAll")
        .mockRejectedValue(new Error("database down"));

      expect(() => migrator.onApplicationBootstrap()).not.toThrow();
      await expect(migrator.relocateOnSchedule()).resolves.toBeUndefined();
    });
  });
});
