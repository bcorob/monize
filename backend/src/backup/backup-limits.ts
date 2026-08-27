import { readFileSync } from "fs";

/**
 * Size ceilings for the backup paths that hold a whole payload in memory.
 *
 * Three of them, for three different failure modes.
 *
 * **The compressed upload** (`BACKUP_RESTORE_LIMIT`, `resolveRestoreUploadLimitBytes`).
 * `express.raw` buffers the whole body onto the heap *before* the controller, the
 * guards, the authentication lookup and every service-level ceiling, so this is
 * the only limit that can refuse a request none of those layers ever sees. It
 * defaulted to the literal `"500mb"` in `main.ts` on a pod the chart limits to
 * 400 MiB.
 *
 * **Restore decompression** (`BACKUP_RESTORE_EXPANDED_LIMIT`). Capping the
 * compressed upload bounds nothing about what comes out of gzip: a few hundred
 * kilobytes of repeated text expands to gigabytes, and `gunzipSync` with no
 * `maxOutputLength` allocated all of it -- before the version check, before the
 * format check, before anything that could refuse the request. On a single replica
 * that is every user's backend.
 *
 * **Buffered export** (`BACKUP_EXPORT_BUFFER_LIMIT`). The encrypted, automatic and
 * support export paths cannot stream: GCM needs the whole plaintext to compute its
 * auth tag, and the support export has to hold every table at once to reconcile
 * scaled balances. They accumulate rows, base64 attachment bytes, JSON strings and
 * a gzip buffer.
 *
 * ## A ceiling above the process limit is not a ceiling
 *
 * These defaults were fixed numbers -- 512 MiB of export JSON, 1 GiB of expanded
 * restore -- while the Helm chart's default backend limit is 400 MiB. So neither
 * one could ever fire: the pod was OOM-killed first, which is the outcome the
 * ceilings existed to prevent. The comment here even named the 400 MiB figure
 * while the constant below it said 512.
 *
 * Two things follow, and both are needed:
 *
 *  1. **Derive the default from the process's real memory limit**, read from the
 *     cgroup, rather than guessing a number that happens to suit one deployment.
 *     A ceiling has to be smaller than the thing it protects, and only the
 *     container knows how big that is.
 *  2. **Budget for the peak, not the payload.** A JSON payload of N bytes does
 *     not cost N. At the worst moment the per-table strings, the concatenated
 *     buffer, the gzip output and the parsed object graph are all live, so the
 *     limit is a fraction of available memory rather than most of it.
 *
 * All three environment variables still override everything: an operator who has
 * measured their own deployment knows better than a ratio. The Helm chart sets
 * them explicitly beside `resources.limits.memory` so the two cannot drift apart
 * silently, and an override the container cannot absorb gets a startup warning
 * against the threshold its own default was derived from -- a quarter of the
 * container for the buffered export (`warnIfLimitExceedsMemory`), and for the two
 * restore ceilings the measured peak budget (`warnIfRestoreUploadLimitIsUnsafe`).
 * A check compared against the wrong threshold warns on every deployment, which
 * is how the upload check came to be missing rather than merely unwired.
 *
 * ## The restore ceilings are derived from a measurement, and from the capacity
 *
 * `PEAK_MULTIPLE` was `3`, argued from allocation counting, and the expanded
 * ceiling was a quarter of the container -- so the same unmeasured constant sat in
 * the cost and in every ceiling derived from it. Issue #1073 measured it at 6.9 to
 * 7.9 and showed the old ceilings admitted restores the process cannot finish. Now
 * the ceiling is solved out of the capacity
 * (`deriveRestoreExpandedLimitBytes`), and the compressed upload ceiling is that
 * same number -- gzip output is never smaller than what it expands to, so a larger
 * upload is one this deployment could never decompress.
 */

/** Bytes in a mebibyte, spelled out where the defaults are set. */
const MIB = 1024 * 1024;

/**
 * Share of the container's memory limit a single buffered backup may account for.
 *
 * One quarter, because at the peak of a buffered export the same data is resident
 * several times over -- per-table JSON strings, the concatenated buffer, the gzip
 * output -- on top of the baseline the process needs to serve everything else
 * (the chart *requests* 140 MiB of its 400 MiB limit for exactly that). A ratio
 * rather than a measured multiplier because the multiplier depends on the dataset
 * shape; being conservative here costs a refused oversized export, and being
 * generous costs the process.
 */
