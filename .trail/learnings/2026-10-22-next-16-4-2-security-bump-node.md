---
title: next 16.4.2 security bump and the patch-package file name
author: Node
date: 2026-10-22
branch: claude/issue-1835
cost: { minutes: 11, tokens: 37573 }
touches:
  - docs/future-plans/windows-installer-tasks.md
  - docs/future-plans/windows-installer.md
  - frontend/package-lock.json
  - frontend/package.json
  - frontend/patches/next+16.4.2.patch
  - scripts/npm-audit-gate.mjs
  - package.json
---

## Decided
- GHSA-2464-fhr4-w9xw (critical) and GHSA-p3m5-59mp-jv5r (high) cover next >=16.0.0 <=16.4.0 and fail scripts/npm-audit-gate.mjs (prod deps, high+). Fixed with `npm install next@^16.4.2 --ignore-scripts` in frontend/: package.json floor plus a lockfile diff of next and its @next/swc binaries only (3 packages).
- The body-streams patch applied to 16.4.2 unchanged; renamed frontend/patches/next+16.3.4.patch to next+16.4.2.patch so patch-package stops warning. docs/future-plans/windows-installer*.md name the pinned version and were updated with it.
## Watch out
- After renaming the patch, reinstall next (rm -rf node_modules/next && npm ci --ignore-scripts) before `npx patch-package --error-on-fail`, or it reports the patch as already applied/mismatched.
- src/test/next-body-streams.test.ts is the test that proves the patch still holds.
- Run the gate locally with `node scripts/npm-audit-gate.mjs` after npm ci in both backend/ and frontend/.
