---
title: "Login 'Failed to fetch auth methods' 502/timeout = backend unreachable"
author: Ken
date: 2026-10-20
branch: main
touches:
  - frontend/src/proxy.ts
  - frontend/src/lib/api.ts
  - docker-compose.dev.yml
---

## Decided
- Login page error "[Login] Failed to fetch auth methods" (502 or 10000ms timeout) is a backend availability symptom, not a frontend bug.
- 502 originates in frontend/src/proxy.ts catch block ("Backend unavailable") when fetch to INTERNAL_API_URL (dev: http://backend:3000) throws.
- Timeout is axios client timeout (frontend/src/lib/api.ts, 10000ms); proxy fetch has no timeout, so a hung/booting backend surfaces as client timeout.
- Login page falls back to local-auth defaults; red overlay is only Next dev surfacing logger.error.

## Tried and ruled out
- Local WSL had no containers or listening ports, so diagnosis could not inspect the affected stack; no code change made.

## Watch out
- Diagnose on the affected stack: `docker compose -f docker-compose.dev.yml ps`, backend logs, and frontend log line "API proxy error:" (gives ECONNREFUSED/ENOTFOUND etc.).
- 502 followed by timeout suggests backend restarting / stuck on startup (migrations, DB connection).
