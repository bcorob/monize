---
title: "A new invariant needs a verification-matrix row, and test:changed does not run the parity spec that checks it"
author: Ken
date: 2026-10-27
branch: feat/payroll-deductions
id: l-214c79e5
scope: repo
status: active
src: agent
touches:
  - docs/system-invariants.md
  - docs/verification-contract.md
  - backend/src/common/invariant-catalog-parity.spec.ts
  - backend/scripts/test-changed.mjs
---

## Decided
- Every ID added to the Index table of `docs/system-invariants.md` needs a row in the matrix of `docs/verification-contract.md` (`| INV-X-001 short name | Unit | Source scan | PG integration | Two connections | Two instances | Failpoint | Provider | E2E |`, the load-bearing kind in bold). A kind no test covers yet is written `required (not yet met)`, as the WTY rows do, rather than claimed.
- `backend/src/common/invariant-catalog-parity.spec.ts` holds the two in step; PR 1884 failed Backend Unit Tests on it for INV-PAYROLL-001..004.

## Watch out
- `npm run test:changed` (backend/scripts/test-changed.mjs) runs Jest-related specs plus `GUARD_SPEC`: `*.guard.spec.ts`, `doc-paths`, `source-comment-paths`, `instruction-files`. The parity spec matches none of them and reads markdown, so editing the catalog never selects it. Run `npm run test:unit -- invariant-catalog-parity` after adding an invariant. Renaming it to `.guard.spec.ts` or widening `GUARD_SPEC` would close the gap; that is a tooling change to propose, not to make in passing.
