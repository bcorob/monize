---
title: "Widen Warranties page search box 25%"
author: Ken
date: 2026-10-22
branch: main
touches:
  - frontend/src/app/warranties/page.tsx
---

## Decided
Search input wrapper in frontend/src/app/warranties/page.tsx (~line 490) had sm:min-w-[18rem]; changed to sm:min-w-[30rem] (later set to 30rem at user request). Phone width stays w-full.

## Tried and ruled out
Nothing else tried. Did not open in browser to confirm the placeholder text now fits. No lint, type-check or tests run (class string only).

## Watch out
Width comes from the wrapper div's min-w, not the Input component. Input fills the wrapper. Check e2e/ is not asserting on this class (not grepped).
