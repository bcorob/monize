---
title: "Other-screens UI consistency (issue 1917): decisions and rejected audit items"
author: Node
date: 2026-10-29
branch: claude/issue-1917
cost: { minutes: 28, tokens: 453002 }
touches:
  - frontend/src/i18n/messages/de/dashboard.json
  - frontend/src/i18n/messages/de/import.json
  - frontend/src/i18n/messages/de/insights.json
  - frontend/src/i18n/messages/de/notifications.json
  - frontend/src/i18n/messages/de/strategies.json
  - frontend/src/i18n/messages/de/taxes.json
  - frontend/src/i18n/messages/es/dashboard.json
  - frontend/src/i18n/messages/es/import.json
  - frontend/src/i18n/messages/es/insights.json
  - frontend/src/i18n/messages/es/notifications.json
---

## Decided
- Dialog title items (D2) are fixed with Modal `title` (+ `description` for the explanation) and `className="p-6"`, never a restyled in-body h2; header/footer `border-b`/`border-t` strips go with it. What's New dropped its corner X for a Close button in the footer row (beside Show at next login / Don't show again).
- One-time paragraphs stay: the Money wipe dialog's list of what is deleted, and the Reset Password result naming whose temporary password it is.
- Admin user table (D19): SortableTh with aria-sort, sort persisted as `monize-admin-users-sort-field/-dir`, density view `adminUsers` added to `DensityView`/`DENSITY_VIEWS`, phone card at `isMobile && density === 'normal'` with a slim sort header. Default sort is now name, ties by creation date.
- Insights: InsightsList now renders the PageHeader so Refresh (outline Button + "(3 hours ago)") is a header action; type/severity filter on the client (server caps the list at MAX_INSIGHTS_PER_USER), so severity segments carry counts.
- A free-form `<dl>` readout on a detail/settings card (push identity) became `KeyValueList`, not SummaryCards (those are a list page's summary row).
- A title-only warning icon (Upcoming Bills below-zero) became a named icon (`role="img"` + `aria-label` + `aria-hidden={false}`) plus a visible legend line.

## Tried and ruled out
- D16 on /taxes: no wiki page covers the tax tools; a help link to a page that does not describe the feature is worse than none. Reminders links Settings-and-Security#notifications.
- Removing the remaining `focus:ring` / row-hover baseline lines for UserManagementTable, WidgetCard, CustomizeDashboardModal: still offend those guards; only the modal-title, divide and pill baselines shrank.

## Watch out
- Heroicons components set `aria-hidden="true"` by default; an icon that must be announced needs `aria-hidden={false}` with its `role="img"` and `aria-label`, or getByRole('img') will not find it.
- Removing baseline lines with a path-wide sed hits every baseline in ui-conventions.test.ts that lists the file; edit inside the one describe block.
- Adding `{count}` to an en value means adding it to every locale in the same PR or the parity test fails.
