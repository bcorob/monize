---
title: "Warranty tracker plan: attachments generalisation and delegate section"
author: Ken
date: 2026-10-21
branch: feat/warranty-tracker
touches:
  - docs/future-plans/warranty-tracker.md
  - docs/future-plans/warranty-tracker-tasks.md
  - backend/src/attachments/attachments.service.ts
  - backend/src/delegation/delegation.service.ts
---

## Decided
- A warranty tracker (Warracker-inspired) is planned as docs/future-plans/warranty-tracker.md plus its tasks file, committed to main 2d9b4dff8. Ken chose the maximal options: generalise transaction_attachments to a second parent (nullable transaction_id + warranty_id + one-parent CHECK + document_kind), a shield badge and action-sheet items on the register, a new `warranties` delegate READ section, claims log, CSV in Warracker's column set, widget and read-only AI tool.
- Execution is on branch feat/warranty-tracker with subagents, two at a time, one commit per task; no tracker issue was filed (Ken said "execute directly").

## Tried and ruled out
- Linking a warranty only to a transaction's existing attachments (no schema change) was the cheap option; rejected by Ken because a warranty with no transaction would have no file store.
- A separate warranty_documents table: rejected, it duplicates the upload, preview, backup and sweeper path.

## Watch out
- The attachment_blobs RLS policy reads transaction_attachments.user_id directly, not the transaction, so generalising the parent does NOT touch the blob policy, the tombstone trigger, the orphan sweeper, the storage migrator or the backup transfer (all keyed by attachment id). Only the register count, has:attachment search, rule-facts attachment presence and the tool-prep cap are transaction-bound and must stay so.
- Tools-menu links are gated for delegates by CAPABILITY (payees/categories/tags), main-nav links by SECTION; a section-gated Tools link is new and needs a toolsSectionByHref map in AppHeader and MobileNavDrawer.
- Integration specs run against the dev postgres: monize_test role, password test_password, on docker network monize_finance-network with DATABASE_HOST=postgres; they rebuild monize_test so serialise them with flock.
- A new currency_code column must join both CURRENCY_REFERENCE_COLUMNS and the SQL function currency_codes_referenced_by_user (migration 137) or currency-references.spec.ts fails.
