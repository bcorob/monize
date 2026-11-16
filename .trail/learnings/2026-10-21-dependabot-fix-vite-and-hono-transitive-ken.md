---
title: "Dependabot fix: vite and hono transitive bumps"
author: Ken
date: 2026-10-21
branch: main
touches:
  - backend/package-lock.json
  - frontend/package-lock.json
  - package.json
---

## Decided
- vite (frontend) and hono (backend) are transitive deps (vitest/@vitejs/plugin-react; @modelcontextprotocol/sdk/@hono/node-server). Parent ranges already allow patched versions, so fix = `npm update <pkg> --package-lock-only` in the package dir. No package.json overrides needed.
- Result: vite 8.0.16 -> 8.3.5, hono 4.13.7 -> 4.13.13. Lockfile-only changes, uncommitted at session end.

## Tried and ruled out
- Adding overrides (repo has big overrides blocks): unnecessary when parent semver range covers the fix; prefer npm update first.

## Watch out
- `npm update vite` takes latest 8.x, not the minimum patch: drags rolldown 1.0.3 -> 1.2.15, @oxc-project/types, nested lightningcss 1.33 under vite, drops wasm32 rolldown binding. ~500-line frontend lock diff is expected.
- Local node_modules were stale vs lockfile (vitest 4.1.11 installed vs ^5 required); run `npm install` before trusting `npm ls`.
- frontend `npm audit` still shows 7 highs unrelated to vite (braces, micromatch via patch-package, @next/eslint-plugin-next). Backend audit clean.
- patch-package warns next+16.3.4.patch version mismatch; pre-existing, still applies.
- Did not run tests (repo rule: no full test runs).
