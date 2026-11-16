---
title: Backend Docker build OOM on 8 GB WSL host
author: Ken
date: 2026-10-19
branch: main
touches:
  - backend/Dockerfile
---

## Decided
- `nest build` (full tsc over backend/src) now exceeds Node's default ~2 GB heap on an 8 GB host (WSL VM). Fix in backend/Dockerfile builder stage only: `RUN NODE_OPTIONS=--max-old-space-size=4096 npm run build`. Runtime image unaffected.
- Edit left uncommitted on local main (repo rules: no commits to main, release path is ask-first).

## Tried and ruled out
- ESLint changes: PR #1778 (eslint-config-next 16.4) touches no backend files. The earlier tsconfig `lib` change (e96c8bb, es2022.error) matches the ES2021 defaults, so it isn't the cause.
- CI: GitHub runners have 16 GB, so the default heap is ~4 GB and main image builds stay green. Only local builds fail.

## Watch out
- Growth came from the 2026-10-19 merges (email-receipts, ai-review, 13-package backend bump in #1776). Heap use will keep climbing as the code grows.
- No ~/.wslconfig exists, so WSL runs on its default memory. Raise `memory=` if a 4 GB compile still dies.
- Not verified locally: a full tsc can crash this WSL box, so run the docker build only on purpose.
- Longer-term option: nest `builder: swc` with type-checking split out, which uses much less memory (not proposed yet).
