import { ConfigService } from "@nestjs/config";
import { NotFoundException } from "@nestjs/common";
import { createHash } from "node:crypto";

import { MISSING_CONTEXT_MESSAGE } from "../common/db/scoped-db";
import {
  FetchSyncJob,
  FetchSyncService,
} from "../common/jobs/fetch-sync.service";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import { AttachmentOrphanSweeper } from "./attachment-orphan-sweeper.service";
import { AttachmentStorageMigrator } from "./storage/attachment-storage-migrator.service";
import { AttachmentStorageProvider } from "./storage/attachment-storage.interface";
import { AttachmentStorageRegistry } from "./storage/attachment-storage.registry";

/**
 * RLS smoke for the attachment relocation's boot and cron path (task R3).
 *
 * Unlike `attachment-storage-migrator.service.spec.ts`, this suite does NOT mock
 * `withScopedDb`: the real one runs (at the default RLS_MODE=off), so every
 * database access on the path -- the lease claim and its release included -- must
 * find an ambient context or `withScopedDb` throws its missing-context error.
 *
 * That is the gap this file exists for. The migrator's own spec substitutes a
 * `FetchSyncService` double, so a pass whose `withLease` ran outside any context
 * was green there and failed on the first boot after an operator switched
 * `ATTACHMENT_STORAGE_PROVIDER` to `s3`: "DB access outside request/user/system
 * context", before a single attachment was read.
 */
describe("attachments module RLS context smoke (real withScopedDb)", () => {
  const OWNER = "5c2f1a90-6f4f-4a2e-8f2a-1b7c9d0e3a55";
  const ATTACHMENT = "7a1e4b22-8c3d-4f61-9b0a-2e5d6c8f4711";
  const BYTES = Buffer.from("a scanned receipt");
  const DIGEST = createHash("sha256").update(BYTES).digest("hex");
  const LEASE_TOKEN = "1d9b7e40-2c55-4a18-9f3c-6b0d8e2a4417";

  /** An in-memory backend, so "the bytes moved" stays a fact about a store. */
  const makeStore = (
    name: string,
    seeded?: Buffer,
  ): AttachmentStorageProvider & { objects: Map<string, Buffer> } => {
    const objects = new Map<string, Buffer>();
    if (seeded) objects.set(ATTACHMENT, seeded);
    return {
      name,
      addressable: true,
      objects,
      save: jest.fn(async (key: string, data: Buffer) => {
        objects.set(key, Buffer.from(data));
      }),
      load: jest.fn(async (key: string) => {
        const found = objects.get(key);
        if (!found) throw new NotFoundException("no such object");
        return found;
      }),
      delete: jest.fn(async (key: string) => {
        objects.delete(key);
      }),
    };
  };

  /** The statements each of the relocation's transactions issues, in order. */
  const answerRelocationSql = (
    query: jest.Mock,
    state: { pending: boolean },
  ): void => {
    query.mockImplementation(async (sql: unknown) => {
      const text = String(sql);
      if (text.includes("INSERT INTO fetch_sync")) {
        return [{ lease_token: LEASE_TOKEN }];
      }
      if (text.includes("UPDATE fetch_sync")) return [];
      if (text.includes("FOR UPDATE")) {
        return [
          {
            id: ATTACHMENT,
            user_id: OWNER,
            storage_provider: "local",
            storage_key: ATTACHMENT,
            byte_size: String(BYTES.length),
            sha256: DIGEST,
          },
        ];
      }
      if (text.includes("ORDER BY id")) {
        // The keyset scan. Handing the batch over once is what ends the drain.
        const batch = state.pending
          ? [
              {
                id: ATTACHMENT,
                user_id: OWNER,
                storage_provider: "local",
                storage_key: ATTACHMENT,
                byte_size: String(BYTES.length),
                sha256: DIGEST,
              },
            ]
          : [];
        state.pending = false;
        return batch;
      }
      if (text.includes("FROM transaction_attachments")) {
        return state.pending ? [{ n: 1 }] : [];
      }
      if (text.includes("INSERT INTO attachment_blob_tombstones")) {
        return [{ id: "t1" }];
      }
      if (text.includes("DELETE FROM attachment_blob_tombstones")) {
        return [[{ id: "t1" }], 1];
      }
      return [];
    });
  };

  it("relocates a provider switch end to end without a missing-context throw", async () => {
    const { manager, dataSource } = createScopedDbMocks();
    answerRelocationSql(manager.query, { pending: true });
    const destination = makeStore("s3");
    const source = makeStore("local", BYTES);
    const sweeper = { sweepKey: jest.fn().mockResolvedValue(undefined) };

    const migrator = new AttachmentStorageMigrator(
      dataSource as never,
      new AttachmentStorageRegistry(destination, [destination, source]),
      new FetchSyncService(dataSource as never),
      sweeper as unknown as AttachmentOrphanSweeper,
      { get: () => undefined } as unknown as ConfigService,
    );
    const warn = jest
      .spyOn(migrator["logger"], "warn")
      .mockImplementation(() => undefined);

    const outcome = await migrator.relocateAll("smoke");

    // The pass is only reported green because every statement found a context:
    // the lease claim runs under the system identity the caller seeds, the scan
    // under the same one, and the per-row work under the owner's.
    expect(warn).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ moved: 1, failed: 0, unreachable: 0 });
    expect(destination.objects.get(ATTACHMENT)).toEqual(BYTES);
    expect(
      manager.query.mock.calls.filter(([sql]) =>
        String(sql).includes("INSERT INTO fetch_sync"),
      ),
    ).toHaveLength(1);
  });

  it("real withScopedDb still refuses the lease claim without a context", async () => {
    // The negative control: the claim is ordinary database access on a table that
    // belongs to no user, so it fails closed with no ambient identity -- proving
    // the smoke above passes because the migrator seeds one, and not because the
    // check is inert in this suite.
    const { dataSource } = createScopedDbMocks();
    const fetchSync = new FetchSyncService(dataSource as never);

    await expect(
      fetchSync.claim(FetchSyncJob.AttachmentRelocation, 1000),
    ).rejects.toThrow(MISSING_CONTEXT_MESSAGE);
  });
});
