---
title: "Navigating out of a pushHistory modal: wait for its history pop"
author: Node
date: 2026-10-22
branch: claude/issue-1835
cost: { minutes: 11, tokens: 114385 }
touches:
  - docs/frontend/ui-conventions.md
  - frontend/src/app/transactions/page.tsx
  - frontend/src/lib/after-modal-history-pop.test.tsx
  - frontend/src/lib/after-modal-history-pop.ts
  - frontend/src/components/transactions/AttachmentsSection.test.tsx
  - frontend/src/components/transactions/AttachmentsSection.tsx
---

## Decided
- Issue 1835: Add warranty from the transaction edit window sometimes left the reader on Transactions. Cause: the page closed the Modal and router.push'd after a fixed 100 ms; the Modal's programmatic history.back() is async and, on a slow render, landed after the push and undid it.
- Fix: frontend/src/lib/after-modal-history-pop.ts waits for the popstate that leaves the entry marked `{ modal: true }` (Modal.tsx's marker), next-task when no modal entry is current, 1 s ceiling. Used by navigateAfterFormCloses in app/transactions/page.tsx.
- The helper lives in lib/, not Modal.tsx, because page tests mock '@/components/ui/Modal' wholesale.
## Watch out
- AccountForm handleImportQif / handleViewLoanDetails still use the same fixed setTimeout(…, 100) and can lose the same race.
- Modal.tsx's pendingProgrammaticPops is only decremented by another open modal's popstate listener; after a programmatic close with no other modal open it stays incremented, so the next modal's first browser-back popstate is swallowed. Not fixed here.
- jsdom does fire popstate for history.back() on same-document entries, so the real Modal can be tested against the helper.
