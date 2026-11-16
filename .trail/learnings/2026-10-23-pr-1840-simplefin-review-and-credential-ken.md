---
title: PR 1840 SimpleFIN review and credential encryption
author: Ken
date: 2026-10-23
branch: feat/warranties-line-polish
---

## Decided
- PR #1840 (feat(bank-sync): SimpleFIN) review: 10 findings reported. The main ones: per-window quota reservations make long backfills impossible, discovery re-activates 'revoked' connections, a currency-change review clears itself on the next discovery, autoSync is never restored, and the setup-token "attempted" marker is written before claim, so local failures burn the token.
- Credential encryption is sound and needs no finding. Only the SimpleFIN access URL is stored, in bank_sync_credentials.access_url_enc, via the shared EncryptionService (AES-256-GCM, scrypt with a per-value random salt, format salt:iv:tag:ct). It is decrypted only in BankSyncCredentialsService.resolveCredentials. The setup token is stored only as a SHA-256 marker in job_claims. A CHECK constraint makes each row one credential type, and the tables are excluded from backup.

## Tried and ruled out
- `git fetch origin feat/simplefin-bank-sync` fails because the branch is not on origin. Use `git fetch origin pull/1840/head:refs/remotes/pr/1840` and read files with `git show pr/1840:<path>`; the local checkout was on another branch.

## Watch out
- These limits apply to every encrypted column, not just this PR: EncryptionService uses ENCRYPTION_KEY directly (derivePurposeKey exists but isn't applied), and the GCM ciphertext has no AAD binding it to its user or provider. Don't re-raise them as PR-specific findings.
- ReportFindings short_summary has a 60-character limit.
