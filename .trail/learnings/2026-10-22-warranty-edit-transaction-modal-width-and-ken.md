---
title: Warranty edit-transaction modal width and warranty row cards
author: Ken
date: 2026-10-22
branch: main
touches:
  - "frontend/src/app/warranties/[id]/page.tsx"
  - frontend/src/components/transactions/TransactionWarrantiesLine.tsx
---

## Decided
- The purchase's Edit Transaction modal on the warranty detail page (frontend/src/app/warranties/[id]/page.tsx) uses the same width as the Transactions page: maxWidth="6xl" plus className="!max-w-[69rem]". Keep these in step if the Transactions page width changes.
- In TransactionWarrantiesLine, each warranty is a bordered card laid out like the AttachmentsSection rows: a grey tile with ShieldCheckIcon (the nav icon for /warranties), the name over its expiry date, and the status badge at the end. A shared ROW_CLASS covers both the link and the plain-text version.

## Tried and ruled out
- vitest filters with literal brackets ("[id]" or "\[id\]") match nothing. Use "src/app/warranties/[[]id]/page.test.tsx".

## Watch out
- No test checks the line's layout classes, so the specs passing doesn't prove the look; check it in the running app.
- These edits were made uncommitted on main; move them to a branch before committing.
