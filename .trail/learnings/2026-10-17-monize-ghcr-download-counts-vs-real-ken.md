---
title: Monize GHCR download counts vs real usage
author: Ken
date: 2026-10-17
branch: main
---

## Decided
- The ~4.5K "downloads" on the Monize repo page are GHCR image pulls (monize-backend / monize-frontend, ~4.5K each for 1.18.0 over 5 days), not installs. Releases have no assets, so there are no release download counts.
- Pulls per day, backend: <=1.12.0 ~10-20; 1.12.1-1.16.0 (mid-Jul to mid-Sep) ~45-125; 1.17.0 ~410; 1.18.0 ~900 (Oct 2026).
- The July jump matches a real star spike (95 stars in July). The late-Sep onward surge does not: stars ~1-2/week, outside issues/discussions flat. Treat it as automated pulls (crash-looping k8s pod with pullPolicy Always, update poller, mirror, or someone's CI).

## Tried and ruled out
- Own clusters: home pulls via a private local registry, not GHCR. Cloud pulls ghcr.io with pullPolicy Always, but runs 1 backend + 1 frontend pod with 0 restarts.
- CI: the ci.yml build-and-push job pulls only a few times per release (cosign, syft SBOM, trivy). zap.yml builds images locally.

## Watch out
- GHCR exposes no per-client pull data, so the source can't be identified from GitHub.
- Get counts by scraping the public pages github.com/users/kenlasko/packages/container/package/<pkg> and .../versions?filters[version_type]=tagged. The gh token lacks read:packages, so the API returns 403.
- Near-identical backend/frontend counts mean whatever is pulling grabs both images together (a compose or helm stack).
