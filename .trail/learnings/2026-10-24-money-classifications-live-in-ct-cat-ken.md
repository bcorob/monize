---
title: "Money classifications live in CT + CAT.hct + TRN.lHcls1/lHcls2 and import as key:value tags"
author: Ken
date: 2026-10-24
branch: main
id: l-ba7de7ad
scope: repo
status: active
src: agent
touches:
  - backend/src/import/import.module.ts
  - backend/src/import/mny/README.md
  - backend/src/import/mny/__fixtures__/mny-row-builders.ts
  - backend/src/import/mny/map/map-bills.spec.ts
  - backend/src/import/mny/map/map-bills.ts
  - backend/src/import/mny/map/map-classifications.spec.ts
  - backend/src/import/mny/map/map-classifications.ts
  - backend/src/import/mny/map/map-loans.spec.ts
  - backend/src/import/mny/map/map-reference.spec.ts
  - backend/src/import/mny/map/map-reference.ts
---

## Decided
- Money's two user-named classifications are one `CT` row each (`hct` 1 and 2; `hct` 0 is the category tree itself). Their items share the `CAT` table with categories, told apart only by `CAT.hct`; a top-level item is `nLevel` 0 with a null parent, exactly like the INCOME/EXPENSE roots. `TRN.lHcls1` / `lHcls2` name the item per row (-1 = none); `lHclsKak` was -1 on every row and is not read. Measured on klasko.mny (one classification "Properties", one item on 67 rows: 53 postings, 5 split legs, 9 recurrence templates, 0 investment rows) and all five fixtures (no classifications).
- Imported as tags named `<classification>:<item path>` (`Properties:20 Spring Apartment`) so the existing `key:value` tag convention (`backend/src/tags/tag-key-value.util.ts`) groups them; referenced items only, find-or-create through `TagsService.findOrCreateByNames`. Code: `backend/src/import/mny/map/map-classifications.ts`, `writers/write-tags.ts`; `mapCategories` now filters `isClassificationItem` first.
- Each `TRN` row's own slots decide its tags (transfer sides and split legs independently); a trade's writer-created cash leg takes the investment row's item via `tagIdsByTransactionHandle`; bill templates carry theirs into `scheduled_transactions.tag_ids`.

## Tried and ruled out
- Threading the handles through `MappedInvestmentTransaction`: four construction sites plus many spec literals for zero rows in the real file. A per-`htrn` map from the parser to the investment writer covers the same case in one place.

## Watch out
- Without the `hct` filter a nested classification item (`nLevel` 1 under a level-0 item) imports as a top-level category when "only referenced categories" is off; the level filter alone only hides the top-level items.
- `ImportModule` now imports `TagsModule` as a bare edge; `module-graph.spec.ts` accepted it (no cycle), so do not add a `forwardRef` there without a reason.