const MEMORY_SHARE_PER_BACKUP = 0.25;

/**
 * What a restore costs, as the measurement actually shapes it: a slope and a
 * fixed part.
 *
 * `restore-peak-rss.record.json` reports an implied *multiple* per case, and that
 * multiple **rises as the artifact shrinks** -- 6.9 at 96 MiB, 8.0 at 24 MiB --
 * because part of the cost does not scale with the payload. Modelling it as one
 * multiple therefore has to pick which end to be right about, and picking the
 * worst-observed multiple is right at the small end and wasteful at the large one
 * -- while picking anything smaller admits restores that cannot run.
 *
 * So the model is the line the record actually fits: peak above the process
 * baseline is `slope * expanded + fixed`. These two numbers are the least-squares
 * slope over all 36 measured cases and the intercept that puts the line **above
 * every one of them** (not the regression's own intercept, which by construction
 * sits in the middle of the points -- a cost model that is right on average is
 * wrong half the time). `restore-peak-rss.record.spec.ts` re-checks both against
 * the record in both directions.
 *
 * Still a **lower bound**: the measurement covers the decode phases only, so
 * attachment staging and the insert transaction are not in it. That is what
 * `RESTORE_HEADROOM_SHARE` is for.
 */
export const MEASURED_PEAK_SLOPE = 6.081;

/**
 * The part of a restore's cost that does not shrink with the artifact.
 *
 * Roughly 77 MiB, on top of the process baseline: zlib's windows, the decoder's
 * own structures, and the heap V8 grows to parse and rewrite a document at all.
 * It is why a small pod cannot restore *anything* rather than restoring something
 * small -- the arithmetic that was wrong before this was measured said a 160 MiB
 * pod could decode a 2 MiB artifact inside 20 MiB of headroom, where the
 * measurement puts that decode at about 90 MiB.
 *
 * Measured against a bare decode process, so it does not double-count the 140 MiB
 * this file already reserves for an idle server: a restore allocates these on top
 * of whatever the process was already holding.
 */
export const MEASURED_PEAK_FIXED_BYTES = Math.ceil(77.6 * MIB);

/**
 * The peak resident memory one restore adds, for an expanded payload of this size.
 *
 * The whole cost model, in one place, so nothing downstream re-derives it from a
 * multiple. Used by the ceiling derivation and by the slot count; the upload
 * gate's per-request claim is deliberately coarser (see `PEAK_MULTIPLE`).
 */
export function restorePeakBytes(expandedBytes: number): number {
  return (
    Math.ceil(MEASURED_PEAK_SLOPE * expandedBytes) + MEASURED_PEAK_FIXED_BYTES
  );
}

/**
 * The per-byte factor the **upload** gate claims against, rounded up from the
 * measured slope.
 *
 * `restore-upload-admission.ts` budgets in *wire* bytes, and a compressed artifact
 * expands by an unknown ratio, so no exact model is available to it -- what it
 * needs is a factor that makes several small uploads add up to something the
 * budget can refuse. The fixed part is deliberately not in it: the gate's claim is
 * already an underestimate against expansion, and the ceiling and slot count use
 * `restorePeakBytes`, which is the honest model.
 *
 * This was `3`, argued from counting allocations rather than from measuring them,
 * and every ceiling in the restore path was derived by dividing by it -- so none of
 * them could vouch for it. The measurement (DR-F3RB-004, issue #1073) put the
 * decode phases alone at 6.9 to 8.0 times the expanded payload, so the old number
 * admitted restores this process cannot finish: four of five 96 MiB artifacts could
 * not be decoded inside the 304 MiB the old model left free on the chart's default
 * pod.
 */
export const PEAK_MULTIPLE = Math.ceil(MEASURED_PEAK_SLOPE);

/**
 * The fraction of the container's spare memory a restore may be offered.
 *
 * The margin over the measurement, and it is not decoration: the measured
 * multiple omits the database phase and grows on smaller artifacts, so the
 * derivation has to leave room for both. Fifteen per cent of the headroom stays
 * unspoken for, which on the chart's default pod is about 40 MiB.
 *
 * `backup-limits.spec.ts` asserts the resulting ceiling keeps at least a 15%
 * margin over `restorePeakBytes` at every supported pod size, so this cannot be
 * quietly raised to make a bigger artifact fit.
 */
