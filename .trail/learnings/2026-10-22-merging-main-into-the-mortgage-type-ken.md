---
title: "Merging main into the mortgage-type contract PR (#1532)"
author: Ken
date: 2026-10-22
branch: claude/issue-1514
touches:
  - ".env.example"
  - ".github/dependabot.yml"
  - ".github/workflows/ci.yml"
  - ".github/workflows/lighthouse.yml"
  - ".github/workflows/zap.yml"
  - ".hadolint.yaml"
  - AGENTS.md
  - CLAUDE.md
  - README.md
  - backend/CLAUDE.md
---

## Decided
- Resolved by taking main's side of each conflicting hunk, then re-applying the PR's intent: mortgageType only (no requestedMortgageType / mortgageTypeColumns / flagsFromMortgageType), and kept both sides' new helpers and tests.
- action-history.service.ts: kept both replayableSnapshot (PR) and legBalances (main).
- Additive spec conflicts (action-history spec, backup-restore integration spec): checked out main's file, then re-inserted the PR's added block before a named anchor test.
- Main's new test "refund-only row no reconstructed rate" relied on isVariableRate: true. It now uses interestRate null, so the interest > 0 guard is still what's exercised.
- The migration 20261003152748 keeps its name: no later migration on main touches the dropped flag columns, and apply order is authoring order.

## Tried and ruled out
- Treating the textual conflicts as the whole job: 7 fixtures main added after the PR branched still set isCanadianMortgage / isVariableRate and only show up via grep or tsc.

## Watch out
- After merging main into a branch that drops a field, grep for the field across backend/src, frontend/src and test helpers, not only the conflicted files.
- backend/test/integration/fixtures/schema-baseline.sql and legacy-mortgage-type.util.ts legitimately keep the flag names.
