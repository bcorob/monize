---
title: Holdings by Account table sorts every column
author: Node
date: 2026-10-25
branch: claude/issue-1856
cost: { minutes: 11, tokens: 158961 }
touches:
  - docs/frontend/tables-and-registers.md
  - frontend/src/components/investments/GroupedHoldingsList.test.tsx
  - frontend/src/components/investments/GroupedHoldingsList.tsx
  - frontend/src/hooks/useColumnHeaderActions.test.tsx
  - frontend/src/hooks/useColumnHeaderActions.tsx
  - frontend/src/lib/holdings-sort.test.ts
  - frontend/src/lib/holdings-sort.ts
---

## Decided
- GroupedHoldingsList sorts with the shared SortableHeader + useSortableTable ('investments.holdings.sort'), default mktValue desc, as asked on issue #1856. Accounts are listed by name (sortAccountsByName), not by the column sort.
- Order logic lives in frontend/src/lib/holdings-sort.ts: money columns compare in the ACCOUNT currency (marketValueAccountCurrency / costBasisAccountCurrency), % Port by marketValueDefaultCurrency, per-share columns by the shown figure; unknown (null) last in both directions; ties by symbol. HoldingRow reads the same helpers for its account/default-currency figures.
- Figure headers sort through useColumnHeaderActions' onHeaderClick (pressHandlers on SortableHeader); Symbol is structural and sorts on its own click. A phone sort strip (PHONE_HEADER_CLASS chips) sits above the hidden-below-sm header row, both rendered from one SortColumnsByField record filtered by isVisible.
- resolveHoldingsSort falls back to mktValue desc (or symbol asc if mktValue hidden) while the stored sort's column is hidden; handleSort toggles against the resolved sort, not the stored one.

## Tried and ruled out
- useSortableTable's own handleSort: toggles the stored field, so after a hidden-column fallback the arrow on screen and the click disagree.
- compareValues + negation (the reports' pattern): puts nulls FIRST in desc.

## Watch out
- jsdom renders both header rows, so tests must scope header queries to `thead tr.sm\:table-row` (or the `sm:hidden` strip) and strip the sort glyph (↑↓↕) from textContent.
