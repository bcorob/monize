---
title: "simplefin cache-key hash: reuse hashToken instead of a new CodeQL sink"
author: Node
date: 2026-10-24
branch: claude/issue-1850
cost: { minutes: 9, tokens: 92658 }
touches:
  - backend/src/bank-sync/providers/simplefin/simplefin.provider.ts
  - docs/backend/modules-and-runtime.md
  - backend/src/auth/crypto.util.ts
  - backend/package-lock.json
  - frontend/package-lock.json
---

## Decided
- CodeQL js/insufficient-password-hash on simplefin.provider.ts:151 (SHA-256 of `credentials.accessUrl`, which embeds a `user:password@` SimpleFIN access URL) is the documented false-positive pattern in docs/backend/modules-and-runtime.md: a deterministic digest used only as an in-memory memoization key (per-AsyncLocalStorage-scope Map), never stored or compared for auth. Fix: delete the inline `createHash("sha256").update(...).digest("hex")` and call the existing `hashToken` helper (backend/src/auth/crypto.util.ts) instead, which already carries the `codeql[js/insufficient-password-hash]` annotation and justification. No new sink, no new suppression needed.
- Issue #1850 also listed two Dependabot CVEs (undici < 8.12.2, fast-uri < 3.1.9). Both were already fixed by previously-merged PRs #1847/#1848 before this session started -- confirmed by reading resolved versions out of backend/package-lock.json and frontend/package-lock.json (`node -e` over `lock.packages`), not by re-running npm audit. Nothing to change there.

## Tried and ruled out
- Adding a fresh `// codeql[js/insufficient-password-hash]` annotation directly above a new inline createHash call at the simplefin.provider.ts call site -- works but duplicates a sink the codebase already centralizes in hashToken; reuse is the convention ("find how the codebase already does it").

## Watch out
- `trail check` flags importing `hashToken` from `auth/crypto.util` in bank-sync as conflicting with Ken's Android learning about ruling out Bearer-token native auth. That's a false-positive keyword match (token/auth) -- the Android learning is about REST authentication transport, unrelated to this in-process SHA-256 cache-key helper. Said so in the commit message rather than treating it as a real conflict.
- A fresh worktree's `backend/` has no node_modules; `npm ci --ignore-scripts` is needed before any Jest/tsc run can even start.
