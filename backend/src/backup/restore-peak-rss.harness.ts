import { Logger } from "@nestjs/common";
import { fork } from "child_process";
import { randomBytes, randomUUID } from "crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir, totalmem } from "os";
import { join } from "path";
import { promisify } from "util";
import { gunzip, gzipSync } from "zlib";
import { detectProcessMemoryLimitBytes } from "./backup-limits";
import { decryptBackup, encryptBackup } from "./backup-crypto.util";
import { collectRowIdRemap, deepRemapIds } from "./backup-id-remap.util";

/**
 * Measures what a restore actually costs, so `PEAK_MULTIPLE` can stop being an
 * estimate (DR-F3RB-004, issue #1073).
 *
 * `PEAK_MULTIPLE = 3` is argued from allocation counting: an encrypted upload
 * holds the envelope, the decipher output, `Buffer.concat`'s buffer, the
 * decompressed payload, the UTF-8 string and the parsed object graph, several of
 * them at once. Every ceiling in the restore path is then derived by dividing by
 * that number, so none of them can vouch for it -- and on the default 400 MiB pod
 * a true multiple above 3.04 puts a single admitted restore over the container.
 * The only thing that settles it is a measurement.
 *
 * ## What this measures, and what it does not
 *
 * One case per process, so a peak is attributable to one artifact: the parent
 * builds each artifact and forks a child that does nothing but decode it. The
 * child samples its own RSS every `SAMPLE_INTERVAL_MS` and reports the highest
 * reading, with `ru_maxrss` recorded beside it for comparison rather than used as
 * the answer -- a high-water mark a process can start with already set cannot
 * serve as that process's baseline, and reading it as one is how the first run of
 * this harness produced numbers above 6 that meant nothing.
 *
 * The child runs the **compiled** build wherever one exists, because under
 * ts-node the TypeScript compiler allocates inside the process being measured.
 *
 * Measured, in the order the restore does them: read the artifact, decrypt it,
 * `gunzip` it under `maxOutputLength`, `toString("utf-8")` it, `JSON.parse` it,
 * collect the id remap, and rewrite every row through it. The parsed graph and the
 * remapped copy are both held to the end, because that is what
 * `BackupRestoreService.restoreData` does: `rawData` stays referenced while
 * `remapBackupIds` builds its deep copy.
 *
 * **Not measured: the database phase.** Attachment staging and the insert
 * transaction hold their own buffers and TypeORM batches on top of everything
 * above, and reproducing them needs a live PostgreSQL and an RLS context. So the
 * multiple this reports is a **lower bound** on the true one, and the record it
 * writes says so. A measurement that covers the whole path belongs in the
 * integration job, which already has a database.
 *
 * **Not measured: whether the container survives.** A cgroup-constrained run --
 * `docker run --memory=400m` -- is what proves the refusal happens instead of an
 * OOM kill, and it needs a Docker daemon. The harness reports the cgroup limit it
 * can see (`null` when there is none) so a record cannot silently claim a
 * constrained run it did not have.
 *
 * ## Reading the result
 *
 * `impliedMultiple` is `(peakRss - baselineRss) / expandedBytes`, which is the
 * shape the code models: the process baseline is reserved separately
 * (`restoreProcessBaselineBytes`) and the restore's cost is a multiple of the
 * expanded payload on top of it. A case whose implied multiple exceeds
 * `PEAK_MULTIPLE` is a finding, not a curiosity.
 *
 * Run it with `npm run backup:peak-rss` (see `--help`). Nothing imports this file
 * at runtime; it is excluded from coverage as a `*.harness.ts`.
 */

const logger = new Logger("RestorePeakRss");
const gunzipAsync = promisify(gunzip);

const MIB = 1024 * 1024;
/**
 * The password the harness encrypts its own synthetic artifacts under, minted
 * fresh for each run and handed to the measuring children through the
 * environment.
 *
 * It was a string literal, which is the shape of a credential even when it is
 * not one -- a scanner reads it as a hard-coded secret (CWE-798) and it is right
 * to: the way to tell a real secret from a placeholder is not the value. This
 * protects nothing (the artifacts are generated, measured and deleted inside one
 * run), and a random value per run says so in a way nobody has to take on trust.
 */
