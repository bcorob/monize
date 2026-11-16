import { notifyAiAction } from "@/lib/aiActionSignal";
import { clearAllCache } from "@/lib/apiCache";
import { emailReceiptsApi } from "@/lib/email-receipts-api";
import type {
  EmailReceiptImportFileResult,
  EmailReceiptImportResult,
} from "@/types/email-receipts";
import type { PlanNote } from "./build-plan";
import type { UploadPart } from "./upload-plan";

/** How many times one request is retried after a 429. */
export const MAX_RATE_LIMIT_RETRIES = 6;
/** The wait when a 429 names none. */
export const DEFAULT_RETRY_WAIT_MS = 10_000;
/** A server asking for more than this is waited for this long, then asked again. */
const MAX_RETRY_WAIT_MS = 120_000;

export type ImportRunStatus = "complete" | "cancelled" | "failed";

/** Rows processed after the last part was stored (`POST /email-receipts/process-batch`). */
export interface ImportProcessing {
  /** Emails the processing run took through the pipeline. */
  processed: number;
  /** Emails that raised an error and were passed over. */
  failed: number;
  /** Stored emails still waiting when the run stopped; 0 after a complete run. */
  pendingLeft: number;
}

export interface ImportRunOutcome {
  /** Everything the requests that succeeded imported, summed under the selected file names. */
  result: EmailReceiptImportResult;
  /** What processing the new emails did; all zero when the upload did not finish. */
  processing: ImportProcessing;
  status: ImportRunStatus;
  /** The error that stopped the run; `null` unless `status` is `failed`. */
  error: unknown;
  /** Requests that succeeded. */
  completed: number;
  total: number;
}

/** How many emails one process-batch call takes. */
export const PROCESS_BATCH_LIMIT = 100;

export interface ImportRunOptions {
  signal?: AbortSignal;
  /** Called with the number of finished requests, before the first and after each. */
  onProgress?: (done: number, total: number) => void;
  /** Called after each processing call with the emails done so far and the total of this run. */
  onProcessProgress?: (done: number, total: number) => void;
  /** Injectable for tests. Resolves after `ms`, or at once when `signal` aborts. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

function responseOf(
  error: unknown,
): { status?: number; headers?: unknown } | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const response = (error as { response?: unknown }).response;
  return typeof response === "object" && response !== null
    ? response
    : undefined;
}

export function isRateLimited(error: unknown): boolean {
  return responseOf(error)?.status === 429;
}

/** The wait a 429 asks for (`Retry-After` in seconds), else the default. */
export function retryWaitMs(error: unknown): number {
  const headers = responseOf(error)?.headers as
    | { get?: (name: string) => unknown; [key: string]: unknown }
    | undefined;
  const raw =
    headers?.["retry-after"] ??
    headers?.["Retry-After"] ??
    headers?.get?.("retry-after");
  const seconds =
    typeof raw === "string" || typeof raw === "number" ? Number(raw) : NaN;
  if (!Number.isFinite(seconds) || seconds < 0) return DEFAULT_RETRY_WAIT_MS;
  return Math.min(Math.round(seconds * 1000), MAX_RETRY_WAIT_MS);
}

/** Sums per-file entries under their origin name; results come in order of first appearance. */
class ResultMerger {
  private readonly files = new Map<string, EmailReceiptImportFileResult>();
  private truncated = 0;

  add(origin: string, entry: EmailReceiptImportFileResult): void {
    const known = this.files.get(origin);
    if (!known) {
      this.files.set(origin, { ...entry, name: origin });
      return;
    }
    this.files.set(origin, {
      name: origin,
      format: known.format ?? entry.format,
      messages: known.messages + entry.messages,
      stored: known.stored + entry.stored,
      duplicates: known.duplicates + entry.duplicates,
      skipped: known.skipped + entry.skipped,
      ignoredEntries: known.ignoredEntries + entry.ignoredEntries,
      error: known.error ?? entry.error,
    });
  }

  addResponse(
    parts: readonly UploadPart[],
    response: EmailReceiptImportResult,
  ): void {
    // The server answers in the order it was sent; a count that differs falls back to names.
    const byOrder = response.files.length === parts.length;
    const byName = new Map(parts.map((part) => [part.file.name, part.origin]));
    response.files.forEach((entry, index) => {
      const origin = byOrder
        ? parts[index].origin
        : (byName.get(entry.name) ?? entry.name);
      this.add(origin, entry);
    });
    this.truncated += response.truncated;
  }

  /** New rows the requests stored: what waits for processing before the first answer says more. */
  storedTotal(): number {
    let sum = 0;
    for (const file of this.files.values()) sum += file.stored;
    return sum;
  }

