import http from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { ConfigService } from "@nestjs/config";
import { S3BackupStorageTarget } from "./s3-backup-storage.target";
import { BackupStoreLocation } from "./backup-storage.interface";

/**
 * The `s3` backup store's deadline, proven against a live socket rather than a
 * mock, in the shape `s3-storage.provider.deadline.spec.ts` established.
 *
 * The bound matters here for the same reason it matters there and for one more:
 * the hourly backup cron claims a user's window by advancing `next_backup_at`
 * *before* the export, so a run that hangs does not retry -- it skips. An
 * operation that could stall indefinitely against an unreachable endpoint would
 * therefore hold a worker and lose the window with nothing recorded, rather than
 * failing the run and alerting.
 *
 * Socket inactivity timers cannot promise that: an endpoint that trickles a byte
 * at a time keeps the connection busy forever without ever going idle. These
 * tests run the real SDK stack -- client, handler, signer, retry middleware --
 * against exactly that endpoint and assert the operation is aborted by the total
 * deadline, promptly, with the error that names it.
 *
 * The trickle interval (25 ms) is far below the configured deadline (400 ms), so
 * the handler's inactivity timers -- set to the same 400 ms -- can never fire.
 * Only the whole-operation abort can end these requests.
 */
describe("S3BackupStorageTarget deadline against a stalled endpoint", () => {
  const DEADLINE_MS = 400;
  const TRICKLE_MS = 25;
  const USER_ID = "22222222-2222-4222-8222-222222222222";
  const ARTIFACT = "monize-backup-daily-2026-09-14.mzbe";

  let server: http.Server;
  const sockets = new Set<Socket>();

  type StallMode = "trickle-headers" | "trickle-body" | "ok";
  let mode: StallMode = "trickle-headers";

  const targetFor = (port: number): S3BackupStorageTarget =>
    new S3BackupStorageTarget({
      get: (key: string) =>
        ({
          BACKUP_STORE_S3_BUCKET: "stall-bucket",
          BACKUP_STORE_S3_PREFIX: "backups/",
          BACKUP_STORE_S3_ENDPOINT: `http://127.0.0.1:${port}`,
          BACKUP_STORE_S3_FORCE_PATH_STYLE: "true",
          BACKUP_STORE_S3_REGION: "us-east-1",
          BACKUP_STORE_S3_ACCESS_KEY_ID: "test",
          BACKUP_STORE_S3_SECRET_ACCESS_KEY: "test",
          BACKUP_STORE_S3_REQUEST_TIMEOUT_MS: String(DEADLINE_MS),
        })[key],
    } as unknown as ConfigService);

  let port: number;

  const located = async (): Promise<
    [S3BackupStorageTarget, BackupStoreLocation]
  > => {
    const target = targetFor(port);
    return [target, await target.resolveLocation(USER_ID)];
  };

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      // Accept the request body so the client is never blocked on backpressure.
      req.resume();
      if (mode === "ok") {
        res.writeHead(200, { etag: '"d41d8cd98f00b204e9800998ecf8427e"' });
        res.end();
        return;
      }
      if (mode === "trickle-body") {
        // Headers complete, so send() resolves and the caller is consuming the
        // body -- the phase no handler option bounds. Then never finish.
        res.writeHead(200, {
          "content-type": "application/xml",
          "content-length": "10000000",
        });
        const timer = setInterval(() => res.write("x"), TRICKLE_MS);
        res.on("close", () => clearInterval(timer));
        return;
      }
      // trickle-headers: a syntactically valid response that never completes its
      // header section, keeping the socket active so inactivity timers never fire.
      const socket = req.socket;
      socket.write("HTTP/1.1 200 OK\r\n");
      let n = 0;
      const timer = setInterval(() => {
        socket.write(`x-stall-${n++}: x\r\n`);
      }, TRICKLE_MS);
      socket.on("close", () => clearInterval(timer));
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  const expectDeadline = async (
    operation: () => Promise<unknown>,
    name: string,
  ): Promise<void> => {
    const started = Date.now();
    await expect(operation()).rejects.toThrow(
      new RegExp(`S3 ${name} exceeded its ${DEADLINE_MS} ms deadline`),
    );
    const elapsed = Date.now() - started;
    // Promptly: at the deadline, not at some multiple of it accumulated by
    // retries, and never unbounded.
    expect(elapsed).toBeGreaterThanOrEqual(DEADLINE_MS - 50);
    expect(elapsed).toBeLessThan(DEADLINE_MS * 8);
  };

  it("aborts a publish whose response never arrives", async () => {
    mode = "trickle-headers";
    const [target, location] = await located();
    await expectDeadline(
      () => target.publish(location, ARTIFACT, Buffer.from("payload")),
      "PutObject",
    );
  }, 15000);

  it("aborts a promotion whose response never arrives", async () => {
    mode = "trickle-headers";
    const [target, location] = await located();
    await expectDeadline(
      () =>
        target.promote(
          location,
          ARTIFACT,
          "monize-backup-weekly-2026-09-14.mzbe",
        ),
      "CopyObject",
    );
  }, 15000);

  it("aborts a listing whose response never arrives", async () => {
    mode = "trickle-headers";
    const [target, location] = await located();
    await expectDeadline(() => target.list(location), "ListObjectsV2");
  }, 15000);

  it("aborts a retention delete whose response never arrives", async () => {
    mode = "trickle-headers";
    const [target, location] = await located();
    await expectDeadline(
      () =>
        target.remove(location, {
          name: ARTIFACT,
          sizeBytes: 1,
          modifiedAt: new Date(),
          legacy: false,
        }),
      "DeleteObject",
    );
  }, 15000);

  it("aborts a capability probe whose response never arrives", async () => {
    mode = "trickle-headers";
    const [target] = await located();

    // The probe answers the settings screen, so it reports rather than throws --
    // but it reports the deadline, not a request still running behind it.
    const capability = await target.describeStore(USER_ID);

    expect(capability.available).toBe(false);
    expect(capability.reason).toMatch(
      new RegExp(`S3 HeadBucket exceeded its ${DEADLINE_MS} ms deadline`),
    );
  }, 15000);

  it("is not what fails a healthy operation", async () => {
    // The control: the same target, client and signature against the same server
    // responding promptly. Proves the aborts above come from the stall, not from
    // the harness.
    mode = "ok";
    const [target, location] = await located();
    await expect(
      target.publish(location, ARTIFACT, Buffer.from("payload")),
    ).resolves.toBeUndefined();
  }, 15000);
});
