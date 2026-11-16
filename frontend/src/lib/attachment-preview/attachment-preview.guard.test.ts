import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { describe, expect, it } from 'vitest';
import { blankComments } from '@/test/blank-comments';

const SRC_ROOT = join(__dirname, '..', '..');

/** The one module allowed to name the pdf.js package or its vendored files. */
const ENGINE_OWNER = 'lib/attachment-preview/pdf-engine.ts';

/** The one module allowed to load the engine, and only dynamically. */
const LOADER = 'components/transactions/PdfPages.tsx';

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === '.next') continue;
      out.push(...sourceFiles(full));
      continue;
    }
    if (!/\.(ts|tsx)$/.test(entry)) continue;
    if (/\.(test|spec)\.tsx?$/.test(entry)) continue;
    out.push(full);
  }
  return out;
}

const files = sourceFiles(SRC_ROOT).map((file) => ({
  rel: relative(SRC_ROOT, file).split('\\').join('/'),
  code: blankComments(readFileSync(file, 'utf8')),
}));

/** A value import of the engine module: `import ... from '.../pdf-engine'`, but not `import type`. */
const STATIC_ENGINE_IMPORT =
  /\bimport\s+(?!type\b)[^;]*?\bfrom\s+['"][^'"]*attachment-preview\/pdf-engine['"]/;
/** The dynamic form, which is the only one allowed. */
const DYNAMIC_ENGINE_IMPORT =
  /\bimport\s*\(\s*['"][^'"]*attachment-preview\/pdf-engine['"]\s*\)/;

/**
 * pdf.js is a separate chunk plus a vendored worker, and where it is
 * referenced decides what every page costs: a static import from a component
 * lands it in a shared chunk and every visitor pays for a PDF renderer they
 * never opened. The engine module also touches browser globals at load, so a
 * static path from anything a server render reaches is a crash, not a cost.
 */
describe('pdf.js is reached from one place, dynamically', () => {
  it('finds source files to scan', () => {
    expect(files.length).toBeGreaterThan(200);
  });

  it('names the pdfjs-dist package nowhere but the engine module', () => {
    const offenders = files
      .filter(({ rel, code }) => rel !== ENGINE_OWNER && code.includes('pdfjs-dist'))
      .map(({ rel }) => rel);
    expect(offenders).toEqual([]);
  });

  it('names the vendored pdf.js URL nowhere but the engine module', () => {
    const offenders = files
      .filter(({ rel, code }) => rel !== ENGINE_OWNER && code.includes('/vendor/pdfjs/'))
      .map(({ rel }) => rel);
    expect(offenders).toEqual([]);
  });

  it('has no static value import of the engine anywhere', () => {
    const offenders = files
      .filter(({ code }) => STATIC_ENGINE_IMPORT.test(code))
      .map(({ rel }) => rel);
    expect(offenders).toEqual([]);
  });

  it('loads the engine dynamically from exactly one component', () => {
    const loaders = files
      .filter(({ code }) => DYNAMIC_ENGINE_IMPORT.test(code))
      .map(({ rel }) => rel);
    expect(loaders).toEqual([LOADER]);
  });

  it('still finds the engine, so the rules cannot pass by accident', () => {
    const engine = files.find(({ rel }) => rel === ENGINE_OWNER);
    expect(engine).toBeDefined();
    expect(engine!.code).toContain('pdfjs-dist');
    expect(engine!.code).toContain('/vendor/pdfjs/');
  });

  describe('the scan itself', () => {
    it('catches a static import and ignores a type import', () => {
      expect(
        STATIC_ENGINE_IMPORT.test(
          "import { openPdf } from '@/lib/attachment-preview/pdf-engine';",
        ),
      ).toBe(true);
      expect(
        STATIC_ENGINE_IMPORT.test(
          "import type { PdfHandle } from '@/lib/attachment-preview/pdf-engine';",
        ),
      ).toBe(false);
      expect(
        DYNAMIC_ENGINE_IMPORT.test(
          "const { openPdf } = await import('@/lib/attachment-preview/pdf-engine');",
        ),
      ).toBe(true);
    });

    it('ignores a reference in a comment', () => {
      expect(
        blankComments("// never import 'pdfjs-dist' here").includes('pdfjs-dist'),
      ).toBe(false);
    });
  });
});
