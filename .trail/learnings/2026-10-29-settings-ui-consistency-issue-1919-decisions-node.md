---
title: "Settings UI consistency (issue 1919): decisions and rejected audit items"
author: Node
date: 2026-10-29
branch: claude/issue-1919
cost: { minutes: 31, tokens: 362834 }
touches:
  - frontend/src/components/settings/DelegateAccessModal.tsx
  - frontend/src/i18n/messages/de/settings.json
  - frontend/src/i18n/messages/en/settings.json
  - frontend/src/i18n/messages/es/settings.json
  - frontend/src/i18n/messages/fr/settings.json
  - frontend/src/i18n/messages/hi/settings.json
  - frontend/src/i18n/messages/id/settings.json
  - frontend/src/i18n/messages/it/settings.json
  - frontend/src/i18n/messages/ja/settings.json
  - frontend/src/i18n/messages/ko/settings.json
---

## Decided
- Settings sub-pages go back with `BackToSettingsLink` (components/settings/), a chevron link taking the page's own translated label; the main Settings page stays max-w-6xl (its sidebar plus a 4xl content column), and loading.tsx and the owner loading state take that frame. The delegate view stays 4xl.
- Dialog titles that the audit flagged (D2) became an in-body `h2 text-2xl font-bold`, as New Transaction does, instead of passing `title` to `Modal`: Modal still draws `title` as a small strip with an X (known debt), so passing it would contradict D2 until Modal is fixed.
- A dialog paragraph that is a one-time warning stayed (backup password setup, temporary password, regenerate backup codes); repeated instructions moved into an `InfoTooltip usePortal` beside the title.
- Revoke All trusted devices became a `ConfirmDialog`; AI provider delete and push device remove now ask first.

## Tried and ruled out
- D24 (AI cost rate currency Select): one billing currency governs two rate fields, and `CurrencyPickerButton` is account-scoped (its first row is "account currency"), so the Select stays.
- D25 on DelegateAccessModal grants and NotificationPreferencesMatrix: every switch already has visible text (the op name beside it, or the channel name and column header).
- D35 on DefaultViewsGroup alone: PreferencesSection's GROUP_HEADING_CLASS is text-base for its sibling groups; convert both together.

## Watch out
- Removing a catalog key means removing it from every locale's settings.json; rewrite with json.dumps(indent=2, ensure_ascii=False) and an OrderedDict, inserting new keys after their en sibling, or the diff reorders whole files.
- trail check flags Tailwind className edits against unrelated learnings by word overlap.
