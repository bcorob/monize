---
title: Money 99 rewrites earlier trades when a split is recorded; a split warning there points at a correct number
author: Ken
date: 2026-10-28
branch: fix/mny-money99-user-report
id: l-7fbc91f8
scope: repo
status: active
src: agent
touches:
  - backend/src/import/mny/map/map-investments.ts
---

## Decided
- `reportUnappliedSplits` (backend/src/import/mny/map/map-investments.ts) returns early for `jet3`. Evidence: `sample-money99.mny` and `sample-money99-investments.mny` differ, for AMZN, only by one recorded 1:2 split, and every AMZN `TRN_INV.qty` / `LOT.qty` doubled and every `TRN_INV.dPrice` / `SP.dPrice` halved; other securities untouched. Positions read from the file already include the split.
- A Money 99 BUY with no units (CD) imports as principal at price 1 (`isPurchaseByAmount`), matching Money Plus's CD shape in `sample-cd-redemption.mny`.

## Tried and ruled out
- Converting Money 99 cross-currency trades from the file: `CRNC_EXCHG` holds one row per pair, dated when last edited, so `resolveFxRate` never finds a rate on or before a historical trade. Needs stored/provider rates at parse time; not built, a design decision for Ken.

## Watch out
- The en `securitySplitNotApplied` text says "Money does not apply them either". For Money 99 that is false (Money applies the split by rewriting the trades). The Money Plus evidence in the README (positions match `LOT` when the split is ignored) is equally consistent with the same rewrite, so the wording may be wrong there too; behaviour (never apply the ratio) is right either way.
- Comparing two versions of the same hand-built file is how a code's meaning was settled here; ask the file's author for a before/after copy when a code is ambiguous.
