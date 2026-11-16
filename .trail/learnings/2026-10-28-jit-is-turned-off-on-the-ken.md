---
title: "JIT is turned off on the app role at startup in db-init, not by a migration"
author: Ken
date: 2026-10-28
branch: fix/app-role-jit-off
cost: { minutes: 7, tokens: 67806 }
id: l-aebd268b
scope: repo
status: active
src: agent
touches:
  - backend/src/common/db/app-role.spec.ts
  - backend/src/common/db/app-role.ts
  - backend/scripts/migration-lint.mjs
---

## Decided
- `jit = off` for the runtime role is set by db-init on every startup, in its own DO block guarded on the role existing, with `insufficient_privilege` degraded to a warning. Reason: RLS subplans push register queries past the JIT cost thresholds and the compile costs ~15 s per call on an LLVM-enabled server.
## Tried and ruled out
- A migration running `ALTER ROLE monize_app SET jit = off`: migration lint refuses any CREATE/ALTER/DROP ROLE, and a migration naming a role crash-loops deployments where it does not exist.
- A migration running `ALTER DATABASE ... SET jit = off`: passes the lint but hits every role (migrator, psql, backups) and needs the migrator to own the database.
- `-c jit=off` in the dev compose file only: fixes dev, leaves any other LLVM-enabled server exposed.
## Watch out
- Keep the settings block separate from the grants block: inside it, a failed ALTER (CNPG managed.roles, no CREATEROLE) would roll the grants back too.
- Under CNPG the owner usually cannot alter the role, so production only logs the warning; set it in the cluster's managed.roles if production ever gets JIT.
- A role default reaches new sessions only: restart the backend after it first applies.
In the code: backend/src/common/db/app-role.ts (APP_ROLE_SETTINGS_SQL, provisionAppRole), backend/scripts/migration-lint.mjs (role-or-grant-statement).