const newHarnessPassword = (): string => randomBytes(24).toString("base64url");

/** Where the parent hands its per-run password to the children it forks. */
const PASSWORD_ENV = "MONIZE_PEAK_RSS_PASSWORD";

/** What a case's rows look like, which is what decides its compression ratio. */
type Profile = "repetitive" | "mixed" | "attachments";

interface HarnessCase {
  readonly id: string;
  readonly profile: Profile;
  readonly encrypted: boolean;
  readonly why: string;
}

/**
 * The matrix. Compression ratio and encryption are the two axes that change the
 * set of buffers live at the peak, so each is varied against the other.
 */
export const HARNESS_CASES: readonly HarnessCase[] = [
  {
    id: "repetitive-plain",
    profile: "repetitive",
    encrypted: false,
    why: "the cheapest upload that reaches the expanded ceiling: a tiny gzip, a full-size graph",
  },
  {
    id: "repetitive-encrypted",
    profile: "repetitive",
    encrypted: true,
    why: "the same, plus the envelope, the decipher output and Buffer.concat",
  },
  {
    id: "mixed-plain",
    profile: "mixed",
    encrypted: false,
    why: "transaction-shaped rows: many short strings and UUIDs, the ordinary case",
  },
  {
    id: "mixed-encrypted",
    profile: "mixed",
    encrypted: true,
    why: "the ordinary case as most artifacts actually arrive",
  },
  {
    id: "attachments-encrypted",
    profile: "attachments",
    encrypted: true,
    why: "base64 attachment bytes: incompressible, so the wire is the payload",
  },
];

/**
 * How a case ended. `heap-exhausted` is not a harness failure -- it is the
 * measurement: V8 could not complete the decode inside the heap it was given.
 */
type CaseOutcome = "measured" | "heap-exhausted" | "failed";

interface CaseResult {
  id: string;
  profile: Profile;
  encrypted: boolean;
  outcome: CaseOutcome;
  /** Which runtime the measuring process ran under. Only `compiled` is evidence. */
  runtime: "compiled" | "ts-node";
  wireBytes: number;
  expandedBytes: number;
  baselineRssBytes: number;
  peakRssBytes: number;
  /** `ru_maxrss`, reported for comparison only -- see `measureCase`. */
  highWaterRssBytes: number;
  /** `null` when the case never finished, so nothing can average it away. */
  impliedMultiple: number | null;
  /** Set only for `failed`: why, so a harness bug cannot read as a measurement. */
  error?: string;
}

/** How often the measuring process samples its own RSS. */
const SAMPLE_INTERVAL_MS = 10;

/** This process's resident set right now. */
const currentRssBytes = (): number => process.memoryUsage.rss();

/**
 * `ru_maxrss`, in bytes. A high-water mark, and on Linux one a process can start
 * with already set -- so it is recorded beside the sampled peak rather than used
 * as one.
 */
const inheritablePeakRssBytes = (): number =>
  process.resourceUsage().maxRSS * 1024;

/**
 * Whether this process is the compiled build rather than ts-node.
 *
 * It matters: under ts-node the TypeScript compiler runs *inside the process
 * being measured*, and its allocations are indistinguishable from the restore's.
 * The first run of this harness measured implied multiples above 6 that way. A
 * ts-node run is still useful for developing the harness; it is not evidence, and
 * the record says which one produced it.
 */
const compiledRuntime = (): boolean => __filename.endsWith(".js");

// ---------------------------------------------------------------------------
// Artifact generation. Runs in the parent, never in a measuring child: building
// a 96 MiB document would put its own allocations into the child's peak.
// ---------------------------------------------------------------------------

/** A row whose ids the remap will rewrite and whose text is highly repetitive. */
function repetitiveRow(): Record<string, unknown> {
  return {
    id: randomUUID(),
    account_id: randomUUID(),
    category_id: randomUUID(),
    payee_name: "Recurring monthly subscription",
    description: "Recurring monthly subscription payment, standard rate",
    amount: "-19.9900",
    currency_code: "USD",
    transaction_date: "2026-01-15",
    status: "CLEARED",
  };
}

