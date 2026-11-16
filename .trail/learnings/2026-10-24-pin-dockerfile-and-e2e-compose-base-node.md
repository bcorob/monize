---
title: "Pin Dockerfile and e2e-compose base images by digest (issue #1837)"
author: Node
date: 2026-10-24
branch: claude/issue-1837
cost: { minutes: 16, tokens: 177005 }
touches:
  - backend/Dockerfile
  - backend/src/common/ci-images.guard.spec.ts
  - backend/src/common/image-digest-pin.guard.spec.ts
  - backend/src/common/image-ref.util.ts
  - docker-compose.e2e.yml
  - docs/container-images.md
  - docs/verification-contract.md
  - frontend/Dockerfile
  - docker-compose.ha.yml
  - ".github/workflows/ci.yml"
---

## Decided
- Scope narrowed to exactly what docs/container-images.md's "Not yet pinned" section already listed, minus the project's own user-facing files: backend/Dockerfile, frontend/Dockerfile, and docker-compose.e2e.yml only. Ken's comment on the issue excluded docker-compose.dev.yml/prod.yml and the Helm chart; docker-compose.ha.yml was treated the same way (grouped with dev/prod in the doc's own "project's own images, decide separately" bucket).
- Reused the existing pinned postgres:16-alpine digest (sha256:16bc17c6...) already in .github/workflows/ci.yml and scripts/verify-schema.sh for docker-compose.e2e.yml's postgres service, instead of fetching a fresh digest, so all three postgres consumers test the same image content.
- Fetched fresh index digests for node:24-alpine, node:24-slim and nginx:1.29-alpine directly from mirror.gcr.io's registry API (curl -I with the OCI/docker manifest-list Accept header against https://mirror.gcr.io/v2/library/<name>/manifests/<tag>, reading the `docker-content-digest` response header) since this is their first pin, not a move of an existing one, so the dependabot "wait a week" cooldown rule doesn't apply.
- New guard backend/src/common/image-digest-pin.guard.spec.ts checks both directions: every mirror.gcr.io/mcr.microsoft.com reference in a Dockerfile/docker-compose.e2e.yml/workflow/script must carry @sha256:, and every digest in docs/container-images.md's "Pinned images" table must actually be used by some scanned file (catches a stale doc row), separate from the existing ci-images.guard.spec.ts which only checks the registry allowlist (not digest presence).
- Refactored the line-extraction logic shared by both guards into backend/src/common/image-ref.util.ts (extractImageRefs) rather than having image-digest-pin.guard.spec.ts import from ci-images.guard.spec.ts -- importing one .spec.ts from another would re-execute its top-level `describe` blocks, registering duplicate tests.
- ghcr.io/kenlasko/* references (this project's own published images) are deliberately exempt from the digest-pin requirement; only mirror.gcr.io and mcr.microsoft.com are covered, matching the issue's item 5 (project's own images are a separate decision).

## Watch out
- `trail check` flagged 6 "conflicts" on this file against totally unrelated learnings (git fetch failures, a stale Next.js version, tag-row construction sites) -- these were spurious line-number/keyword matches, not real conflicts with this change.