export const RESTORE_HEADROOM_SHARE = 0.85;

/**
 * Peak memory a restore is assumed to be able to use when no container limit is
 * visible -- bare metal, a development machine, `docker run` with no `--memory`.
 *
 * Nothing can be derived in that case, so this is a judgement rather than a
 * calculation: a machine running PostgreSQL and this process can spare a gibibyte
 * for the peak of a rare, deliberate operation. It is a *peak* budget rather than
 * an artifact ceiling -- the expanded ceiling is this divided by `PEAK_MULTIPLE`,
 * which lands near where the old fixed fallback did while being arithmetically
 * coherent, where the old one modeled a 2.3 GiB peak without saying so.
 */
const UNKNOWN_RESTORE_PEAK_BUDGET_BYTES = 1024 * MIB;

/**
 * Floor and cap on a derived default.
 *
 * The floor keeps a small container (a 256 MiB dev pod) from deriving a ceiling
 * so low that ordinary datasets are refused -- below this, an operator should be
 * setting the limit deliberately rather than inheriting one. The cap keeps a
 * large container from deriving a number so high that the ceiling stops being a
 * meaningful guard against a hostile payload.
 */
const MIN_DERIVED_LIMIT_BYTES = 64 * MIB;
const MAX_DERIVED_LIMIT_BYTES = 1024 * MIB;

/**
 * Fallback when the process memory limit cannot be read -- bare metal, a
 * development machine, an unlimited container. Deliberately modest: this is the
 * case where nothing is known, and a ceiling that only fires on a genuinely
 * enormous payload is still better than none.
 */
const UNKNOWN_MEMORY_FALLBACK_BYTES = 256 * MIB;

/**
 * The container's memory limit in bytes, or null when there is no limit to read.
 *
 * cgroup v2 first (`memory.max`), then v1 (`memory.limit_in_bytes`). Both report
 * an absent limit as a sentinel -- the literal string `max` on v2, a number close
 * to 2^63 on v1 -- and both are treated as "unknown" rather than as a very large
 * limit, because deriving a ceiling from 8 exbibytes is the same as having none.
 */
export function detectProcessMemoryLimitBytes(): number | null {
  const candidates: Array<{
    path: string;
    unlimited: (raw: string) => boolean;
  }> = [
    { path: "/sys/fs/cgroup/memory.max", unlimited: (raw) => raw === "max" },
    {
      path: "/sys/fs/cgroup/memory/memory.limit_in_bytes",
      // v1 writes a rounded PAGE_SIZE multiple of 2^63 when unconstrained.
      unlimited: (raw) => Number(raw) > Number.MAX_SAFE_INTEGER,
    },
  ];

  for (const { path, unlimited } of candidates) {
    let raw: string;
    try {
      raw = readFileSync(path, "utf-8").trim();
    } catch {
      continue;
    }
    if (raw === "" || unlimited(raw)) continue;
    const bytes = Number(raw);
    if (Number.isFinite(bytes) && bytes > 0) return bytes;
  }
  return null;
}

/**
 * The default ceiling for one buffered backup payload on this container.
 *
 * Exported as a function rather than a constant because it reads the environment
 * the process is actually running in, and because a test needs to be able to ask
 * the question for a hypothetical container.
 */
export function deriveDefaultLimitBytes(
  memoryLimitBytes: number | null = detectProcessMemoryLimitBytes(),
): number {
  if (memoryLimitBytes === null) return UNKNOWN_MEMORY_FALLBACK_BYTES;
  const share = Math.floor(memoryLimitBytes * MEMORY_SHARE_PER_BACKUP);
  return Math.min(
    MAX_DERIVED_LIMIT_BYTES,
    Math.max(MIN_DERIVED_LIMIT_BYTES, share),
  );
}