  result(): EmailReceiptImportResult {
    return {
      files: [...this.files.values()],
      truncated: this.truncated,
      // The requests do not process (`process=false`); see `ImportRunOutcome.processing`.
      processed: 0,
      busy: false,
    };
  }
}

function aborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

type Attempt<T> =
  | { ok: true; value: T }
  | { ok: false; cancelled: boolean; error: unknown };

/** One call; a 429 waits and retries, any other failure (or a cancel while waiting) ends it. */
async function attemptWithRetries<T>(
  call: () => Promise<T>,
  signal: AbortSignal | undefined,
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>,
): Promise<Attempt<T>> {
  let attempt = 0;
  for (;;) {
    try {
      return { ok: true, value: await call() };
    } catch (error) {
      if (!isRateLimited(error) || attempt >= MAX_RATE_LIMIT_RETRIES) {
        return { ok: false, cancelled: false, error };
      }
      attempt += 1;
      await sleep(retryWaitMs(error), signal);
      if (aborted(signal)) return { ok: false, cancelled: true, error: null };
    }
  }
}

const NOTHING_PROCESSED: ImportProcessing = {
  processed: 0,
  failed: 0,
  pendingLeft: 0,
};

/**
 * Processes the emails the upload stored, `PROCESS_BATCH_LIMIT` at a time, passing
 * `since` back until nothing is left (the server's own end of a run). Only `pending`
 * emails: the ones the upload added, never a rematch of the rest of the mailbox.
 */
async function processPending(
  signal: AbortSignal | undefined,
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>,
  onProcessProgress: ImportRunOptions["onProcessProgress"],
  stored: number,
): Promise<{
  processing: ImportProcessing;
  status: ImportRunStatus;
  error: unknown;
}> {
  const processing = { ...NOTHING_PROCESSED, pendingLeft: stored };
  let since: string | undefined;
  for (;;) {
    if (aborted(signal))
      return { processing, status: "cancelled", error: null };
    const attempt = await attemptWithRetries(
      () =>
        emailReceiptsApi.receipts.processBatch({
          statuses: ["pending"],
          limit: PROCESS_BATCH_LIMIT,
          ...(since ? { since } : {}),
        }),
      signal,
      sleep,
    );
    if (!attempt.ok) {
      return {
        processing,
        status: attempt.cancelled ? "cancelled" : "failed",
        error: attempt.error,
      };
    }
    const answer = attempt.value;
    since = answer.since;
    processing.processed += answer.processed;
    processing.failed += answer.failed;
    processing.pendingLeft = answer.remaining;
    const done = processing.processed + processing.failed;
    onProcessProgress?.(done, done + answer.remaining);
    // A call that touched nothing ends the run, so a server that stopped making progress cannot loop it.
    if (answer.remaining <= 0 || answer.processed + answer.failed === 0) {
      return { processing, status: "complete", error: null };
    }
  }
}

/**
 * Sends the requests one after another (each only stores: `process=false`) and
 * merges what each one imported, then processes the new emails in one run of the
 * bulk route. A 429 waits and retries; any other failure stops the run and returns
 * what was already imported, with the error. A cancel (the signal) is honoured
 * between requests and between processing calls.
 */
export async function runImport(
  requests: readonly (readonly UploadPart[])[],
  options: ImportRunOptions = {},
): Promise<ImportRunOutcome> {
  const {
    signal,
    onProgress,
    onProcessProgress,
    sleep = defaultSleep,
  } = options;
  const merger = new ResultMerger();
  const total = requests.length;
  let completed = 0;
  onProgress?.(0, total);

  const outcome = (
    status: ImportRunStatus,
    error: unknown,
    processing: ImportProcessing = NOTHING_PROCESSED,
  ): ImportRunOutcome => ({
    result: merger.result(),
    processing,
    status,
    error,
    completed,
    total,
  });

  for (const parts of requests) {
    if (aborted(signal)) return outcome("cancelled", null);
    const attempt = await attemptWithRetries(
      () =>
        emailReceiptsApi.mailbox.import(
          parts.map((part) => part.file),
          { process: false },
        ),
      signal,
      sleep,
    );
    if (!attempt.ok) {
      return outcome(attempt.cancelled ? "cancelled" : "failed", attempt.error);
    }
    merger.addResponse(parts, attempt.value);
    completed += 1;
    onProgress?.(completed, total);
  }

  if (completed === 0) return outcome("complete", null);

  const run = await processPending(
    signal,
    sleep,
    onProcessProgress,
    merger.storedTotal(),
  );
  // A run can apply what an email proposed, as "Process all" does.
  if (run.processing.processed > 0) {
    clearAllCache();
    notifyAiAction();
  }
  return outcome(run.status, run.error, run.processing);
}

/**
 * Adds what planning found to the merged result: archive entries the browser
 * skipped, and an entry for a file that never reached the server (a damaged
 * archive, or one holding no mail).
 */
export function withPlanNotes(
  result: EmailReceiptImportResult,
  notes: readonly PlanNote[],
): EmailReceiptImportResult {
  const files = result.files.map((file) => ({ ...file }));
  for (const note of notes) {
    const known = files.find((file) => file.name === note.origin);
    if (known) {
      known.ignoredEntries += note.ignoredEntries;
      continue;
    }
    if (
      note.error === null &&
      note.oversizedMessages > 0 &&
      note.ignoredEntries === 0
    )
      continue;
    files.push({
      name: note.origin,
      format: note.error ? null : "zip",
      messages: 0,
      stored: 0,
      duplicates: 0,
      skipped: 0,
      ignoredEntries: note.ignoredEntries,
      error: note.error ?? "empty",
    });
  }
  return { ...result, files };
}
