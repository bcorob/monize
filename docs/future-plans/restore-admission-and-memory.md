# Restore admission and memory: plan for DR-F3RB-002..004 (issue #1073)

Status: **WP1-WP4 implemented**; WP5's release note and the full-path,
cgroup-constrained measurement remain. Scope approved (`approved-to-build` on issue
#1073), and Option B in D3 approved before implementation because it lowers what a
default deployment accepts.

Kept as written where the decisions were made, and corrected where implementation
changed one: D2 recommended a stored single-use ticket, and WP4 explains why the
shipped ticket is signed instead. A plan quietly edited to match the code stops being
a record of why.

Three findings from audit 03 that the restore path still carries. They are one plan
because they are one chain: the memory constants decide the gate's capacity, the
capacity decides who queues, and the queue is what an unauthenticated upload can
occupy.

| ID | Finding | Nature |
|---|---|---|
| DR-F3RB-002 | `restoreProcessingGate`'s wait queue is unbounded and not cancellation-aware | code |
| DR-F3RB-003 | Upload admission necessarily precedes authentication, so an unauthenticated request can occupy the budget until the receive deadline | design plus deployment |
| DR-F3RB-004 | `PEAK_MULTIPLE` and `restoreProcessBaselineBytes` are estimates; every ceiling in the chain is derived by dividing by the same estimate, so none of them can vouch for it | measurement |

## 0. The state before this work, in numbers

The subjects are `backend/src/backup/backup-limits.ts`,
`backend/src/backup/restore-processing-gate.ts`,
`backend/src/backup/restore-upload-admission.ts` and their wiring in
`backend/src/main.ts` (lines 182-260). Section 6 of
`docs/backup-restore-contract.md` is the prose contract.

On the chart's default backend (`helm/values.yaml`: requests 140Mi, limits 400Mi):

| Quantity | Where it comes from | Value |
|---|---|---|
| Container limit | `helm/values.yaml` | 400 MiB |
| Expanded limit | `deriveDefaultLimitBytes` (a quarter) | 100 MiB |
| Process baseline | `restoreProcessBaselineBytes` (`max(96 MiB, a fifth)`) | 96 MiB |
| Modeled peak, one restore | `PEAK_MULTIPLE * expanded` | 300 MiB |
| Modeled total | baseline plus peak | 396 MiB, 4 MiB spare |
| Break-even multiple | `(container - baseline) / expanded` | 3.04 |
| Wire limit | `safeDerivedUploadLimit` (`container * 0.5 / 3`) | 66 MiB |
| Processing slots | `computeRestoreProcessingSlots` | 1 |

Two consequences the plan has to change, not merely document:

- A true multiple above 3.04 (3.20 on a 512 MiB or 1 GiB pod) OOM-kills a single
  admitted restore. `backend/src/backup/restore-processing-gate.spec.ts` already pins
  this arithmetic, so the defect is asserted rather than hidden.
- The repository's own sizing assumptions disagree: the chart *requests* 140 MiB for
  ordinary backend use while the baseline formula reserves 96 MiB at a 400 MiB limit.
  One of those two numbers is wrong and only a measurement can say which.

## 1. Decisions to take before code

These are the forks the issue asks for. The recommendation is stated so review can
reject a named choice rather than an absence.

### D1. Queue posture (DR-F3RB-002): bounded, abort-aware queue, not fail-fast

A restore is rare, deliberate and destructive, and the caller has just uploaded up
to 66 MiB. Answering the *second* operator 503 immediately makes them re-upload;
letting them wait costs a held socket. So: keep queueing, but bound it, deadline
it, and drop a waiter whose client is gone.

**The cancellation rule is asymmetric, and that asymmetry is the point.** A queued
restore has done nothing and may be dropped. A restore holding a slot must never be
cancelled by a socket event: it is mid-way through deleting and re-inserting the
user's data. This is the same distinction the upload reservation already draws
between *receiving* and *processing* (`restore-upload-admission.ts`), and it must be
written as one rule with one test each way, or the next reader will "improve" it into
a cancellation that aborts a running restore.

### D2. Pre-auth occupation (DR-F3RB-003): authorize before reserving, at two layers

The gate cannot move behind Nest's guards -- it exists because `express.raw`
allocates before them. So authorization has to move *forward*, ahead of the
reservation:

1. **A short-lived upload ticket.** `POST /api/v1/backup/restore/ticket` is an
   ordinary authenticated JSON route (JWT guard, CSRF, throttler, demo guard all
   apply). It mints a single-use, per-user, TTL-bounded ticket bound to the declared
   content length. (**Superseded by WP4**: the shipped ticket is signed rather than
   stored, and therefore replayable inside its TTL rather than single-use. The
   reasoning is there.) The raw upload carries it in a header, and the admission
   middleware validates it *before* reserving budget. An unauthenticated request then
   cannot occupy the budget at all: it is refused having reserved nothing. (Shipped
   as `403`, not the `401` written here -- see WP4.)
2. **Ingress limits in the chart.** A body-size limit matching `BACKUP_RESTORE_LIMIT`
   and a per-IP connection/rate limit on the restore path, so the process is not the
   first thing a flood reaches. Cheap, real, and only helps deployments that use the
   chart's ingress -- which is why it is the second layer, not the answer.

Streaming the upload through decryption and gzip into a bounded temporary file or an
incremental parser is the real answer to both this and `PEAK_MULTIPLE`, and it is
explicitly **out of scope here**: it is a change to the restore pipeline, tracked with
the export-side streaming work (issue #1070).

Open questions D2 must answer in review, because they are the parts that can be
wrong quietly:

- **Where the ticket lives.** In-memory is one line and breaks on multi-replica
  deployments (the ticket is minted on pod A, the upload lands on pod B, and the
  restore path fails in exactly the incident it exists for). A row in PostgreSQL,
  consumed by a conditional `UPDATE`, is single-use by the index rather than by
  convention. Recommendation: a table, with the compare-and-set as the consumption,
  reached through `withUserContext` from a validator passed into the middleware
  (`main.ts` already has the `DataSource`).
- **When it is consumed.** At admission, not after the body arrives: a ticket
  released on failure is a replay window. A failed upload costs one more cheap
  round trip.
- **What it costs.** One indexed read plus one write per upload attempt, on a path
  that runs a handful of times per deployment lifetime. Only for requests
  `willBuffer` already selects.

### D3. Break the circularity (DR-F3RB-004): derive capacity first, then the ceiling

**The measurement has now been taken** (WP1 below; the record is
`backend/src/backup/restore-peak-rss.record.json`). It changes this decision from a
tuning question into a correctness one, so the numbers come first:

| Expanded artifact | Worst implied multiple | At a 304 MiB heap (the model's own headroom) |
|---|---|---|
| 24 MiB | 7.99 | completes |
| 48 MiB | 7.37 | completes |
| 96 MiB | 6.89 | **4 of 5 artifacts cannot be decoded at all** |

`PEAK_MULTIPLE = 3` is therefore short by a factor of about 2.3, and that is measured
over the **decode phases only** -- attachment staging and the insert transaction are
not in it, so every figure above is a lower bound. Three consequences, each of which
outranks the original framing of this decision:

- **The default pod cannot restore what it admits.** On a 400 MiB container the
  derived expanded ceiling is 100 MiB and the gate admits one restore; decoding a
  96 MiB artifact needs about 700 MiB of resident memory. "One slot with 4 MiB spare"
  describes a restore that does not finish.
- **The cost is the artifact's, not the heap limit's.** Above the point where the
  decode completes, the peak barely moves between a 512 MiB and a 1 GiB heap cap. So
  this is not V8 hoarding because it was allowed to, and capping the heap is not a
  mitigation: it converts an OOM-killed pod into a process-fatal JavaScript heap
  failure, which loses the server either way. Worth knowing separately: **nothing in
  this repository sets `--max-old-space-size`**, so V8 sizes its old space from *host*
  memory rather than from the cgroup limit.
- **The relationship is affine, not proportional.** The multiple *rises* as the
  artifact shrinks, because part of the cost does not scale with the payload. So no
  single multiple is right everywhere, and whichever one the code keeps has to be the
  worst over the sizes that deployment admits.

Two candidate shapes, with the measured ~7.9 and a 15% margin (about 9.1):

- **Option A, keep the shape, raise the constant.** `PEAK_MULTIPLE = 9` leaves the
  expanded default at a quarter of the container -- 100 MiB on the default pod -- and
  models a 900 MiB peak against 304 MiB of headroom, so
  `computeRestoreProcessingSlots` returns 0 and **every restore is refused** until the
  operator raises the pod. Honest, and a hard regression for every existing
  deployment.
- **Option B, solve for the ceiling (recommended).** Derive the expanded limit from
  the headroom instead of from a fixed share:
  `expanded = (container - baseline) / (measuredMultiple * safetyMargin)`, with **no
  usability floor** -- the same lesson `safeDerivedUploadLimit` already carries, where
  resolving a usability minimum and a safety maximum with `max()` let the floor win
  over the safety. On a 400 MiB pod that is about 33 MiB expanded, a 264 MiB modeled
  peak, 40 MiB spare and one slot. The compressed ceiling has to come down with it:
  66 MiB of wire cannot expand to under 33 MiB, so a limit that admits it is a
  promise the decompressor will break.

Under Option B the chain has one measured input, and the slot count is at least one
whenever the container exceeds the baseline -- by construction rather than by luck.
The invariant to assert, for every supported pod size: `baseline + slots * measured *
expanded <= container`, with a stated minimum spare.

**The cost of Option B is user-visible and belongs to the issue's owner**: on a
default 400 MiB pod the largest restorable artifact drops from a nominal 100 MiB
expanded to about 33 MiB. The counter-argument is that the nominal figure was never
real -- an operator attempting it today loses the pod mid-restore -- so the choice is
between a readable refusal and an OOM kill, not between 100 MiB and 33 MiB. An
operator who needs the larger artifact raises `resources.limits.memory`, and the
startup warning already names that lever.

### D4. Reconcile the baseline with the chart

`restoreProcessBaselineBytes` reserves 96 MiB; `helm/values.yaml` requests 140 MiB.
After measuring the idle-but-serving RSS of the real image, **one** of the two moves
to match the measurement, and the other cites it. A number that exists twice and
disagrees is the clearest argument in the issue for measuring at all.

## 2. Work packages

Ordered by dependency. WP1 gates the constants in WP2; WP3 and WP4 are independent of
the measurement and can land first.

### WP1 -- the peak-RSS harness and its record (DR-F3RB-004) -- DONE

Shipped as `backend/src/backup/restore-peak-rss.harness.ts` (run it with the
`backup:peak-rss` script), the committed record
`backend/src/backup/restore-peak-rss.record.json`, its guard
`backend/src/backup/restore-peak-rss.record.spec.ts`, and a `workflow_dispatch` job in
`.github/workflows/restore-peak-rss.yml`. Results are in D3 above.

Two things the harness had to learn the hard way, both now written into it:

- **Measure the compiled build.** Under ts-node the TypeScript compiler allocates
  inside the process being measured; the first run reported multiples above 6 that
  were partly its own. The child process runs `dist/` wherever it exists, with
  `execArgv: []` so `fork` does not pass `-r ts-node/register` on, and the record
  carries the runtime per case so a wrongly-taken measurement cannot be mistaken for
  evidence.
- **`ru_maxrss` is not a baseline.** It is a high-water mark a process can start with
  already set, so subtracting it hid however much the child had allocated below that
  mark. The measurement now samples its own RSS and keeps `ru_maxrss` beside it for
  comparison only. And a child that dies for a reason *other* than memory is recorded
  as `failed`, which aborts the sweep -- reporting it as `heap-exhausted` is how a
  harness bug becomes a measurement, and that happened once here.

What is still missing, and why the record says so rather than implying otherwise: the
database phase (attachment staging, the insert transaction) is not measured, and no
run has been cgroup-constrained, because this environment has no Docker daemon. The
heap-cap sweep substitutes for part of the second question -- it shows what does not
complete inside the model's own headroom -- but it does not show whether the pod is
refused or killed. Remaining below, unchanged in intent:

Not a unit test: a full-path measurement needs a container with a real memory limit,
and it must not run in `test:unit` where a 400 MiB cap would fail the suite on a
developer laptop.

- A script under `scripts/` that runs the real restore path in a
  `docker run --memory=<limit>` container, samples `process.memoryUsage.rss()` on an
  interval, and reads the authoritative peak from the cgroup
  (`/sys/fs/cgroup/memory.peak`) after each case. The in-process sample explains the
  shape; the cgroup number is the verdict, because it is what the kernel kills on.
- The matrix, from `docs/testing-contract.md`'s adversarial list plus what this path
  actually varies: plain and encrypted artifacts (MZBE v1 and v2); compression ratios
  at both ends (highly repetitive text, incompressible attachment bytes); artifact
  sizes at and just under the resolved wire limit; an attachment-heavy artifact, since
  base64 rows are the irreducible row cost; and each case repeated with concurrent
  ordinary traffic so the baseline is measured under load rather than idle.
- Output: a committed record of `(case, container limit, expanded bytes, peak RSS,
  implied multiple)` and the derived `measuredMultiple = max(implied)`. Committed,
  because a measurement nobody can find is an estimate again in six months.
- CI: a `workflow_dispatch` job (plus a label trigger) rather than a per-PR gate --
  shared runners are noisy, and a flaky memory gate teaches people to re-run. Take the
  maximum over N runs and apply the margin there.
- A cheap guard that *is* a per-PR gate: a spec asserting the constants in
  `backup-limits.ts` match the committed measurement record, so changing one without
  the other fails. `docs/verification-contract.md` gains the row naming this test kind
  and its owning job.

### WP2 -- constants and derivation (DR-F3RB-004, code) -- DONE

Option B, approved. `PEAK_MULTIPLE` is now `Math.ceil(MEASURED_PEAK_MULTIPLE)` = 8,
the expanded ceiling is solved out of the headroom
(`deriveRestoreExpandedLimitBytes`), the compressed ceiling is that same number, and
the process baseline's floor moved to the chart's own 140 MiB request (D4).

| Pod | Largest artifact | Slots | Modeled total |
|---|---|---|---|
| 200 MiB and below | none, refused with 503 | 0 | -- |
| 256 MiB | 3.5 MiB | 1 | 239 MiB |
| 400 MiB (default) | 23.6 MiB | 1 | 361 MiB |
| 1 GiB | 101.8 MiB | 1 | 901 MiB |
| 8 GiB | 903 MiB | 1 | 7209 MiB |
| 32 GiB | 1 GiB (the cap) | 4 | 31 GiB |

The cost model behind those numbers is a **line**, not a multiple:
`6.081 * expanded + 78 MiB`, fitted to the committed record as an upper envelope
rather than a best fit. Review caught the multiple-only version admitting restores
the same record says cannot be decoded -- a 200 MiB pod was handed a 6 MiB ceiling
whose measured decode needs about 116 MiB against 60 MiB of headroom.

Four consequences worth naming, because each is a behaviour change:

- **A 256 MiB pod can now restore** (a ~3.5 MiB artifact) where it previously derived
  zero slots and refused everything.
- **Pods at or below about 220 MiB refuse everything**, because the fixed part of a
  restore's cost does not fit their headroom -- which the measurement says is the
  truth, and a refusal is what an operator can act on.
- **A 1 GiB pod gets a larger ceiling than the multiple-only model gave it** (101 MiB
  against 87), because that model charged the fixed overhead again for every byte.
- **One slot is structural.** Concurrency now comes only from the 1 GiB cap or from an
  operator lowering `BACKUP_RESTORE_EXPANDED_LIMIT` on purpose.
- **The cramped-upload warning threshold dropped to 16 MiB**, because the derived
  default on the chart's own default pod is ~23 MiB and a warning that fires on the
  default configuration is a warning nobody reads.

The three defect-pinning tests were rewritten to the property: the break-even
multiple now exceeds the measured one with margin, the record is the source of the
constant in both directions, and the record must *demonstrate* -- not merely exceed
-- what the derivation admits. The one remaining gap is the release note for
operators, whose artifacts above the new ceiling will start being refused.

### WP3 -- bounded, abort-aware processing queue (DR-F3RB-002)

Implements D1, in `restore-processing-gate.ts`.

- `acquire` takes an `AbortSignal` and a wait deadline. A waiter is stored with its
  identity so it can be removed on abort or timeout, rather than surviving as a
  resolve callback nobody can find.
- A queue bound, declared as data next to its documentation and resolved through
  `resolvePositiveInt` (`backend/src/common/env-number.util.ts`) -- never a bare
  `Number(...)`. Documented in `.env.example` and rendered by the chart, both of which
  CI checks (`scripts/check-docs-manifests.mjs`, the env-doc job).
- Queue full, and wait deadline exceeded, both answer 503 **with** `Retry-After`. The
  zero-capacity 503 stays without one -- that distinction is already documented on the
  route (`backend/src/backup/backup.controller.ts`) and the Swagger text has to grow
  the two new conditions in the same commit.
- The signal comes from the request, wired in the controller, and governs **only** the
  wait. Once the slot is acquired the signal is ignored, and that is a test, not a
  comment.
- New refusal messages go through `tr(...)` with English catalog entries plus a
  regenerated pseudo-locale; the other locales come in one pass at acceptance, per the
  English-first rule in the root `CLAUDE.md`.

Test matrix (each of these is a way the current code is wrong or could become wrong):

| Case | Expected |
|---|---|
| Client disconnects while queued | Waiter removed, `waitingCount` returns to 0, the restore never runs |
| Client disconnects while holding a slot | Restore runs to completion; no cancellation |
| Queue at its bound | 503 with `Retry-After`, nothing reserved |
| Wait deadline expires | 503 with `Retry-After`, waiter removed |
| Capacity reconfigured to 0 with waiters queued | All rejected (existing behaviour, kept) |
| FIFO order under mixed aborts | Remaining waiters keep their order |
| Every path | `waitingCount` and `activeCount` return to 0; no leak |

### WP4 -- upload ticket and ingress limits (DR-F3RB-003) -- DONE

Implements D2, with one design decision changed on the way: the ticket is **signed,
not stored**.

D2 preferred a database row consumed by a conditional `UPDATE`, for single use. What
that would have bought is narrower than it looked, and what it costs is real: a row
means a migration, an RLS decision, a backup classification and a `with-context`
allowlist entry, and the *verification* would then be a database round trip in front
of the body parser -- a new lever for exactly the load the gate exists to refuse. The
in-memory alternative is worse still: the ticket is minted on the pod that served the
JSON request and the upload can land on another, so it would fail on the multi-replica
deployments where it matters.

So the ticket is an HMAC over `{userId, expiresAt}`, keyed by a value derived from
`JWT_SECRET` with a domain separator. It verifies on any replica, costs one hash, and
rotating `JWT_SECRET` invalidates outstanding tickets. The honest cost is that it can
be replayed inside its five-minute window, and the ticket authorizes *occupying upload
budget* -- not restoring anything, which still needs the JWT, the CSRF pair and the
OIDC re-authentication artifact. Stated in the module comment and in the contract
rather than left for a reader to discover.

Shipped:

- `restore-upload-ticket.ts` (mint, verify, and the authorizer the gate calls),
  `POST /backup/restore/ticket` on `BackupController`, and the `authorize` hook on
  `createRestoreUploadAdmission` -- called before the size check and before any
  reservation, so a refused request has claimed nothing.
- The frontend mints a ticket immediately before uploading and sends it under the
  header name **the server returned**, so the two cannot drift.
- `helm/README.md` documents the ingress body-size and rate limits per controller,
  and says plainly that the chart's default HTTPRoute path has no portable
  equivalent -- which is why the in-process gate exists.
- Tests: a forged expiry, a foreign key, an expired ticket, a missing one and a
  repeated header at the token level; at the gate, that a refused request reserves
  nothing and that twenty of them in a row still reserve nothing; a source guard that
  the gate is actually built with the authorizer (the hook is optional, so nothing
  else would catch a deployment that quietly went back to admitting everyone); and on
  the client, that the ticket is requested *before* the upload and that no upload is
  sent when the ticket is refused.

The OIDC re-authentication ordering in `backend/src/backup/backup-restore.service.ts`
is untouched: the ticket authorizes the *upload*, the OIDC artifact authorizes the
*destruction*, and section 5 of the contract fixes the second one's place.

### WP5 -- documentation, translations, and the note for operators

Done: every locale carries the three new refusal strings, and the "too large to
restore" message was **corrected in all nineteen** -- it told the operator to raise
`BACKUP_RESTORE_EXPANDED_LIMIT`, which under the new derivation drives the slot count
to zero and refuses every restore. An error message that recommends the harmful
action is worse than the refusal it explains.

Not done, because it belongs to whoever cuts the release: `docs/release-notes/` holds
one file per shipped version, named for the exact version, and inventing the next
version number here would be guessing. Draft copy to paste, under **Backup and
restore**:

> **A restore's memory cost was measured, and the ceilings moved.** The restore path
> assumed a restore costs three times its uncompressed size. Measured, it costs about
> eight -- so the old ceilings admitted restores the process could not finish, and on
> the default 400Mi backend a large one lost the pod instead of being refused. The
> ceilings are now derived from the container's memory and that measurement: a default
> pod accepts about 23MiB of uncompressed backup instead of a nominal 100MiB, a 256Mi
> pod can restore small ones where it previously refused everything, and a pod under
> about 220Mi refuses restores with an error naming the fix -- a restore costs a
> fixed ~78MiB before it costs anything per byte, and a pod that small never had the
> room. If a real backup
> starts being refused, raise `backend.resources.limits.memory` (or the container's
> memory limit) -- raising the backup ceiling alone is what used to restart the pod.
> Restores also queue with a bound and a deadline now, a caller who disconnects while
> queued no longer has their restore run without them, and an upload must carry a
> short-lived ticket from the authenticated session, so an anonymous request can no
> longer occupy the restore path.

### WP5b -- documentation, and one correction landed with this plan

- Section 6 of `docs/backup-restore-contract.md` said the gate "still floors capacity
  at one" -- describing a floor that F3RB-005 removed. Corrected in the same commit as
  this plan, because a contract doc asserting the opposite of the code is worse than
  no doc.
- On completion: section 6 gains the measured numbers, the queue's bound and
  deadlines, and the ticket's lifecycle; `docs/system-invariants.md` gains a restore
  admission invariant with its enforcement status; `docs/verification-contract.md`
  gains the harness row.

## 3. Acceptance

Issue #1073 closes when all of these hold:

1. A committed measurement of peak RSS per case, taken under a real cgroup limit, and
   `PEAK_MULTIPLE` (or its successor) derived from it with a named margin -- plus the
   per-PR guard that fails when constants and record disagree.
2. `restoreProcessBaselineBytes` and the chart's memory request agree, both citing the
   measurement.
3. For every supported pod size, the asserted inequality holds with a stated spare,
   and the slot count is at least one whenever the container exceeds the baseline.
4. A queued restore whose client disconnects does not run; a running restore is never
   cancelled by a socket event; the queue has a bound and a deadline, both configurable
   and documented.
5. An unauthenticated restore upload reserves nothing.
6. Section 6 of the contract describes the code, and issue #1070 can cite a measured
   bound rather than an estimate.

## 4. Risks

- **The measurement may be unaffordable.** If the true multiple is well above 3, Option
  B shrinks the default deployment's maximum restorable artifact. That is a real
  product cost, and the honest alternative is a larger default pod -- a decision for
  the issue's owner, not for the implementation.
- **CI noise.** Peak RSS on a shared runner is not reproducible to the megabyte. Hence
  max-over-N plus margin, and a dispatch job rather than a gate.
- **The ticket adds a step to a disaster-recovery path.** Two round trips instead of
  one, and a new failure mode (expired ticket) during an incident. TTL generous enough
  to cover a slow upload's start, and the refusal message must name the fix.
- **A queue holds a destructive operation waiting.** Bounded by the wait deadline; the
  operator sees a 503 with `Retry-After` rather than an indefinite hang.
