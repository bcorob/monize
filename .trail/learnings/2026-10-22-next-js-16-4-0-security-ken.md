---
title: Next.js 16.4.0 security insight on monize
author: Ken
date: 2026-10-22
branch: main
touches:
  - frontend/src/app/transactions/page.test.tsx
  - frontend/src/app/transactions/page.tsx
  - "frontend/src/app/warranties/[id]/page.tsx"
  - frontend/src/components/transactions/TransactionForm.test.tsx
  - frontend/src/components/transactions/TransactionForm.tsx
  - frontend/src/components/transactions/TransactionWarrantiesLine.test.tsx
  - frontend/src/components/transactions/TransactionWarrantiesLine.tsx
  - frontend/src/i18n/messages/de/transactions.json
  - frontend/src/i18n/messages/en/transactions.json
  - frontend/src/i18n/messages/es/transactions.json
---

## Decided
- No code change needed: main already pins next/eslint-config-next 16.4.2 (commit 181f1070f, fixes GHSA-2464-fhr4-w9xw and GHSA-p3m5-59mp-jv5r).
- The warning comes from deployed artifacts: release v1.19.0 ships next 16.4.0 (v1.18.0 shipped 16.3.8). Fix = redeploy from main (./build-push-deploy.sh frontend) and/or cut a release (v1.19.1 cherry-pick of 181f1070f, or full release from main).

## Tried and ruled out
- Looking for a stale next version elsewhere in the repo: root package-lock has no next; frontend is the only Next.js consumer.

## Watch out
- `git tag --contains` vs `git describe` output can be confused when chained; verify the release's actual version with `git show <tag>:frontend/package-lock.json`.
- build-push-deploy.sh builds from the working tree, so uncommitted changes go into the image.
- Host frontend/node_modules may be missing; don't rely on it for the installed version.
