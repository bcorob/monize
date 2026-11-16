---
title: A local frontend build makes public-scripts.guard.test.ts fail until public/vendor is removed
author: Ken
date: 2026-10-26
branch: feat/warranties-tour
id: l-b4a479d0
scope: repo
status: active
src: agent
touches:
  - frontend/src/test/public-scripts.guard.test.ts
---

## Watch out
- `npm run build` in frontend/ copies opencv.js and pdf.worker.min.mjs into the git-ignored frontend/public/vendor/. frontend/src/test/public-scripts.guard.test.ts walks public/ on disk, so any test run after a local build fails with "expected [ 'sw.js', ...(2) ] to deeply equal [ 'sw.js' ]". That is build output, not a regression: run test:changed before the build, or delete public/vendor/ first. CI is not affected because it builds and tests in separate jobs.

## Tried and ruled out
- Reading this failure as caused by the change under test. It reproduced on a branch that only touched tours and i18n.
