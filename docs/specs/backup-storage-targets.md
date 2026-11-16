# Spec: the automatic backup store is a target, and S3 is one of them

Proposed specification for putting the automatic backup store behind a selected
target, so a deployment can keep its recovery points on object storage instead of
on a per-pod disk. Written before the implementation, per
`docs/financial-calculation-contract.md` section 7 and `AGENTS.md` ("a financial
feature of any substance starts from a short approved spec"). The staged plan is
task S2 of the horizontal-scaling plan, `docs/specs/horizontal-scaling.md` (WP7).

**Status: approved.** The maintainer answered section 11 on 2026-09-19 and took
the recommendation on all four questions; those answers are now part of the
specification rather than open questions, and section 11 records them.

This spec governs *where the primary automatic backup lives*. It does not change
the export pipeline, the on-disk format, the retention arithmetic, restore, or
the off-machine copy. The ordering rules it builds on are `EXT-001`..`EXT-004`
in `docs/external-side-effects.md`; the completeness rule is `INV-BACKUP-001`;
the sharded layout is `docs/adr/0003-filesystem-objects-use-id-sharding.md`.

## 1. What this adds

`AutoBackupService` writes every artifact to a container directory. Under
`CLUSTER_MODE=multi` that directory has to be a volume every replica mounts, and
the boot refuses to start without the operator asserting that it is
(`checkClusterBoot`). A deployment on Kubernetes with a `ReadWriteOnce` claim
cannot make that assertion truthfully, so today `multi` and automatic backups
are only compatible where `ReadWriteMany` storage exists.

This adds a second place the primary artifact may live:

- **A `BackupStorageTarget` seam** -- one interface with the eight operations the
  service performs on storage, selected by `BACKUP_STORAGE_PROVIDER` behind a DI
  token, with today's behaviour preserved exactly in the `local` target.
- **An `s3` target** keeping the same key layout, the same filenames, the same
  tiers and the same retention semantics, so nothing downstream of the store
  learns that it changed.
- **A conditional boot refusal**: in `multi`, an `s3` target satisfies the backup
  half of `checkClusterBoot` without `BACKUP_SHARED_VOLUME`.

`local` stays the default and is byte-for-byte what runs today. Deploy class,
per the task graph: **none until selected**.

## 2. The behaviour this replaces

Every storage touch in the backup path today, and what it is. This list is the
scope of the extraction; an operation not on it is not part of the seam.

| # | Where | What it does on the filesystem |
|---|---|---|
| 1 | `resolveUserFolder` / `resolveUserFolderForRead` | canonicalises `<root>/<ab>/<cd>/<userId>/`, confirms containment in `BACKUP_ALLOWED_ROOTS`, creates it for a write |
| 2 | `assertFolderWritable` | `mkdir` when asked, then a `randomUUID()`-named probe file written and removed |
| 3 | `exportToFile` | `cleanStaleTempFiles`, then `writeFileAtomic` (temp name, `fsync`, size check, `rename`, directory `fsync`) |
| 4 | `copyToWeeklyIfNeeded` / `copyToMonthlyIfNeeded` | `copyFileAtomic` from the daily name to the tier name |
| 5 | `collectBackupFiles` | `readdirSync`, skipping temp names, classifying the rest by filename |
| 6 | `enforceRetention` | `unlinkSync` beyond each tier's limit, over the user's folder **and** the legacy flat base folder |
| 7 | `listStoredBackups` | `readdir` + `stat` per entry for the owner-facing listing |
| 8 | `openStoredBackup` | `readdir`, match the requested name against a server-produced entry, `stat`, return a **filesystem path** |
| 9 | `backup.controller.ts` `downloadStoredBackup` | `createReadStream(artifact.path)` piped to the response |
| 10 | `backup-offsite-dispatch.service.ts` `readArtifact` | the same readdir-match-read, to get the bytes for an off-machine copy |
| 11 | `describeCapability` | containment check, then the writability probe, reporting `{available, folderPath, reason}` |
| 12 | `validateFolder` / `browseFolders` | admin-gated folder validation and enumeration for the settings UI |

Two of these are not simply "a filesystem call behind an interface" and are
called out now rather than discovered during implementation:

- **#6 is synchronous and sweeps two directories.** `readdirSync`/`unlinkSync`
  become `await`ed, and the legacy flat folder is a *local-only* concept: it is
  the pre-sharding layout that only ever existed on disk. On `s3` that sweep has
  nothing to sweep and must return an empty list rather than inventing a
  prefix.
- **#8 returns a path, and #9 opens it.** An object store has no path to open.
  The download route changes shape (section 6).

## 3. Definitions

- **Artifact.** One written backup file, `monize-backup-<tier>-<date>.<ext>`,
  `ext` one of `mzbe` (encrypted) or `json.gz`, per `backend/src/backup/backup-file-names.ts`.
- **Store.** The primary location of a user's artifacts: what retention prunes,
  what the owner-facing listing enumerates, and what restore's download serves.
  There is exactly one per deployment.
- **Target.** One implementation of the store: `local` (a container directory) or
  `s3` (an S3-compatible bucket and prefix).
- **Location.** A target-specific opaque handle for one user's namespace within
  the store, plus a display string for the settings UI. The `local` location is
  the canonical per-user directory; the `s3` location is a bucket and key prefix.
- **Off-machine copy.** A *different* thing, already shipped: an append-only
  second copy on a destination that does not share the container's lifecycle
  (`docs/specs/backup-off-machine.md`, `INV-BACKUP-002`..`-005`). Section 5's
  second invariant is about keeping the two apart.
- **Publish.** Make an artifact visible under its final name. The point at which
  a reader can see it, and the point before which no reader may see any part of
  it.

## 4. The seam

One interface, one DI token named for the env var that selects it, registered the
way `ATTACHMENT_STORAGE_PROVIDER` is in `backend/src/attachments/attachments.module.ts`:
every implementation a provider, one `useFactory` choosing by config.

```text
BACKUP_STORAGE_TARGET (token)     backend/src/backup/storage/backup-storage.interface.ts

resolveLocation(userId, configuredFolder?, opts)  -> Location
ensureWritable(location)                          -> void | throws
publish(location, filename, bytes)                -> void
promote(location, fromFilename, toFilename)       -> void
list(location)                                    -> Array<{ name, sizeBytes, modifiedAt }>
open(location, filename)                          -> { stream, sizeBytes, filename } | null
remove(location, filename)                        -> void
sweepIncomplete(location, olderThan)              -> number
```

Decisions this shape encodes, each because the alternative has a named cost:

- **A `Location`, not a string.** `resolveStoredBackupFolder` hands a string to
  `backup-offsite-retry.service.ts` today, which joins paths onto it. A string
  that is sometimes a directory and sometimes `s3://bucket/prefix/ab/cd/uuid/`
  invites exactly one caller to `resolve()` it. The handle carries its display
  form separately, and only the target may interpret the rest.
- **`publish`, not `write`.** The name is the invariant (section 5): a caller
  cannot ask for a non-atomic write because there is no operation for one.
- **`promote`, not "read then publish".** On `s3` this is a server-side
  `CopyObject`; making it two operations would pull the whole artifact through
  the backend to put it back.
- **`open` returns a stream, not bytes.** #9 streams to the client and #10 wants
  a buffer; a stream serves both and keeps the download off the heap. The
  offsite reader buffers it itself, as it does today.
- **`sweepIncomplete` exists but is a no-op on `s3`.** A single `PutObject` has
  no intermediate state to sweep. Keeping the operation means the caller does
  not branch on the target, and the `local` target keeps its temp-file sweep
  where it is.
- **No `exists`.** Every present caller either lists or opens; an `exists` that
  is checked and then acted on is a race, and `docs/concurrency-and-idempotency.md`
  says to make the act itself decide.

## 5. Invariants

Proposed for `docs/system-invariants.md` (with the matching rows in
`docs/verification-contract.md` section 3) by the PR that first enforces each.

### INV-BACKUP-006 -- an artifact is published whole or not at all, on every target

```text
Statement           A reader of the store sees an artifact's complete bytes under
                    its final name, or no artifact under that name. No target
                    ever exposes a partially written artifact, and a failed
                    publish never destroys the artifact already under that name.
Source of truth     The object or file under the final name.
Enforcement         local: writeFileAtomic / copyFileAtomic, unchanged -- temp
                    name, fsync, length check, rename, directory fsync; rename
                    within a filesystem is atomic.
                    s3: one PutObject with a known Content-Length and a declared
                    ChecksumSHA256, which S3 applies to the key only on a
                    complete, checksum-matching upload. Promotion is CopyObject,
                    which is likewise all-or-nothing at the destination key.
                    Neither target has a code path that opens the final name for
                    writing, so there is nothing to truncate.
Concurrency scope   per (user, filename)
Retry semantics     Safe and idempotent: republishing the same filename replaces
                    it with bytes the export just produced. Two runs for the same
                    user and day cannot interleave -- the run is claimed
                    (claimDueBackup) -- so last-writer-wins is never reached.
Crash semantics     local: a crash leaves a temp file the next run sweeps.
                    s3: a crash leaves no object; an interrupted upload is not
                    applied to the key.
Failure response    The run is recorded failed and alerted; nothing is published.
Required tests      Unit against both targets: a publish that throws mid-write
                    leaves the previous artifact readable and complete.
                    Integration against MinIO: an aborted upload leaves the key
                    absent, and a size/checksum mismatch is refused by the
                    service rather than accepted.
Status              (proposed)
```

The `s3` claim rests on a property of the service rather than of our code, which
is what the wording has to say: S3 applies an object to its key only on a
complete upload, and a declared `ChecksumSHA256` makes the destination verify the
bytes rather than us trusting a 200. That is `EXT-002` satisfied by the same
mechanism the off-machine uploader already uses
(`backend/src/backup/offsite/backup-offsite-s3.uploader.ts`). Where the target is
an S3-compatible service that does not honour the checksum header, we learn it
from a rejected put, not from a silent acceptance -- the implementation must
refuse a destination that ignores the header, not shrug.

### INV-BACKUP-007 -- the store and the off-machine copy are two places

```text
Statement           A deployment's automatic backup store and any off-machine
                    destination are distinct locations. The same bucket and key
                    prefix cannot serve both.
Source of truth     The two configurations: the store's bucket/prefix and the
                    off-machine destination's (deployment default or the user's
                    own).
Enforcement         Boot-time refusal when the store's (endpoint, bucket, prefix)
                    equals the deployment default off-machine destination's; a
                    refusal at save time for a user-configured destination that
                    matches the store. Not a warning: the off-machine copy exists
                    to survive the loss of the store, and one bucket holding both
                    is a 3-2-1 arrangement that is actually a 1.
Concurrency scope   deployment (and per user for a user-configured destination)
Retry semantics     n/a
Crash semantics     n/a
Failure response    exit(1) at boot for the deployment default; 400 at save time
                    for a user's own destination, naming both locations.
Required tests      Unit: the comparison, including a prefix that is a parent of
                    the other and a trailing-slash difference that is not a real
                    difference. Integration: a deployment configured both ways
                    does not start.
Status              (proposed)
```

This invariant exists because of a naming collision the plan did not anticipate,
and it is the single most important finding in this spec: **`BACKUP_S3_*` is
already taken.** `.env.example` uses `BACKUP_S3_BUCKET`, `BACKUP_S3_PREFIX`,
`BACKUP_S3_ENDPOINT`, `BACKUP_S3_REGION`, `BACKUP_S3_FORCE_PATH_STYLE`,
`BACKUP_S3_ACCESS_KEY_ID`, `BACKUP_S3_SECRET_ACCESS_KEY`,
`BACKUP_S3_REQUEST_TIMEOUT_MS` and `BACKUP_S3_MULTIPART_PART_BYTES` for the
**off-machine** destination's deployment default. An `s3` store reusing that
prefix would put the primary artifact and its off-machine copy in one bucket, by
default, silently -- the exact failure the off-machine feature was built to
prevent, arriving as a configuration convenience.

So the store's variables are `BACKUP_STORE_S3_*` (section 8), and the equality
check above is what makes the separation a rule rather than a naming convention.

### What does NOT become a new invariant

`INV-BACKUP-001` already says an artifact is complete, verified and
owner-namespaced. It is not restated per target; it is *preserved* by the
implementation, and its existing tests are the ones that must keep passing
against both. Section 9's matrix says how.

## 6. What changes outside the backup module

Each is a consequence of the seam, not a separate feature, and each is in scope
for the PR that introduces the operation it belongs to.

**The download route (#8, #9).** `openStoredBackup` stops returning a path.
`backup.controller.ts` streams the target's stream with `pipeline` exactly as it
streams the file handle today -- same headers, same `Content-Length`, same 404
for a name the server does not write, same `pipeline` so a client hang-up
destroys the source. No presigned-URL redirect: it would move an authenticated,
demo-restricted, owner-scoped download onto a URL that carries its own authority
and outlives the request, and the bytes are already being streamed through a
process that is happy to stream them.

**The off-machine reader (#10).** `readArtifact` in the offsite dispatcher does
its own readdir-match-read against a folder string. It moves onto
`open(location, filename)` and keeps its own refusal of a name
`classifyBackupFileName` does not recognise. The CWE-22 boundary it documents
survives the move in a stronger form: on `s3` there is no path to traverse, and
on `local` the containment check lives in one place instead of two.

**The cluster boot matrix.** `checkClusterBoot` refuses `multi` unconditionally
without `BACKUP_SHARED_VOLUME` today, with a comment saying "until the S3 backup
target ships (plan task S2)". It gains the condition: the refusal applies when
`BACKUP_STORAGE_PROVIDER` is `local`; an `s3` store satisfies it. The refusal's
message gains the third option. `backend/src/common/cluster/cluster-mode.spec.ts`
gets the rows.

**The settings surface (#11, #12).** Under `s3` there is no folder for a user to
choose or an admin to browse. Section 11, decision 1: the setting becomes inert
-- `updateSettings` refuses a `folderPath`, `validateFolder` and `browseFolders`
answer a typed refusal, and `describeCapability` reports the bucket and prefix
with `locationSelectable: false`. Hiding the picker on that flag is a follow-up
frontend PR.

**Helm.** `backup.storageProvider` and the `backupStore.s3.*` values, with the
existing `backup.sharedVolume` assertion becoming conditional on the provider in
the chart's own validation, mirroring the boot matrix so a chart that renders is
a chart that boots.

## 7. Ordering and failure policy

`EXT-001` in one line: durable state before the external write, or
reconstructibility. The backup path satisfies it by writing bytes **first** and
recording **after**, and the target seam must not reorder that.

| Step | Today | With a target | Why the order |
|---|---|---|---|
| 1 | claim the due window | unchanged | one replica runs it |
| 2 | sweep stale temp files | `sweepIncomplete` | a partial is not a backup and must not count towards retention |
| 3 | export to a buffer | unchanged | the name is chosen from what the export found |
| 4 | `writeFileAtomic` | `publish` | the bytes |
| 5 | promote to weekly/monthly | `promote` | only for a complete artifact |
| 6 | `recordBackupOutcome` | unchanged | the row |
| 7 | enforce retention | `list` + `remove` | deletes AFTER the new artifact exists |
| 8 | dispatch the off-machine copy | unchanged | after the local copy is durable and recorded (`INV-BACKUP-003`) |

An artifact published at step 4 whose step 6 never happens is a stored object
nobody has a row for: visible in the listing (which enumerates the store, not the
rows), costing storage, harmless. A row written before step 4 would promise a
recovery point that does not exist, which is the failure. Step 7 deletes only
after step 4 has succeeded, so a retention pass can never take the last good
artifact to make room for one that was not written. **This is exactly today's
order and the implementation may not "simplify" it.**

**Partial failure of a promote or a remove** stays what it is today: a message
returned to the caller, raised as a `BACKUP_PARTIAL` admin alert, with the run's
status still reflecting what the export found. A failed `remove` is storage cost;
a failed `promote` means the tier is missing this cycle and present next.

**A target that is unreachable** fails the run: `ensureWritable` throws, nothing
is published, the outcome is `failed`, and the existing alert path reports it.
There is no fallback to the other target. A deployment configured for `s3` whose
bucket is gone has a broken backup, and saying so is the only honest answer --
silently writing to a pod's disk instead would produce recovery points that
vanish with the pod and a green status that says they are safe.

## 8. Configuration

New variables, named to mirror `ATTACHMENT_S3_*` in shape and to stay clear of
`BACKUP_S3_*` in prefix (section 5):

| Variable | Meaning |
|---|---|
| `BACKUP_STORAGE_PROVIDER` | `local` (default) or `s3` |
| `BACKUP_STORE_S3_BUCKET` | required when the provider is `s3` |
| `BACKUP_STORE_S3_PREFIX` | key prefix, one trailing slash, like `ATTACHMENT_S3_PREFIX` |
| `BACKUP_STORE_S3_REGION` | defaults to `us-east-1` |
| `BACKUP_STORE_S3_ENDPOINT` | for MinIO, R2, B2; unset for AWS |
| `BACKUP_STORE_S3_FORCE_PATH_STYLE` | as the attachment provider |
| `BACKUP_STORE_S3_ACCESS_KEY_ID` / `_SECRET_ACCESS_KEY` | credentials; unset to use the instance role |
| `BACKUP_STORE_S3_REQUEST_TIMEOUT_MS` | clamped by `clampS3Deadline`, as everywhere else |

The transport is `backend/src/attachments/storage/s3-transport.ts`, which was
built for exactly this ("it exists because there is now more than one caller")
and already carries the deadline and attempt ceiling. **No new dependency:**
`@aws-sdk/client-s3` is already a backend dependency. The store's client
constructs `Put`, `Copy`, `Head`, `List` and `Delete` commands -- unlike the
off-machine uploader, which may construct no delete by design (`INV-BACKUP-004`).
Those two must not share a client wrapper, for the reason `s3-transport.ts`
already states: the transport is shared and the operations are not.

`BACKUP_ALLOWED_ROOTS`, `BACKUP_CONTAINER_DIR` and the whole
`backup-paths.ts` containment model stay, unchanged, as the `local` target's
own concern. They are meaningless to `s3` and must not leak into the interface.

## 9. Test matrix

| What | Kind | Where |
|---|---|---|
| The existing `auto-backup.service.spec.ts` matrix (3473 lines) | unit | runs unchanged against the `local` target: it is the proof the extraction changed nothing |
| The same matrix against the `s3` target | unit | a fake destination in the style of `s3-storage.provider.spec.ts`, so tier promotion and retention arithmetic are proven target-independent |
| `local` target file operations | unit | a real `mkdtemp`, per `docs/guard-tests.md` -- never a mocked `fs`, because what is claimed is what the directory looks like after an unfinished write |
| Publish atomicity, both targets (`INV-BACKUP-006`) | unit | a publish that throws mid-write leaves the previous artifact complete |
| Deadline and attempt clamping on the `s3` target | unit | the pattern of `s3-storage.provider.deadline.spec.ts`, against a deliberately stalled endpoint |
| Store / off-machine equality refusal (`INV-BACKUP-007`) | unit | including trailing-slash and parent-prefix cases |
| An hourly run end to end: write, promote, prune | integration (MinIO) | the acceptance in task S2 |
| Boot matrix rows for `s3` under `multi` | unit | `cluster-mode.spec.ts` |
| Download and off-machine read through `open` | unit | the 404 for an unwritten name survives on both targets |

**CI needs a MinIO service on `backend-integration-tests`**, which today has only
`postgres`. That is a `.github/workflows/ci.yml` change; task S2 sanctions it
("add it to the `backend-integration-tests` job if it is not there") and it is
listed here so the approval covers it explicitly.

## 10. Staging

Three PRs, in this order. Each is independently revertible and each leaves the
default deployment unchanged.

1. **The seam and the `local` target.** Extract #1--#12 behind the interface;
   `local` is the only registered implementation and is byte-for-byte today's
   behaviour. The download route and the off-machine reader move onto `open`.
   Nothing new is configurable. The proof is the existing spec suite passing
   unchanged.
2. **The `s3` target.** The implementation, its unit suite, the MinIO
   integration spec, the CI service, `.env.example`, Helm, and
   `INV-BACKUP-006`/`-007` in both contract docs.
3. **The boot matrix and the docs.** `checkClusterBoot`'s conditional refusal,
   `docs/backup-restore-contract.md` section 7 and
   `docs/external-side-effects.md` section 3 rewritten from "the filesystem" to
   "the store", and the inert settings surface of section 11's decision 1.

## 11. Decisions (answered 2026-09-19)

The four questions this section opened with are answered. Each took the
recommendation, so the reasoning under each *Recommended* bullet is the reasoning
for the decision; what follows is what the implementation must do, not a choice
still to be made.

**1. The per-user backup folder is inert under an `s3` store.** There is no
folder for a user to choose or an admin to browse, and the implementation says so
rather than pretending otherwise:

- `updateSettings` refuses a `folderPath` with a message naming the active
  provider. The stored column keeps whatever it held; it is simply never read for
  a location.
- `validateFolder` and `browseFolders` answer a typed refusal rather than walking
  a filesystem that has nothing to do with where the bytes are.
- `describeCapability` reports the bucket and prefix as the location and carries
  `locationSelectable: false`.
- The frontend hides the picker on that flag. That is a **follow-up PR**, listed
  here as one: the backend flag is meaningful on its own (the endpoints already
  refuse), and a frontend change does not belong in the PR that adds a storage
  target.

The rejected alternative -- `folderPath` as a user-chosen key sub-prefix -- stays
rejected: it is a user-supplied string in an object key and would need its own
containment model.

**2. No migration. The switch is forward-only and said so loudly.** Moving a live
deployment from `local` to `s3` leaves every previous recovery point on the old
volume, invisible to the new store's listing:

- The documentation states the switch is forward-only, in
  `docs/backup-restore-contract.md` and beside `BACKUP_STORAGE_PROVIDER` in
  `.env.example`.
- The release note says to keep the old volume until the new store holds a full
  retention window.
- `describeCapability` reports how many artifacts the **current** store holds, so
  an operator sees the gap rather than inferring it.

No copy command ships. An operator who wants the old artifacts in the new store
can move them with their own tooling against the documented key layout, which is
the same layout on both targets.

**3. `local` stays the default in every mode, including `multi`.** `multi` with a
`local` store refuses without the shared-volume assertion, which is a refusal an
operator can answer two ways (mount `ReadWriteMany`, or select the `s3` store);
choosing for them is how a default becomes a surprise.

**4. The legacy flat-folder sweep stays, unchanged, in the `local` target.** It
is commented as local-only, the `s3` target's listing has no legacy entries to
return, and retiring it is its own PR against its own evidence -- not a silent
side effect of a refactor whose whole claim is that it changed nothing.
(Superseded by A26-M07: the sweep deleted other owners' legacy files, so legacy
entries are now listed but never removed; see `docs/external-side-effects.md`.)
