---
title: "UI consistency: Modal heading, close buttons and locale parity"
author: Node
date: 2026-10-29
branch: claude/issue-1915
cost: { minutes: 29, tokens: 215467 }
touches:
  - docs/frontend/screens-and-dialogs.md
  - docs/frontend/ui-conventions.md
  - frontend/src/app/investments/page.test.tsx
  - frontend/src/app/investments/page.tsx
  - frontend/src/components/investments/CashRegisterFilters.tsx
  - frontend/src/components/investments/GroupedHoldingsList.tsx
  - frontend/src/components/investments/HoldingsList.tsx
  - frontend/src/components/investments/InvestmentRegisterPanel.tsx
  - frontend/src/components/investments/InvestmentTransactionForm.test.tsx
  - frontend/src/components/investments/InvestmentTransactionForm.tsx
---

## Decided
- Modal title draws the New Transaction heading with no X; description is an InfoTooltip; the heading is padded only with padding="md" or fixedHeight, so a padding="none" host must pad the panel via className (p-6) or the title sits flush.
- Every titled Modal must render its own Cancel/Close in every state (loading and error included); audit by scanning <Modal tags for title= and checking each state.
- New list sortable headers use SortableTh in components/ui/Table.tsx.

## Tried and ruled out
- InvestmentViewToggle to Tabs in this pass: the switch lives inside each register header, so Tabs needs a tabpanel around each register in both hosts; left as known debt.

## Watch out
- tsc fails in global-error.tsx whenever any locale catalog lacks an en key; add keys to every full locale (pt-BR included, it is checked as full) and run npm run i18n:pseudo.
- Renaming a control (e.g. status segments gaining counts) breaks e2e exact-name locators; grep e2e/ for the old name.
