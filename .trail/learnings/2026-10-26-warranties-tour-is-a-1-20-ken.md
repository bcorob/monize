---
title: "Warranties tour is a 1.20 release tour; What's New will not offer it until the version bump"
author: Ken
date: 2026-10-26
branch: feat/warranties-tour
id: l-45507b49
scope: repo
status: active
src: agent
touches:
  - frontend/src/lib/tours/definitions/release-1.20.0.ts
  - package.json
---

## Decided
- The warranties tour (frontend/src/lib/tours/definitions/release-1.20.0.ts, id release-1.20.0/warranties) is versioned '1.20': the warranty tracker merged after the v1.19.0 tag, so it ships in 1.20. getReleaseTours matches major.minor, so What's New offers it only once package.json says 1.20.x; until then it is reachable from Settings > Tours only.
- Owner-only (requiresData: 'ownerView'): a delegate sees the Warranties page read-only and no Warranties line in the transaction form.
- The register's Add warranty (row Copy menu) is described in an anchorless bottom-left coach mark, not anchored: a per-row anchor breaks anchors.uniqueness.test.ts.
- The New Transaction Warranties line step has fallbackWhenMissing: TransactionForm hides the line for a joint account.

## Watch out
- tours.json settings.requires.ownerView names Rules and the AI review inbox specifically, but email-receipts and warranties share that requirement, so the message is wrong for them. Not changed here.
- `git stash` refuses to run with intent-to-add (git add -N) files in the tree. Commit or unstage them first.