/** Transaction-shaped rows with varied text: the ordinary artifact. */
function mixedRow(index: number): Record<string, unknown> {
  return {
    id: randomUUID(),
    account_id: randomUUID(),
    category_id: randomUUID(),
    linked_transaction_id: randomUUID(),
    payee_name: `Merchant ${index} ${randomUUID().slice(0, 8)}`,
    description: `Purchase ${index} reference ${randomUUID()}`,
    amount: `${((index % 9973) / 100 - 49).toFixed(4)}`,
    currency_code: index % 3 === 0 ? "EUR" : "USD",
    transaction_date: `2026-${String((index % 12) + 1).padStart(2, "0")}-14`,
    tag_ids: [randomUUID(), randomUUID()],
    status: index % 7 === 0 ? "PENDING" : "CLEARED",
  };
}

/**
 * Attachment rows: one 64 KiB base64 blob each. Incompressible by construction,
 * so this is the case where the compressed upload is nearly the payload -- the
 * opposite end from `repetitive`.
 */
function attachmentRow(): Record<string, unknown> {
  const bytes = Buffer.alloc(48 * 1024);
  for (let i = 0; i < bytes.length; i += 4)
    bytes.writeUInt32LE(Math.trunc(i * 2654435761) >>> 0, i);
  return {
    id: randomUUID(),
    attachment_id: randomUUID(),
    data: bytes.toString("base64"),
  };
}

function rowFor(profile: Profile, index: number): Record<string, unknown> {
  if (profile === "repetitive") return repetitiveRow();
  if (profile === "attachments") return attachmentRow();
  return mixedRow(index);
}

/** The table a profile's rows belong in, so the artifact reads like a real one. */
const TABLE_FOR: Record<Profile, string> = {
  repetitive: "transactions",
  mixed: "transactions",
  attachments: "attachment_blobs",
};

/**
 * Build one artifact whose decompressed JSON is about `targetBytes`.
 *
 * Rows are serialised individually and the document assembled from the strings,
 * so the target is hit by construction rather than by re-stringifying a growing
 * array (which is quadratic and, at these sizes, slower than the measurement).
 */
function buildArtifact(profile: Profile, targetBytes: number): Buffer {
  const head = `{"version":1,"exportedAt":"2026-08-25T00:00:00.000Z","${TABLE_FOR[profile]}":[`;
  const parts: string[] = [head];
  let size = head.length + 2;
  let index = 0;
  while (size < targetBytes) {
    const row = JSON.stringify(rowFor(profile, index));
    const piece = index === 0 ? row : `,${row}`;
    parts.push(piece);
    size += piece.length;
    index += 1;
  }
  parts.push("]}");
  return Buffer.from(parts.join(""), "utf-8");
}

// ---------------------------------------------------------------------------
// The measurement. Runs in a forked child, one case per process.
// ---------------------------------------------------------------------------

/**
 * Decode one artifact exactly as the restore path does, and report the peak.
 *
 * The `sink` exists to keep both the parsed graph and the remapped copy reachable
 * until the peak is read: dropping either would measure a pipeline the production
 * code does not run.
 */
