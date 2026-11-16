import { Transform, Writable } from "stream";
import { createGzip } from "zlib";
import { createBackupEncryptStream } from "./backup-stream-crypto";
import {
  BackupEncryptionInput,
  createKeyWrappedEncryptStream,
} from "./backup-key-wrap";

/**
 * The write end of an export: JSON text in, gzip (and optionally an encrypted
 * container) out, to whatever the caller is writing to.
 *
 * Three things it exists to get right, all of which were wrong or absent before
 * issue #1070:
 *
 *  - **Backpressure.** `write` resolves when the pipeline has taken the chunk, so
 *    a slow client stops the reader inside the snapshot instead of letting an
 *    unbounded queue grow behind it. The generator feeding this is pulled, so
 *    "stop taking chunks" really does stop the database reads.
 *  - **Encryption without buffering.** A password produces a framed container
 *    (`backup-stream-crypto.ts`) rather than one AES-GCM message over the whole
 *    artifact, so the encrypted path streams like the plain one instead of
 *    assembling the entire backup in memory to compute a single auth tag.
 *  - **Not hanging when the client leaves.** A naked `drain` wait never settles
 *    for a cancelled download, and the export holds a `REPEATABLE READ`
 *    transaction and a pooled connection for as long as it is waiting. `close`
 *    and `error` on the target reject the pending operation, so the snapshot
 *    unwinds (PR1077-REV-004).
 */
export const RESPONSE_CLOSED_MESSAGE =
  "Backup export response closed before completion";

export class ExportWriter {
  private aborted: Error | null = null;
  private started = false;

  private constructor(
    private readonly gzip: Transform,
    private readonly tail: Transform,
    private readonly target: Writable,
    private readonly framer: Transform | null,
  ) {}

  /**
   * Builds the pipeline. Nothing reaches `target` until `start()` -- the caller
   * has headers to set (and a completeness verdict to reach) before the first
   * byte is unrecoverable.
   *
   * `async` because deriving the encryption key from a password is ~100ms of
   * scrypt and belongs on the threadpool, before any stream exists. A stored
   * backup key (the automatic backup) needs no derivation and writes v3.
   */
  static async create(
    target: Writable,
    encryption?: BackupEncryptionInput,
  ): Promise<ExportWriter> {
    const gzip = createGzip();
    const framer =
      encryption === undefined || encryption === ""
        ? null
        : typeof encryption === "string"
          ? await createBackupEncryptStream(encryption)
          : createKeyWrappedEncryptStream(encryption);
    if (framer) gzip.pipe(framer);
    return new ExportWriter(gzip, framer ?? gzip, target, framer);
  }

  /** Attaches the pipeline to the target. Call once, after the headers are set. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.tail.pipe(this.target);
  }

  /**
   * Marks the export as failed. Called when the response goes away: the
   * transform is destroyed so it cannot retain buffered output, and the next
   * `write` rejects so the snapshot transaction unwinds.
   */
  abort(error: Error): void {
    if (this.aborted === null) this.aborted = error;
    this.destroy();
  }

  destroy(): void {
    if (!this.gzip.destroyed) this.gzip.destroy();
    if (this.framer && !this.framer.destroyed) this.framer.destroy();
  }

  /** Whether the target has gone away under us. */
  get abortError(): Error | null {
    return this.aborted;
  }

  write(text: string): Promise<void> {
    return this.operation((done) => {
      this.gzip.write(text, done);
    });
  }

  /**
   * Flushes the pipeline and waits for the target to accept the last byte.
   *
   * Waiting for the target rather than for gzip matters for both callers: the
   * buffered path would otherwise return a Buffer missing its tail, and the
   * framed container's final frame is written during the flush, after gzip has
   * already reported itself finished.
   */
  async finish(): Promise<void> {
    await this.operation((done) => {
      this.gzip.end(() => done());
    });
    await this.operation((done) => {
      if (this.target.writableFinished) {
        done();
        return;
      }
      this.target.once("finish", () => done());
    });
  }

  /**
   * One pipeline operation that cannot wait forever after the target disappears.
   * `close` and `error` reject it, so the caller's `await` unwinds and
   * `withScopedDb` releases the transaction.
   */
  private operation(
    start: (done: (error?: Error | null) => void) => void,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.aborted !== null) {
        reject(this.aborted);
        return;
      }
      let settled = false;
      const cleanup = (): void => {
        this.target.off("close", onClose);
        this.target.off("error", onError);
        this.gzip.off("error", onError);
        this.framer?.off("error", onError);
      };
      const done = (error?: Error | null): void => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve();
      };
      const onClose = (): void =>
        done(this.aborted ?? new Error(RESPONSE_CLOSED_MESSAGE));
      const onError = (error: Error): void => done(error);
      this.target.once("close", onClose);
      this.target.once("error", onError);
      this.gzip.once("error", onError);
      this.framer?.once("error", onError);
      try {
        start(done);
      } catch (error) {
        done(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
}
