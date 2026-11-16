---
title: "Institutions filter removal / Warranties search reorder (#1927)"
author: Node
date: 2026-10-29
branch: claude/issue-1927
cost: { minutes: 8, tokens: 137748 }
touches:
  - frontend/src/app/institutions/page.test.tsx
  - frontend/src/app/institutions/page.tsx
  - frontend/src/app/warranties/page.tsx
  - frontend/src/i18n/messages/de/institutions.json
  - frontend/src/i18n/messages/en/institutions.json
  - frontend/src/i18n/messages/es/institutions.json
  - frontend/src/i18n/messages/fr/institutions.json
  - frontend/src/i18n/messages/hi/institutions.json
  - frontend/src/i18n/messages/id/institutions.json
  - frontend/src/i18n/messages/it/institutions.json
---

## Decided
- Removed the Active/Closed status filter (segmented control) entirely from
  frontend/src/app/institutions/page.tsx rather than just hiding it: it was the
  only consumer of a second accountsApi.getAll() fetch and the
  accountCountByStatus/decoratedInstitutions/statusCounts derivations, so those
  all came out together as dead code. Institution.accountCount from the
  institutionsApi response is already the full per-institution count and is a
  sufficient replacement for the Accounts column once the filter is gone.
- On frontend/src/app/warranties/page.tsx, swapped the DOM order of the search
  Input and the status filter segmented control (search first) to match the
  search-then-filter convention already used on Currencies/Securities/
  Categories/Payees pages (grep SEGMENTED_GROUP_CLASS under src/app to find
  the reference order on future "standardize this page" tasks).
- Removing a filter's i18n keys (list.statusFilter.* in institutions.json) was
  done by scripting the delete with `node -e` JSON.parse/stringify(data, null, 2)
  per locale file rather than hand-editing ~20 locale files; output formatting
  matched the existing 2-space-indent convention exactly, so this is safe to
  reuse for simple key deletions across all locales. Regenerate frontend's `xx`
  pseudo-locale afterward with `npm run i18n:pseudo` rather than hand-editing it.

## Tried and ruled out
- Did not keep accountCountByStatus/decoratedInstitutions around "just in case"
  for a future re-add of filtering — the rule here is fix forward, not keep
  dead code for hypothetical reuse.

## Watch out
- frontend/ has no node_modules in a fresh worktree; `npm ci` is required
  before vitest/tsc will run (same as the existing backend TZ=UTC memory note,
  this is the frontend analogue).
- vitest must be invoked as `npx vitest run <files> --maxWorkers=1`, not via
  `npm run test -- <pattern>` combined with workers>1, to stay inside the
  machine's memory limit on this box.
