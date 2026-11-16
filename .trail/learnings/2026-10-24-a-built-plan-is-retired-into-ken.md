---
title: "A built plan is retired into docs/specs with a shipped header, its task list deleted and every citation repointed"
author: Ken
date: 2026-10-24
branch: docs/retire-warranty-plan
id: l-6d703740
scope: repo
status: active
src: agent
touches:
  - docs/specs/warranty-tracker.md
  - docs/specs/advanced-search.md
  - database/schema.sql
  - backend/eslint.config.mjs
  - docs/system-invariants.md
  - docs/cron-jobs.md
  - docs/backend/README.md
  - docs/specs/notification-preferences.md
  - backend/src/backup/support-backup/support-backup-rules.warranties.ts
  - backend/src/common/doc-paths.spec.ts
---

## Decided
- A plan in docs/future-plans whose task list is fully ticked is retired the way d53ed4db7 did it: `git mv` the design to docs/specs/<feature>.md, rewrite the opening paragraph as "Specification of ... it shipped ... The plan is retired and this document is kept as the specification the code is held to", replace the "Companion task list" section with "## N. Follow-ups" holding anything the plan left open, and delete the tasks file. docs/specs/warranty-tracker.md (this branch) and docs/specs/advanced-search.md are the models.
- Every citation of the old path is repointed in the same commit, including comments in database/migrations/*.sql and database/schema.sql, backend/eslint.config.mjs and the contract docs (docs/system-invariants.md, docs/cron-jobs.md, docs/backend/README.md, docs/specs/notification-preferences.md). Comment-only migration edits are what the precedent did; the tracker keys on the filename.

## Watch out
- Grep for the bare basename too: backend/src/backup/support-backup/support-backup-rules.warranties.ts had the path wrapped across two comment lines ("docs/future-plans/" then "warranty-tracker.md"), so a search for the full path missed it.
- .trail/learnings files also cite the old path; never edit them. The doc-paths guard does not scan .trail.
- The gates for this kind of change are backend/src/common/doc-paths.spec.ts, source-comment-paths.spec.ts, instruction-files.spec.ts and cron-doc.spec.ts, all of which need git in the container (run as root, `apk add git`); cron-doc.spec.ts fails 6 cases without git, which looks like a real failure and is not.
- The frontend is not prettier-formatted: .lintstagedrc.cjs runs eslint --fix only for frontend/, prettier only for e2e/. `prettier --check` on frontend files warns on main as well, so it is not a signal.
