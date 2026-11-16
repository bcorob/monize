---
title: Payroll deductions tour opens on its payroll-bill requirement
author: Node
date: 2026-10-27
branch: claude/issue-1885
cost: { minutes: 11, tokens: 172817 }
touches:
  - frontend/src/i18n/messages/de/tours.json
  - frontend/src/i18n/messages/es/tours.json
  - frontend/src/i18n/messages/fr/tours.json
  - frontend/src/i18n/messages/hi/tours.json
  - frontend/src/i18n/messages/id/tours.json
  - frontend/src/i18n/messages/it/tours.json
  - frontend/src/i18n/messages/ja/tours.json
  - frontend/src/i18n/messages/ko/tours.json
  - frontend/src/i18n/messages/nl/tours.json
  - frontend/src/i18n/messages/pl/tours.json
---

## Decided
- The payroll deductions tour (release-1.20.0/payroll-deductions in frontend/src/lib/tours/definitions/release-1.20.0.ts) states the requirement in the welcome and anchors its first step on the Bills page's New Schedule button (billsNewButton): a rule needs a payroll scheduled bill, a deposit split into its gross line and one negative line per deduction.
- The tour is not gated on having such a bill. It says what is required instead, so a user without one still learns how to set it up. Offering is gated only on ownerView.
- The year-to-date and previous-periods buttons render only once a rule exists, so that step is an anchorless coach mark. The rules card (payrollRulesList) holds the spinner, the empty state or the list, so it is safe to anchor.
- The forecast anchor is a wrapper div around the ErrorBoundary on the Bills page, so CashFlowForecastChart's three return branches stay untouched.

## Watch out
- en is Canadian-flavoured ("paycheque"), and en-US has no taxes.json or tours.json override, so US readers also see "paycheque".
- tours.json settings.requires.ownerView still names only Rules and the AI review inbox.