/**
 * The largest expanded payload whose modeled peak fits this container.
 *
 * **Derived from the capacity, not from a share of it.** The old derivation took a
 * quarter of the container as the expanded ceiling and then modeled the peak as
 * `PEAK_MULTIPLE` times it -- so the same unmeasured constant sat in the numerator
 * of the cost and the denominator of every ceiling, and raising it to the measured
 * value would have made `computeRestoreProcessingSlots` return zero on every
 * ordinary pod. Solving for the ceiling instead keeps the measurement as the only
 * input and makes "one restore fits" true by construction rather than by luck:
 *
 *     expanded = (headroom * RESTORE_HEADROOM_SHARE - fixed) / slope
 *
 * **The fixed part is why a small pod gets nothing rather than something small.**
 * Dividing the headroom by a multiple alone said a 160 MiB pod could decode a
 * 2 MiB artifact in 20 MiB, and a 256 MiB pod a 12 MiB one in 116 MiB; the
 * measured line puts those decodes at about 90 MiB and 153 MiB. Subtracting the
 * fixed cost first turns both into an honest refusal -- and, at the other end,
 * hands a 1 GiB pod a *larger* ceiling than the multiple did, because the overhead
 * it was paying at every size is charged once.
 *
 * **No usability floor.** A usability minimum and a safety maximum are different
 * quantities, and resolving them with `max()` lets the floor win over the safety
 * (F3R6-005, which the upload limit learned first). A small container gets a small
 * ceiling and a startup warning saying so; it does not get a ceiling its own model
 * cannot survive.
 *
 * **Zero is a real answer.** A container whose baseline exceeds it has no room for
 * any restore, and saying so is what turns an OOM kill mid-restore into a 503 the
 * operator can act on (F3RB-005).
 */
export function deriveRestoreExpandedLimitBytes(
  memoryLimitBytes: number | null = detectProcessMemoryLimitBytes(),
): number {
  const peakBudget =
    memoryLimitBytes === null
      ? UNKNOWN_RESTORE_PEAK_BUDGET_BYTES
      : (memoryLimitBytes - restoreProcessBaselineBytes(memoryLimitBytes)) *
        RESTORE_HEADROOM_SHARE;
  // The fixed cost is spent before a single byte of payload is, so it comes out
  // of the budget first. A container that cannot afford it cannot restore at all,
  // however small the artifact -- which is a refusal, not a ceiling of zero-ish.
  const forPayload = peakBudget - MEASURED_PEAK_FIXED_BYTES;
  if (forPayload <= 0) return 0;
  return Math.min(
    MAX_DERIVED_LIMIT_BYTES,
    Math.floor(forPayload / MEASURED_PEAK_SLOPE),
  );
}

/**
 * The **resolved** decompression ceiling `gunzip` will enforce -- the operator's
 * `BACKUP_RESTORE_EXPANDED_LIMIT` if set, else the derived default.
 *
 * Standalone so the restore-processing slot calculation can budget against the
 * exact limit the parser uses, not a separately derived guess. The slot math read
 * `deriveDefaultLimitBytes` directly and so ignored an operator override entirely:
 * a 2 GiB override on a 16 GiB pod still modeled each restore at the 1 GiB derived
 * cap and admitted five of them (F3R7-002).
 */
export function resolveRestoreExpandedLimitBytes(
  raw: string | undefined = process.env.BACKUP_RESTORE_EXPANDED_LIMIT,
  memoryLimitBytes: number | null = detectProcessMemoryLimitBytes(),
  onInvalid?: (message: string) => void,
): number {
  // `onInvalid` is not optional decoration: this resolver replaced
  // `resolveConfiguredBackupLimit`, which logged an unreadable value, and without
  // it `BACKUP_RESTORE_EXPANDED_LIMIT=96MB ` (or `ninety-six`) falls back to the
  // derived default in silence -- the operator's setting simply does nothing and
  // nothing says so. Bootstrap passes a logger; see `main.ts`.
  return resolveByteLimit(
    raw,
    deriveRestoreExpandedLimitBytes(memoryLimitBytes),
    onInvalid,
  );
}

/**
 * Memory the ordinary Node/Nest process needs, reserved before restores get any.
 *
 * `max(140 MiB, a fifth of the container)`: a fixed floor because the V8/Nest
 * baseline does not shrink to nothing on a small pod, and a share because a large
 * pod runs more concurrent non-restore work.
 *
 * The floor is 140 MiB because that is what `helm/values.yaml` **requests** for
 * ordinary backend use, and the two numbers disagreeing was the clearest argument
 * in issue #1073 for measuring anything at all: this file reserved 96 MiB while
 * the chart promised the scheduler 140 MiB. The chart's figure wins because it is
 * a commitment the cluster acts on, and reserving more is the safe direction. The
 * peak-RSS harness measured about 69 MiB for a *bare* decode process, which is a
 * floor on this rather than a value for it -- it runs no HTTP server, no TypeORM
 * pool and no scheduler.
 */
