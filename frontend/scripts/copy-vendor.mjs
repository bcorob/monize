#!/usr/bin/env node
/**
 * Vendor third-party browser assets into `public/` so they are served from our
 * own origin.
 *
 * Two things live here, for two different reasons:
 *
 * - OpenCV.js is not imported through the module graph (see the reasoning in
 *   `src/lib/document-scanner/opencv-engine.ts`), so the bundler never sees it
 *   and something has to put the file where the browser can fetch it.
 * - pdf.js IS bundled (`src/lib/attachment-preview/pdf-engine.ts` imports it
 *   behind a dynamic import), but it renders in a Web Worker it constructs
 *   itself from a URL, and the worker script must be the SAME version as the
 *   bundled API or pdf.js refuses to start. Copying it from the installed
 *   package at build time is what keeps the two in step; the engine pins the
 *   request to `pdfjs.version` with a query string so a stale HTTP-cached
 *   worker cannot answer for a newer API.
 *
 * Copied from `node_modules` at build time rather than committed, because they
 * are build artefacts of pinned dependencies (OpenCV alone is 13 MB). The
 * destination is gitignored.
 */
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const modules = join(root, "node_modules");
const vendor = join(root, "public", "vendor");

/**
 * `skipWhenSameSize` is an optimisation for the 13 MB OpenCV build, where a
 * rewrite on every `npm run dev` is worth avoiding. It is deliberately OFF for
 * the pdf.js worker: two releases of a minified worker can plausibly share a
 * byte count, and a same-size stale copy is exactly the version-mismatch
 * failure this script exists to prevent.
 */
const ENTRIES = [
  {
    label: "opencv.js",
    source: join(modules, "@techstark", "opencv-js", "dist", "opencv.js"),
    target: join(vendor, "opencv", "opencv.js"),
    skipWhenSameSize: true,
  },
  {
    label: "pdf.js worker",
    source: join(modules, "pdfjs-dist", "build", "pdf.worker.min.mjs"),
    target: join(vendor, "pdfjs", "pdf.worker.min.mjs"),
    skipWhenSameSize: false,
  },
  {
    // The base-14 fonts a PDF may reference without embedding. Without them
    // pdf.js warns on every such document and substitutes system fonts. The
    // CJK `cmaps/` directory (1.7 MB) is deliberately not copied; a PDF that
    // needs it still renders, with its CJK text missing, and is the recorded
    // follow-up.
    label: "pdf.js standard fonts",
    source: join(modules, "pdfjs-dist", "standard_fonts"),
    target: join(vendor, "pdfjs", "standard_fonts"),
    directory: true,
  },
];

for (const entry of ENTRIES) {
  if (!existsSync(entry.source)) {
    console.error(
      `[copy-vendor] ${entry.source} is missing. Run npm install before building.`,
    );
    process.exit(1);
  }

  if (entry.directory) {
    cpSync(entry.source, entry.target, { recursive: true });
    console.log(`[copy-vendor] copied ${entry.label} to ${entry.target}`);
    continue;
  }

  mkdirSync(dirname(entry.target), { recursive: true });
  if (
    entry.skipWhenSameSize &&
    existsSync(entry.target) &&
    statSync(entry.target).size === statSync(entry.source).size
  ) {
    console.log(`[copy-vendor] ${entry.label} is up to date`);
    continue;
  }
  copyFileSync(entry.source, entry.target);
  console.log(
    `[copy-vendor] copied ${entry.label} (${(statSync(entry.target).size / 1024 / 1024).toFixed(1)} MB) to ${entry.target}`,
  );
}
