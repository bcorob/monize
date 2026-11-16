---
title: Money classifications live in CT + CAT.hct + TRN.lHcls1/lHcls2; the sleeve-side cash row tag moves to the trade leg
author: Ken
date: 2026-10-24
branch: main
id: l-82ca84f2
scope: repo
status: active
replaces: l-ba7de7ad
src: agent
touches:
  - backend/src/import/mny/README.md
  - backend/src/import/mny/map/check-holdings.spec.ts
  - backend/src/import/mny/map/investment-cash.spec.ts
  - backend/src/import/mny/map/investment-cash.ts
  - backend/src/import/mny/map/map-classifications.spec.ts
  - backend/src/import/mny/map/map-classifications.ts
  - backend/src/import/mny/map/map-investments.ts
  - backend/src/import/mny/map/map-loans.spec.ts
  - backend/src/import/mny/map/map-reference.ts
  - backend/src/import/mny/map/map-transactions.ts
---

## Decided
- Money's two classifications are `CT` rows (`hct` 1, 2; `hct` 0 is the category tree). Items share `CAT` with categories, told apart only by `CAT.hct`; a top-level item is `nLevel` 0 with a null parent like the INCOME/EXPENSE roots. `TRN.lHcls1`/`lHcls2` name the item per row (-1 = none). Measured on klasko.mny (one classification, one item on 67 rows: 53 postings, 5 split legs, 9 templates, 0 investment rows) and all five fixtures (none).
- Imported as tags `<classification>:<item path>` (`Properties:20 Spring Apartment`), the existing `key:value` convention; referenced items only via `TagsService.findOrCreateByNames`. Code: `backend/src/import/mny/map/map-classifications.ts`, `writers/write-tags.ts`; `mapCategories` filters `isClassificationItem` first. `tagHandles` sits on every mapped row (`MappedTransaction`, `MappedSplit`, `MappedBill`, `MappedInvestmentTransaction`).
- A classification on Money's own sleeve-side cash row (a `tradeCashLegs` row, dropped since #1175) moves onto the trade's writer-created leg: `mapTransactions` exposes `tradeCashLegTagHandles`, `adoptCashLegTags` unions it in. Without that the tag vanishes with nothing to warn, because the row is correctly not imported.

## Tried and ruled out
- A per-`htrn` side-channel map from parser to investment writer (review finding): three representations of one fact and the inspector could not show trade tags. Putting `tagHandles` on the mapped investment row touched one construction site plus builders.

## Watch out
- `TagsService` trims names before storing; clamp a generated name to 100 chars and then trim, or the returned name no longer matches its handle (`classificationTagName`).
- The report tile keys on `tagLinksApplied`, not `tagsCreated`: a re-import into a populated profile creates no tag but links every row.
- `ImportModule` imports `TagsModule` as a bare edge; `module-graph.spec.ts` accepted it, so no `forwardRef` there.
