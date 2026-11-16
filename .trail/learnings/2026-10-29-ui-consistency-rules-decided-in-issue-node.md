---
title: UI consistency rules decided in issue 1914 live in screens-and-dialogs.md
author: Node
date: 2026-10-29
branch: claude/issue-1914
cost: { minutes: 4, tokens: 67787 }
touches:
  - docs/frontend/screens-and-dialogs.md
  - docs/frontend/ui-conventions.md
  - AGENTS.md
  - frontend/CLAUDE.md
---

## Decided
- The maintainer accepted every recommendation: the doc states the target and each reference screen that misses it is listed in the "Known debt" table at the end of docs/frontend/screens-and-dialogs.md; the debt is never a pattern to copy.
- Registers (Transactions, Investments) are their own page kind: a chart may replace summary cards, and a many-field filter panel may fold if its folded header shows the active count and Clear.
- Export is optional and goes through ListTopToolbar `actions`; Refresh lives in the PageHeader actions; the count line is ListBottomPager `totalLabel`; summary rows use SummaryCardGrid.
- Confirmations are an exempt dialog kind (icon, smaller title, question paragraph) but use Button variants; titles are Title Case phrases, not questions.
- Wording: Title Case for labels and buttons (prepositions of 3 letters or fewer stay lower case, phrasal particles capitalised), "Save"/"Save Changes", "Try Again", "e.g.", "...", "Failed to ..." without a period.
- Control-level rules (heroicons outline, icon sizes, tabular figures, title is not an information channel, useDateFormat, meaning colours, sortable Th) went into ui-conventions.md.

## Tried and ruled out
- Narrowing the doc to what reference screens do today: rejected, the doc is prescriptive and the gaps are tracked in the five code issues.
- The 800-line file limit: left for a separate issue, AGENTS.md was out of scope.

## Watch out
- trail check flags these doc edits with word-overlap false positives against unrelated learnings.
- frontend/CLAUDE.md index lines for the new rules were not added (issue scoped to the two docs).