export function restoreProcessBaselineBytes(memoryLimitBytes: number): number {
  return Math.max(140 * MIB, Math.floor(memoryLimitBytes * 0.2));
}

const UNITS: Record<string, number> = {
  b: 1,
  kb: 1024,
  mb: MIB,
  gb: 1024 * MIB,
};

/**
 * Parses a `bytes`-style size ("512mb", "2gb", "1048576") into bytes.
 *
 * Written out rather than taken from body-parser's `bytes` dependency: that is a
 * transitive package, and a limit that silently becomes `undefined` because a
 * transitive dep moved is a ceiling that is not there.
 *
 * Returns null for anything it cannot read, so the caller logs and falls back to
 * its default instead of running unbounded on a typo.
 */
export function parseByteSize(value: string | undefined): number | null {
  if (value === undefined) return null;
  const match = /^\s*(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?\s*$/i.exec(value);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const unit = UNITS[(match[2] ?? "b").toLowerCase()];
  return Math.floor(amount * unit);
}

/** Reads a byte-size limit from the environment, falling back on bad input. */
export function resolveByteLimit(
  raw: string | undefined,
  fallback: number,
  onInvalid?: (message: string) => void,
): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = parseByteSize(raw);
  if (parsed === null) {
    onInvalid?.(
      `Could not read "${raw}" as a byte size (expected e.g. "512mb"); using ${fallback} bytes.`,
    );
    return fallback;
  }
  return parsed;
}

/**
 * Ceiling on the *compressed* restore upload, for `express.raw`.
 *
 * This defaulted to the literal string `"500mb"` in `main.ts` while the chart's
 * backend limit is 400 MiB, and `express.raw` buffers the whole body onto the heap
 * **before** the controller, the guards, the authentication lookup, the decryption
 * and every service-level ceiling. So the process could die on a request none of
 * those layers ever saw -- an availability defect that no amount of care further in
 * could reach, because the allocation happened first.
 *
 * **The wire bytes are not the cost.** This used to be half the container on the
 * reasoning that a compressed upload is one buffer -- but the request that
 * uploads it then holds the envelope, the decipher output, the concatenated
 * plaintext, the decompressed payload, the string and the parsed graph, several of
 * them at once. Half of a 400 MiB container to the wire is `PEAK_MULTIPLE` times
 * that at peak, so a single legal request could not fit the pod it was sized for.
 *
 * It was then its own share divided by the multiple, which was safe but still two
 * ceilings for one fact -- 66 MiB of wire against a 100 MiB expanded ceiling, so an
 * upload could be accepted and then refused on decompression. It is now
 * `safeDerivedUploadLimit`: the expanded ceiling in force, whether derived or set
 * by the operator, capped by what the container can hold. About 23 MiB on the
 * chart's default backend.
 *
 * That is a much smaller default than before, and deliberately: a compressed
 * backup near the old figure could not be restored on the default pod at all. An
 * operator whose users have large artifacts -- likelier now that attachment bytes
 * travel inside them -- raises the pod's memory, which raises both ceilings
 * together, and gets a startup warning if they raise `BACKUP_RESTORE_LIMIT` past
 * what the container can decompress.
 *
 * Returned as bytes; `express.raw` accepts a number.
 */
export function resolveRestoreUploadLimitBytes(
  raw: string | undefined = process.env.BACKUP_RESTORE_LIMIT,
  memoryLimitBytes: number | null = detectProcessMemoryLimitBytes(),
  expandedRaw: string | undefined = process.env.BACKUP_RESTORE_EXPANDED_LIMIT,
): number {
  return resolveByteLimit(
    raw,
    safeDerivedUploadLimit(memoryLimitBytes, expandedRaw),
  );
}

/**
 * Warn when a configured `BACKUP_RESTORE_LIMIT` is larger than this container can
 * decompress.
 *
 * Replaces a share-based check: the upload ceiling is no longer a share of
 * anything, it is the expanded ceiling, so the threshold is that number and the
 * figure suggested is one the operator can paste back. Silent when the derived
 * default is in use -- a derivation must never warn about itself, which is the
 * mistake that once kept this check out of `main.ts` entirely.
 */
