---
title: The npm audit gate reads the installed tree; nodemailer only moves through mailparser
author: Ken
date: 2026-10-24
branch: feat/mny-classification-tags
id: l-6c0d6c46
scope: repo
status: active
src: agent
touches:
  - scripts/npm-audit-gate.mjs
  - backend/package.json
---

## Decided
- The NPM Audit gate (`scripts/npm-audit-gate.mjs`) audits the installed tree, so a lockfile-only bump is checked with `npm audit --omit=dev --package-lock-only --json` in `backend/`; the gate over a stale `node_modules` still reports the old versions.
- nodemailer is pinned exactly by mailparser (`"nodemailer": "10.1.0"` in the lock), so `npm update nodemailer` alone does nothing: bump `mailparser` too. multer is pinned exactly by `@nestjs/platform-express` and already has an override (`"multer": "^2.2.0"` in `backend/package.json`), so `npm update multer` moves it.

## Watch out
- Advisories for body-parser, multer, nodemailer, undici and ip-address were all published 2026-10-23 ~21:00-22:15 UTC; a branch green at noon failed the gate that night with no lockfile change of its own. Check `gh api advisories?affects=<pkg>@<version>` before assuming a PR introduced an audit failure.
