import { Test, TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { PassThrough, Writable } from "stream";
import { createHash, randomBytes } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";
import { gunzipSync } from "zlib";
import { BackupExportService } from "./backup-export.service";
import { BLOB_EXPORT_BATCH_ROWS } from "./export-cursor";
import { buildExportTableQueries } from "./export-table-queries";
import {
  ATTACHMENT_STORAGE_PROVIDER,
  AttachmentStorageProvider,
} from "../attachments/storage/attachment-storage.interface";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import { emulatePgCursors } from "../test-helpers/pg-cursor-mock";
import { EncryptionService } from "../common/encryption/encryption.service";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

/**
 * What issue #1070 actually claimed, tested as ordering rather than as bytes.
 *
 * The claim is that peak memory tracks the chunk size rather than the dataset,
 * and the only honest way to measure that is the cgroup peak-RSS harness this
 * repository does not have. What a unit test *can* prove is the property the
 * claim rests on: the export never has the whole of anything in hand. Every case
 * below fails against the old implementation, which read each table with one
 * `manager.query`, base64-encoded every attachment into one array before
 * serialising, and produced one `JSON.stringify` per table.
 */
describe("export streaming", () => {
  const userId = "user-1";
  let service: BackupExportService;
  let statements: string[];
  let events: string[];
  let query: jest.Mock;
  let storage: jest.Mocked<AttachmentStorageProvider>;
  let storageName: string;
  let objects: Record<string, Buffer>;
  let tableRows: Record<string, Record<string, unknown>[]>;

  /** Incompressible, so gzip has to emit output rather than absorbing it. */
  const filler = (bytes: number) => randomBytes(bytes).toString("base64");

  function attachmentMetadata(): Record<string, unknown>[] {
    return Object.entries(objects).map(([id, bytes]) => ({
      id,
      storage_provider: storageName,
      byte_size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    }));
  }

  function route(sql: string): Promise<Record<string, unknown>[]> {
    const text = String(sql);
    if (
      text.includes("FROM transaction_attachments") &&
      !text.includes("attachment_blobs")
    ) {
      return Promise.resolve(attachmentMetadata());
    }
    const table = Object.keys(tableRows).find((name) =>
      new RegExp(`FROM ${name}\\b`).test(text),
    );
    return Promise.resolve(table ? tableRows[table] : []);
  }

  beforeEach(async () => {
    statements = [];
    events = [];
    objects = {};
    tableRows = {};
    storageName = "local";

    const scoped = createScopedDbMocks();
    const select = scoped.manager.query;
    select.mockImplementation(route);
    const inner = emulatePgCursors((sql: string, params?: unknown[]) =>
      select(sql, params),
    );
    query = jest.fn((sql: string, params?: unknown[]) => {
      statements.push(String(sql).trim());
      return inner(sql, params);
    });
    scoped.manager.query = query as jest.Mock;

    storage = {
      get name() {
        return storageName;
      },
      save: jest.fn().mockResolvedValue(undefined),
      load: jest.fn(async (key: string) => {
        events.push(`load:${key}`);
        const bytes = objects[key];
        if (!bytes) throw new Error(`no such object: ${key}`);
        return bytes;
      }),
      delete: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<AttachmentStorageProvider>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BackupExportService,
        { provide: DataSource, useValue: scoped.dataSource },
        { provide: ATTACHMENT_STORAGE_PROVIDER, useValue: storage },
        {
          // The export decrypts AI provider keys so they can be re-encrypted on
          // the way back in (ai-provider-key-transport.ts). These tests are
          // about ordering and memory, so the double just has to be present and
          // behave consistently.
          provide: EncryptionService,
          useValue: {
            isConfigured: () => true,
            encrypt: (s: string) => `enc:${s}`,
            decrypt: (s: string) => {
              if (!s.startsWith("enc:")) throw new Error("wrong key");
              return s.slice(4);
            },
          },
        },
      ],
    }).compile();
    service = module.get(BackupExportService);
  });

  /** A response double that records when bytes reach it. */
  function recordingResponse(): {
    res: import("express").Response;
    chunks: Buffer[];
  } {
    const stream = new PassThrough();
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      events.push("write");
    });
    const headers: Record<string, string> = {};
    const res = Object.assign(stream, {
      setHeader: (name: string, value: string | number) => {
        headers[name] = String(value);
        return res;
      },
      getHeader: (name: string) => headers[name],
    }) as unknown as import("express").Response;
    return { res, chunks };
  }

  it("writes bytes between attachment reads instead of loading them all first", async () => {
    // The defect, exactly: the export's attachment augmentation read every
    // object into one array of base64 before serialisation began, so thirty
    // 10 MiB receipts were ~400 MiB resident on a 400 MiB pod. Now each object is
    // read, written and dropped.
    for (const id of ["obj-1", "obj-2", "obj-3"]) {
      objects[id] = randomBytes(300 * 1024);
    }
    const { res, chunks } = recordingResponse();

    await service.streamExport(userId, res);

    const loads = events.flatMap((event, index) =>
      event.startsWith("load:") ? [index] : [],
    );
    // Six: the audit opens each object once to reach the completeness verdict
    // the response headers need before the first byte, and the body opens each
    // one again to write it. That is the deliberate trade -- one extra read of
    // each external object, for a verdict that costs no memory.
    expect(loads).toHaveLength(6);
    const firstWrite = events.indexOf("write");
    expect(firstWrite).toBeGreaterThan(loads[2]);

    // The body's three reads are separated by bytes going out, which is what
    // "one object at a time" looks like from outside. The old implementation
    // did all three with nothing in between and then serialised the array.
    const body = loads.slice(3);
    for (let i = 1; i < body.length; i += 1) {
      expect(events.slice(body[i - 1], body[i])).toContain("write");
    }

    const artifact = JSON.parse(
      gunzipSync(Buffer.concat(chunks)).toString("utf-8"),
    );
    expect(artifact.attachment_blobs).toHaveLength(3);
  });

  it("reads a large table through the cursor in batches", async () => {
    tableRows.transactions = Array.from({ length: 900 }, (_, i) => ({
      id: `t-${i}`,
      note: filler(40),
    }));
    const { res, chunks } = recordingResponse();

    await service.streamExport(userId, res);

    const fetches = statements.filter((sql) =>
      /^FETCH FORWARD \d+ FROM monize_export_/.test(sql),
    );
    const transactionsCursor = statements.find(
      (sql) => sql.startsWith("DECLARE") && /FROM transactions\b/.test(sql),
    );
    expect(transactionsCursor).toBeDefined();
    // 900 rows cannot arrive in one allocation any more.
    expect(fetches.length).toBeGreaterThan(40);
    const artifact = JSON.parse(
      gunzipSync(Buffer.concat(chunks)).toString("utf-8"),
    );
    expect(artifact.transactions).toHaveLength(900);
  });

  it("stops reading while a slow client is not taking bytes", async () => {
    // The other half of bounded memory: without backpressure the reader runs
    // ahead of the socket and the queue behind it is the dataset again.
    tableRows.transactions = Array.from({ length: 4000 }, (_, i) => ({
      id: `t-${i}`,
      note: filler(200),
    }));

    const pending: Array<() => void> = [];
    const blocked = new Writable({
      highWaterMark: 1,
      write(_chunk, _encoding, done) {
        pending.push(() => done());
      },
    });
    const slow = Object.assign(blocked, {
      setHeader: () => slow,
      getHeader: () => undefined,
    }) as unknown as import("express").Response;

    const tick = () => new Promise((resolve) => setImmediate(resolve));
    const finished = service.streamExport(userId, slow);
    // Let the pipeline fill until the blocked sink stops it. Polled rather than
    // counted: a fixed number of ticks is a race with the threadpool, and a
    // flaky guard is one that gets deleted.
    let filled = false;
    for (let i = 0; i < 5000 && !filled; i += 1) {
      filled = pending.length > 0;
      if (!filled) await tick();
    }
    expect(filled).toBe(true);
    // Nothing new is read while the client is not taking bytes.
    const stalled = statements.length;
    for (let i = 0; i < 100; i += 1) await tick();
    // Nothing new was read while the client was not taking bytes.
    expect(statements.length).toBe(stalled);
    // And it was stopped well short of the table.
    expect(stalled).toBeLessThan(4000);

    // Draining lets it finish, so this is a stall rather than a deadlock.
    const drain = setInterval(() => {
      while (pending.length > 0) pending.shift()?.();
    }, 0);
    await finished;
    clearInterval(drain);
    expect(statements.length).toBeGreaterThan(stalled);
  });

  it("sends the first bytes of an encrypted download before reading the last table", async () => {
    // The encrypted path used to buffer the entire artifact so AES-GCM could
    // compute one auth tag over it. With a framed container it streams, and the
    // proof is that bytes are on the socket before the export has finished
    // reading.
    tableRows.transactions = Array.from({ length: 2000 }, (_, i) => ({
      id: `t-${i}`,
      note: filler(200),
    }));
    const { res, chunks } = recordingResponse();
    const seenAtFirstWrite: number[] = [];
    res.on("data", () => seenAtFirstWrite.push(statements.length));

    await service.streamExport(userId, res, "a-password");

    const written = Buffer.concat(chunks);
    expect(written.subarray(0, 4).toString("ascii")).toBe("MZBE");
    expect(written[4]).toBe(2);
    // Statements were still being issued after the first bytes went out.
    expect(seenAtFirstWrite[0]).toBeLessThan(statements.length);
  });

  /**
   * The half of "bounded" a scan can hold.
   *
   * The behavioural cases above prove today's code streams. They cannot prove
   * that a whole-table read will not be added beside them -- and this defect has
   * been carried forward through five audits under four different labels, each
   * time by code that looked reasonable in isolation.
   */
  describe("source guards", () => {
    /**
     * Comments stripped: these files explain at length what they no longer do,
     * and a scan over the raw text would match the explanation and fail forever.
     */
    const read = (file: string) =>
      readFileSync(join(__dirname, file), "utf-8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/[^\n]*/g, "");

    it("reads export tables only through the cursor", () => {
      const stream = read("export-json-stream.ts");
      expect(stream).toContain("reader.rows(");
      // `reader.read` is the whole-result door, and a table is exactly what must
      // not go through it.
      expect(stream).not.toMatch(/reader\.read\(/);
    });

    it("keeps serialisation and compression out of the service", () => {
      // One place builds the document and one place compresses it. A
      // `JSON.stringify` here is how the per-table string came back last time.
      const service = read("backup-export.service.ts");
      expect(service).not.toMatch(/JSON\.stringify/);
      expect(service).not.toMatch(/gzipSync|createGzip/);
    });

    it("fetches the blob table one row at a time", () => {
      // Each row is a whole base64-encoded object, so this batch size *is* the
      // number of attachments resident at once. Dropping it would restore the
      // defect while every behavioural test above still passed.
      const blobs = buildExportTableQueries(async function* () {}).find(
        (entry) => entry.key === "attachment_blobs",
      );
      expect(blobs?.batchRows).toBe(BLOB_EXPORT_BATCH_ROWS);
      expect(BLOB_EXPORT_BATCH_ROWS).toBe(1);
    });
  });

  it("keeps the artifact identical whichever path produced it", async () => {
    // Three paths read one table list; an artifact that differs between them is
    // a restore that works from one download and not another.
    tableRows.accounts = [{ id: "a-1", name: "Checking" }];
    objects["obj-1"] = Buffer.from("receipt");

    const { res, chunks } = recordingResponse();
    await service.streamExport(userId, res);
    const streamed = JSON.parse(
      gunzipSync(Buffer.concat(chunks)).toString("utf-8"),
    );

    const { buffer } = await service.exportToBuffer(userId);
    const buffered = JSON.parse(gunzipSync(buffer).toString("utf-8"));

    const raw = await service.collectRawExport(userId);

    expect(buffered.accounts).toEqual(streamed.accounts);
    expect(buffered.attachment_blobs).toEqual(streamed.attachment_blobs);
    expect(raw.tables.accounts).toEqual(streamed.accounts);
    expect(raw.tables.attachment_blobs).toEqual(streamed.attachment_blobs);
  });
});