export function warnIfRestoreUploadLimitIsUnsafe(
  limitBytes: number,
  rawOverride: string | undefined,
  onWarn: (message: string) => void,
  memoryLimitBytes: number | null = detectProcessMemoryLimitBytes(),
  expandedRaw: string | undefined = process.env.BACKUP_RESTORE_EXPANDED_LIMIT,
): void {
  if (rawOverride === undefined || rawOverride.trim() === "") return;
  // Unknown means unknown. With no cgroup limit visible the ceiling comes from
  // `UNKNOWN_RESTORE_PEAK_BUDGET_BYTES`, which is a judgement about a machine
  // nobody has measured -- warning that a bare-metal host "should consider
  // 128MiB" is advice this cannot support, and a warning that fires where it
  // cannot know is how operators learn to ignore the ones that can.
  if (memoryLimitBytes === null) return;
  // Against the ceiling actually in force: an operator who lowered the expanded
  // limit and left the upload limit alone is exactly who this has to warn.
  const safe = safeDerivedUploadLimit(memoryLimitBytes, expandedRaw);
  if (limitBytes <= safe) return;
  const mib = (bytes: number) => `${Math.round(bytes / MIB)}MiB`;
  onWarn(
    `BACKUP_RESTORE_LIMIT is ${mib(limitBytes)}, but this container can only ` +
      `decompress about ${mib(safe)} of artifact: a restore's peak memory is ` +
      `roughly ${PEAK_MULTIPLE} times its expanded payload (measured), and an ` +
      `upload larger than the expanded ceiling cannot decompress inside it at ` +
      `all. A request near this ceiling will be OOM-killed or refused mid-restore ` +
      `rather than rejected up front. Consider ${mib(safe)} or less, or raise the ` +
      `container memory limit.`,
  );
}

/**
 * The largest compressed upload worth buffering: the expanded ceiling **in force**.
 *
 * This used to be its own share of the container (`container * 0.5 /
 * PEAK_MULTIPLE`), which made two ceilings out of one fact and let them disagree:
 * on the default pod the wire limit was 66 MiB while the expanded ceiling was
 * 100 MiB, so a 66 MiB upload was accepted and then refused at decompression
 * whenever it expanded past 100 MiB -- which a backup artifact always does.
 *
 * Deriving it from the expanded ceiling is not a convenience, it is provable:
 * gzip output is never smaller than what it expands to, so **any** upload larger
 * than the expanded ceiling is one this deployment cannot decompress. Refusing it
 * before `express.raw` buffers it is strictly better than refusing it after.
 *
 * **The lower of the resolved and derived ceilings**, and it needs both. Reading
 * only the derivation reintroduced the accept-then-refuse defect one level along:
 * an operator who *lowers* `BACKUP_RESTORE_EXPANDED_LIMIT` -- the documented lever
 * for trading artifact size against concurrency -- would leave the wire limit at
 * the derived 23.6 MiB while `gunzip` enforced their 8 MiB. Reading only the
 * resolved value is worse in the other direction: `BACKUP_RESTORE_EXPANDED_LIMIT=1gb`
 * on a 400 MiB pod would hand `express.raw` a 1 GiB ceiling, and it buffers the
 * body onto the heap before anything can refuse it -- an OOM kill where the
 * previous independent wire limit answered 413. An operator may raise what this
 * deployment will *attempt* to decompress; they cannot raise what it can *hold*
 * without raising the container, and `BACKUP_RESTORE_LIMIT` is still theirs to set
 * explicitly (with the startup warning if it does not fit).
 *
 * **No floor**, for the reason `deriveRestoreExpandedLimitBytes` states: a
 * usability minimum resolved with `max()` beats the safety bound it was supposed
 * to respect. A container with no room for any restore resolves `0` here, and the
 * admission middleware refuses with the 503 that names the levers.
 * `warnIfRestoreUploadLimitIsCramped` says so at startup where the number is
 * merely small.
 */