async function measureCase(
  spec: HarnessCase,
  artifactPath: string,
  expandedLimitBytes: number,
  password: string,
): Promise<CaseResult> {
  // Two independent readings, because the first version of this harness trusted
  // one and was wrong twice over. `ru_maxrss` is a high-water mark that a process
  // can inherit, so taking it as the baseline hid however much the child had
  // already allocated below that mark; and a sampled RSS can miss a peak between
  // samples. They are reported side by side: a run where they disagree is a run
  // that measured its own instrumentation.
  const baselineRssBytes = currentRssBytes();
  let sampledPeak = baselineRssBytes;
  const sampler = setInterval(() => {
    sampledPeak = Math.max(sampledPeak, currentRssBytes());
  }, SAMPLE_INTERVAL_MS);
  sampler.unref?.();
  const sink: unknown[] = [];

  const wire = readFileSync(artifactPath);
  sink.push(wire);
  const gzipped = spec.encrypted ? await decryptBackup(wire, password) : wire;
  sink.push(gzipped);
  const decompressed = await gunzipAsync(gzipped, {
    maxOutputLength: expandedLimitBytes,
  });
  sink.push(decompressed);
  const json = decompressed.toString("utf-8");
  sink.push(json);
  const parsed = JSON.parse(json) as Record<string, unknown>;
  sink.push(parsed);

  const remap = new Map<string, string>();
  for (const [table, rows] of Object.entries(parsed)) {
    if (table === "currencies" || !Array.isArray(rows)) continue;
    collectRowIdRemap(rows, remap, randomUUID);
  }
  const remapped: Record<string, unknown> = { ...parsed };
  for (const [table, rows] of Object.entries(parsed)) {
    if (table === "currencies" || !Array.isArray(rows)) continue;
    remapped[table] = rows.map((row) => deepRemapIds(row, remap));
  }
  sink.push(remapped);

  clearInterval(sampler);
  const peak = Math.max(sampledPeak, currentRssBytes());
  // Read something off the sink so no engine can argue it is dead.
  if (sink.length !== 6) throw new Error("harness sink lost a stage");

  return {
    id: spec.id,
    profile: spec.profile,
    encrypted: spec.encrypted,
    outcome: "measured",
    runtime: compiledRuntime() ? "compiled" : "ts-node",
    wireBytes: wire.length,
    expandedBytes: decompressed.length,
    baselineRssBytes,
    peakRssBytes: peak,
    highWaterRssBytes: inheritablePeakRssBytes(),
    impliedMultiple: (peak - baselineRssBytes) / decompressed.length,
  };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

interface Options {
  /**
   * Expanded sizes to sweep, in bytes.
   *
   * More than one because the multiple is not constant: a fixed overhead divided
   * by a smaller payload reads as a larger multiple, so a single size cannot say
   * whether the model is linear. Measuring three answers it.
   */
  targetBytesList: number[];
  /** The size the current child is measuring. */
  targetBytes: number;
  repeat: number;
  caseId?: string;
  recordPath?: string;
  /**
   * The `--max-old-space-size` values to sweep, in MiB; `null` means "whatever
   * V8 picks", which is what this repository currently ships.
   *
   * The dimension that turns out to matter most, and the one nothing here sets:
   * V8 sizes its old space from **host** memory, not from the cgroup limit, so an
   * unbounded heap lets garbage accumulate until the kernel kills the pod --
   * while the memory model in `backup-limits.ts` assumes a process uses what it
   * needs. Sweeping tells "the restore needs N" apart from "V8 was allowed N",
   * and finds the smallest heap in which a given artifact can be decoded at all.
   */
  childHeapMibs: Array<number | null>;
}

function parseOptions(argv: string[]): Options {
  const value = (name: string): string | undefined =>
    argv.find((arg) => arg.startsWith(`--${name}=`))?.split("=")[1];
  const targets = (value("target-mib") ?? "96")
    .split(",")
    .map((entry) => Math.trunc(Number(entry)))
    .filter((entry) => Number.isFinite(entry) && entry > 0)
    .map((entry) => entry * MIB);
  const repeat = Number(value("repeat") ?? 1);
  const heaps = value("child-heap-mib");
  return {
    targetBytesList: targets.length > 0 ? targets : [96 * MIB],
    targetBytes: targets[0] ?? 96 * MIB,
    repeat: Math.max(1, Math.trunc(repeat)),
    caseId: value("case"),
    recordPath: value("record"),
    childHeapMibs:
      heaps === undefined
        ? [null]
        : heaps
            .split(",")
            .map((entry) => Math.trunc(Number(entry)))
            .filter((entry) => Number.isFinite(entry) && entry > 0),
  };
}

/** The child half: measure the one case it was told to, report over IPC. */
async function runChild(options: Options): Promise<void> {
  const spec = HARNESS_CASES.find((entry) => entry.id === options.caseId);
  const artifactPath = process.env.MONIZE_PEAK_RSS_ARTIFACT;
  if (!spec || !artifactPath) {
    throw new Error(`Unknown case "${options.caseId}" or missing artifact`);
  }
  // Required rather than regenerated: a child that minted its own password would
  // fail to decrypt the artifact the parent encrypted, and report it as a case
  // that could not be measured.
  const password = process.env[PASSWORD_ENV];
  if (spec.encrypted && !password) {
    throw new Error(`${PASSWORD_ENV} was not passed to the measuring child`);
  }
  // Twice the target, so the ceiling never decides the measurement.
  try {
    const result = await measureCase(
      spec,
      artifactPath,
      options.targetBytes * 2,
      password ?? "",
    );
    process.send?.(result);
  } catch (error) {
    // A real heap exhaustion aborts the process before this line, so anything
    // that gets here is a harness fault -- a wrong size, a missing artifact, a
    // bad password. Reporting it as `heap-exhausted` is how a bug becomes a
    // measurement: this run once recorded five "exhausted" cases that were a
    // ceiling passed in wrongly. The parent refuses such a result outright.
    process.send?.({
      id: spec.id,
      profile: spec.profile,
      encrypted: spec.encrypted,
      outcome: "failed",
      runtime: compiledRuntime() ? "compiled" : "ts-node",
      wireBytes: 0,
      expandedBytes: 0,
      baselineRssBytes: 0,
      peakRssBytes: 0,
      highWaterRssBytes: 0,
      impliedMultiple: null,
      error: (error as Error).message,
    } satisfies CaseResult);
  }
}

/**
 * Where the measuring child's code comes from.
 *
 * The compiled build if there is one, so the process being measured is not also
 * running the TypeScript compiler. `execArgv: []` matters as much as the path:
 * `fork` passes the parent's `-r ts-node/register` on by default, which would
 * load ts-node into the compiled child and undo the point of choosing it.
 */
function childEntry(): { path: string; execArgv: string[] } {
  if (compiledRuntime()) return { path: __filename, execArgv: [] };
  const compiled = join(
    __dirname,
    "..",
    "..",
    "dist",
    "backup",
    "restore-peak-rss.harness.js",
  );
  if (existsSync(compiled)) return { path: compiled, execArgv: [] };
  return { path: __filename, execArgv: process.execArgv };
}

/**
 * Run one case in a fresh process and return its result.
 *
 * A child that dies without reporting is recorded as `heap-exhausted` rather
 * than thrown: under a heap cap that is the answer to the question being asked,
 * and aborting the sweep would throw away every case after it.
 */
function measureInChild(
  spec: HarnessCase,
  artifactPath: string,
  options: Options,
  heapMib: number | null,
  password: string,
): Promise<CaseResult> {
  const entry = childEntry();
  const execArgv =
    heapMib === null
      ? entry.execArgv
      : [...entry.execArgv, `--max-old-space-size=${heapMib}`];
  return new Promise((resolve, reject) => {
    const child = fork(
      entry.path,
      [`--case=${spec.id}`, `--target-mib=${options.targetBytes / MIB}`],
      {
        env: {
          ...process.env,
          MONIZE_PEAK_RSS_ARTIFACT: artifactPath,
          [PASSWORD_ENV]: password,
        },
        execArgv,
        // V8's own out-of-memory report goes to the child's stderr; the parent
        // does not relay it, because the outcome is what matters and a stack
        // from inside the collector tells the reader nothing.
        stdio: [
          "ignore",
          "ignore",
          process.env.MONIZE_PEAK_RSS_DEBUG ? "inherit" : "ignore",
          "ipc",
        ],
      },
    );
    let result: CaseResult | undefined;
    child.on("message", (message) => (result = message as CaseResult));
    child.on("error", reject);
    child.on("exit", () => {
      // A reported failure is a harness fault, and taking it for data is worse
      // than stopping: the sweep ends here rather than recording a zero.
      if (result?.outcome === "failed") {
        reject(new Error(`case ${spec.id} failed: ${result.error}`));
      } else if (result) resolve(result);
      else
        resolve({
          id: spec.id,
          profile: spec.profile,
          encrypted: spec.encrypted,
          outcome: "heap-exhausted",
          runtime: entry.execArgv.length > 0 ? "ts-node" : "compiled",
          wireBytes: 0,
          expandedBytes: 0,
          baselineRssBytes: 0,
          peakRssBytes: 0,
          highWaterRssBytes: 0,
          impliedMultiple: null,
        });
    });
  });
}

const mib = (bytes: number) => `${(bytes / MIB).toFixed(1)}MiB`;

/** The parent half: build each artifact, measure it, print and record. */
async function runParent(options: Options): Promise<void> {
  const workDir = mkdtempSync(join(tmpdir(), "monize-peak-rss-"));
  // One password for this run's artifacts, minted here and passed to each child.
  // It never leaves the process tree and nothing outlives the run: the artifacts
  // are deleted in the `finally` below.
  const password = newHarnessPassword();
  const cgroupLimit = detectProcessMemoryLimitBytes();
  logger.log(
    `Target expanded sizes ${options.targetBytesList.map(mib).join(", ")}, ${options.repeat} run(s) per case, ` +
      `cgroup limit ${cgroupLimit === null ? "none visible" : mib(cgroupLimit)}`,
  );
  if (cgroupLimit === null) {
    logger.warn(
      "No cgroup memory limit is visible, so this run cannot show whether a " +
        "restore is refused rather than OOM-killed. The implied multiple below " +
        "is still measured; the containment question needs docker run --memory.",
    );
  }
  const entry = childEntry();
  if (entry.execArgv.length > 0) {
    logger.warn(
      "No compiled build found, so each case is measured under ts-node -- the " +
        "TypeScript compiler allocates inside the process being measured and " +
        "inflates every peak. Run the build first; these numbers are not evidence.",
    );
  }

  interface Sweep {
    targetExpandedBytes: number;
    childHeapMib: number | null;
    cases: CaseResult[];
    maxImpliedMultiple: number | null;
    exhausted: string[];
  }

  const sweeps: Sweep[] = [];
  try {
    for (const targetBytes of options.targetBytesList) {
      // Artifacts are built once per size and reused across heap caps: the same
      // bytes have to be decoded in each, or the comparison is between two
      // artifacts rather than between two limits.
      const artifacts = new Map<string, string>();
      for (const spec of HARNESS_CASES) {
        const plain = buildArtifact(spec.profile, targetBytes);
        const gzipped = gzipSync(plain);
        const wire = spec.encrypted
          ? await encryptBackup(gzipped, password)
          : gzipped;
        const artifactPath = join(workDir, `${spec.id}-${targetBytes}.bin`);
        writeFileSync(artifactPath, wire);
        artifacts.set(spec.id, artifactPath);
      }

      for (const heapMib of options.childHeapMibs) {
        logger.log(
          `--- expanded ${mib(targetBytes)}, heap cap ${heapMib === null ? "unbounded (what this repository ships)" : `${heapMib}MiB`}`,
        );
        const cases: CaseResult[] = [];
        for (const spec of HARNESS_CASES) {
          const artifactPath = artifacts.get(spec.id) as string;
          // Max over the runs: a low sample on a shared runner is not evidence,
          // and the high one is what the kernel would have killed.
          const runs: CaseResult[] = [];
          for (let run = 0; run < options.repeat; run += 1) {
            runs.push(
              await measureInChild(
                spec,
                artifactPath,
                { ...options, targetBytes },
                heapMib,
                password,
              ),
            );
          }
          // Worst of the runs that PRODUCED a number, and `heap-exhausted` only
          // when none did. Ordering `null` as `Infinity` made a single exhausted
          // repeat outrank every measured one, so the case entered the record as
          // exhausted and its real samples never reached `maxImpliedMultiple` --
          // the figure `MEASURED_PEAK_MULTIPLE` and every derived ceiling come
          // from. A discarded measurement is worse than a missing one: nothing
          // downstream can tell it happened.
          const measuredRuns = runs.filter(
            (entry) => entry.impliedMultiple !== null,
          );
          const worst =
            measuredRuns.length === 0
              ? runs[0]
              : measuredRuns.reduce((a, b) =>
                  (b.impliedMultiple as number) > (a.impliedMultiple as number)
                    ? b
                    : a,
                );
          if (measuredRuns.length > 0 && measuredRuns.length < runs.length) {
            // Marginal rather than impossible, and the record would show only
            // the number. Say it where whoever runs the sweep can see it.
            logger.warn(
              `${spec.id}: ${runs.length - measuredRuns.length} of ` +
                `${runs.length} runs exhausted the heap; the reported multiple ` +
                `is from the rest`,
            );
          }
          cases.push(worst);
          logger.log(
            worst.outcome === "heap-exhausted"
              ? `${spec.id}: heap exhausted -- the decode could not complete`
              : `${spec.id}: wire ${mib(worst.wireBytes)}, expanded ${mib(worst.expandedBytes)}, ` +
                  `baseline ${mib(worst.baselineRssBytes)}, peak ${mib(worst.peakRssBytes)}, ` +
                  `implied multiple ${(worst.impliedMultiple as number).toFixed(2)}`,
          );
        }
        const measured = cases.filter(
          (entry) => entry.impliedMultiple !== null,
        );
        sweeps.push({
          targetExpandedBytes: targetBytes,
          childHeapMib: heapMib,
          cases,
          maxImpliedMultiple:
            measured.length === 0
              ? null
              : Number(
                  Math.max(
                    ...measured.map((entry) => entry.impliedMultiple as number),
                  ).toFixed(3),
                ),
          exhausted: cases
            .filter((entry) => entry.outcome === "heap-exhausted")
            .map((entry) => entry.id),
        });
      }
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }

  for (const sweep of sweeps) {
    logger.log(
      `expanded ${mib(sweep.targetExpandedBytes)}, ` +
        `heap ${sweep.childHeapMib === null ? "unbounded" : `${sweep.childHeapMib}MiB`}: ` +
        `highest implied multiple ${sweep.maxImpliedMultiple ?? "n/a"}, ` +
        `exhausted ${sweep.exhausted.length}/${sweep.cases.length}`,
    );
  }

  if (options.recordPath) {
    const record = {
      note: "Generated by src/backup/restore-peak-rss.harness.ts. Do not hand-edit.",
      issue: 1073,
      finding: "DR-F3RB-004",
      // The reasons this is not the whole answer, kept in the artifact so no
      // reader has to go looking for the caveats.
      coverage:
        "Decode phases only: read, decrypt, gunzip, utf-8, JSON.parse, id remap. " +
        "Attachment staging and the insert transaction are NOT measured, so the " +
        "implied multiple is a LOWER BOUND on a restore's true multiple.",
      cgroupConstrained: detectProcessMemoryLimitBytes() !== null,
      environment: {
        node: process.version,
        platform: `${process.platform}-${process.arch}`,
        cgroupMemoryLimitBytes: detectProcessMemoryLimitBytes(),
        totalSystemMemoryBytes: totalmem(),
      },
      targetExpandedBytesSwept: options.targetBytesList,
      runsPerCase: options.repeat,
      sweeps,
      maxImpliedMultiple: sweeps.reduce<number | null>(
        (max, sweep) =>
          sweep.maxImpliedMultiple === null
            ? max
            : Math.max(max ?? 0, sweep.maxImpliedMultiple),
        null,
      ),
    };
    writeFileSync(options.recordPath, `${JSON.stringify(record, null, 2)}\n`);
    logger.log(`Wrote ${options.recordPath}`);
  }
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  if (process.argv.includes("--help")) {
    logger.log(
      "Usage: backup:peak-rss [--target-mib=96] [--repeat=1] " +
        "[--child-heap-mib=304,512,1024] [--record=<path>]. One forked process " +
        "per case per heap cap; --case is used internally.",
    );
    return;
  }
  if (options.caseId) await runChild(options);
  else await runParent(options);
}

if (require.main === module) {
  main().catch((error: Error) => {
    logger.error(error.message, error.stack);
    process.exitCode = 1;
  });
}
