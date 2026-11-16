---
title: UI consistency hub issue 1914 needs maintainer decisions before doc edits
author: Node
date: 2026-10-29
branch: claude/issue-1914
cost: { minutes: 1, tokens: 51423 }
touches:
  - docs/frontend/screens-and-dialogs.md
---

## Decided
- Nothing yet. Issue #1914 asks a maintainer to rule on each contradiction between docs/frontend/screens-and-dialogs.md and the reference screens; the run posted 24 numbered recommendations and stopped for an answer.
- Proposed approach: the doc states the target and lists reference-screen gaps as known debt tracked in #1915-#1919, rather than narrowing the doc to today's code.

## Tried and ruled out
- Writing the rules without maintainer input: the issue explicitly reserves every rule for a maintainer decision.

## Watch out
- ListTopToolbar has no export control of its own; export goes through its `actions` prop (Transactions), so the current doc rule names a control that does not exist.
- TransactionFilterPanel's collapsed header already shows the active-filter count and Clear, which is the basis for a "register" exemption from "filters are always visible".
- Candidate rules R23 ("Try again") and R28 (button text Title Case) conflict; resolve them together.