export function safeDerivedUploadLimit(
  memoryLimitBytes: number | null,
  expandedRaw: string | undefined = process.env.BACKUP_RESTORE_EXPANDED_LIMIT,
): number {
  return Math.min(
    resolveRestoreExpandedLimitBytes(expandedRaw, memoryLimitBytes),
    deriveRestoreExpandedLimitBytes(memoryLimitBytes),
  );
}

/**
 * Below this a derived upload limit is safe but cramped: real backups may be
 * refused, so the operator should know rather than discover it on a failed
 * restore. Not a floor on the value -- flooring is exactly the bug above -- only
 * the threshold for a startup warning.
 *
 * Lowered from 32 MiB when the measurement (issue #1073) brought the derived
 * ceiling on the chart's own default pod down to about 28 MiB. A warning that
 * fires on the default configuration is a warning nobody reads, and the pod it
 * would fire on is correctly configured -- what is small there is the artifact,
 * and `resources.limits.memory` is the lever the message already names.
 */
export const CRAMPED_UPLOAD_LIMIT_BYTES = 16 * MIB;

/**
 * Warns when the derived upload limit is safe but small enough to refuse ordinary
 * backups, so the operator raises memory or sets the limit deliberately. Silent
 * when the operator set an explicit value (their choice) or the limit is roomy.
 */
export function warnIfRestoreUploadLimitIsCramped(
  resolvedLimitBytes: number,
  rawOverride: string | undefined,
  onWarn: (message: string) => void,
): void {
  if (rawOverride !== undefined && rawOverride.trim() !== "") return;
  if (resolvedLimitBytes >= CRAMPED_UPLOAD_LIMIT_BYTES) return;
  const mib = (bytes: number) => `${Math.round(bytes / MIB)}MiB`;
  onWarn(
    `Derived restore upload limit is only ${mib(resolvedLimitBytes)} on this ` +
      `container -- backups larger than that will be refused. This is the largest ` +
      `size whose peak memory fits the pod; raise the container memory limit for a ` +
      `larger restore, or set BACKUP_RESTORE_LIMIT deliberately if the pod has more ` +
      `headroom than its cgroup reports.`,
  );
}

/**
 * Warn when a configured ceiling cannot protect the container it runs in.
 *
 * An operator who sets `BACKUP_EXPORT_BUFFER_LIMIT=2gb` on a 400 MiB pod has
 * written down an intention the runtime cannot honour, and the failure mode is a
 * killed process rather than a rejected request -- so it is worth saying at
 * startup rather than leaving them to infer it from a restart. Not fatal: the
 * limit may be deliberate on a container whose real limit this cannot see.
 */
export function warnIfLimitExceedsMemory(
  label: string,
  limitBytes: number,
  onWarn: (message: string) => void,
  memoryLimitBytes: number | null = detectProcessMemoryLimitBytes(),
  safeShare: number = MEMORY_SHARE_PER_BACKUP,
): void {
  if (memoryLimitBytes === null) return;
  const safe = Math.floor(memoryLimitBytes * safeShare);
  if (limitBytes <= safe) return;
  const mib = (bytes: number) => `${Math.round(bytes / MIB)}MiB`;
  onWarn(
    `${label} is ${mib(limitBytes)} but this container's memory limit is ` +
      `${mib(memoryLimitBytes)}. A request near this ceiling will be OOM-killed ` +
      `rather than refused. Consider ${mib(safe)} or less, or raise the memory ` +
      `limit.`,
  );
}

/**
 * One resolution path for both backup ceilings -- the operator's value if they
 * set one, otherwise a share of the container's memory limit, and a warning
 * either way when the number cannot protect the process it is meant to protect.
 *
 * Read per call rather than cached at construction: each is consulted once per
 * request, so the cost is nothing, and a limit that can only be observed at
 * construction time is a limit no test can vary.
 *
 * The default is derived from this container's memory limit, not fixed. A
 * ceiling larger than the process it protects cannot fire -- the pod is killed
 * first -- and that is exactly what a hardcoded 1 GiB default was on the chart's
 * 400 MiB backend.
 */
export function resolveConfiguredBackupLimit(
  name: string,
  raw: string | undefined,
  onWarn: (message: string) => void,
): number {
  const limit = resolveByteLimit(raw, deriveDefaultLimitBytes(), onWarn);
  warnIfLimitExceedsMemory(name, limit, onWarn);
  return limit;
}
