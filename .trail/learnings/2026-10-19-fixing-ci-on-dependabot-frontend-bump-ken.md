---
title: Fixing CI on Dependabot frontend bump PR 1777
author: Ken
date: 2026-10-19
branch: main
---

## Decided
- Lint failure (163 react-hooks errors) came from eslint-config-next 16.4.0 pulling eslint-plugin-react-hooks 7.1.x (stricter React Compiler rules). Held eslint-config-next at ~16.3.8 and restored the plugin's 7.0.1 lockfile entry from origin/main; next 16.4.0 and the other bumps still ship. Plugin 7.1 migration is a separate PR (~80 files).
- E2E zz-danger-zone (Firefox NS_BINDING_ABORTED on waitForURL /login): DangerZoneSection logged out without beginSignOut(), so post-deletion 401 polls hit the api.ts interceptor's window.location.replace('/login'), aborting router.push. Fixed by beginSignOut() before deleteAccount, endSignOut() on failure, with a regression test.
- Pushed fixes to the dependabot branch (user's choice); dependabot stops rebasing it after that.

## Tried and ruled out
- npm overrides pinning react-hooks 7.0.1 under eslint-config-next 16.4.0: violates its declared ^7.1.0 range.
- Changing eslint-config-next to ^16.3.8: still resolves 16.4.0; needed ~16.3.8, and npm keeps react-hooks 7.1.1 in the lock unless its entry is restored by hand.
- "Verify PR checklist" failure: fails on every dependabot PR (approved-to-build label gate) and they merge anyway; fixing it means a .github/ change, so left alone.

## Watch out
- Playwright traces in the e2e-report-shard-N artifact (data/*.zip, *-trace.network) show the exact request race; quickest way to diagnose E2E navigation aborts.
- Any new code path that ends the session must call beginSignOut() first, like AppHeader, or the 401 interceptor races its navigation.
- Do not run full lint/tests locally in monize (crashes WSL); single file only, after asking.
- Second Next 16.4 race (calendar.spec.ts, Firefox): /transactions router.replace'd to its own URL on every load; when a full-page goto cancels that RSC fetch, Next logs 'Failed to fetch RSC payload ... Falling back to browser navigation' and hard-loads /transactions over the goto. Fixed with a same-URL guard in useTransactionFilters.updateUrl. Grep trace console for that message when E2E shows NS_BINDING_ABORTED.
