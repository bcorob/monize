import { describe, it, expect } from 'vitest';
import { PUBLIC_CLIENT_NAMESPACES } from './client-messages';
import { PUBLIC_PATHS } from '@/lib/public-paths';

/**
 * Signed-out pages are rendered with only `PUBLIC_CLIENT_NAMESPACES`, so a
 * component they reach that reads any other namespace renders its raw keys on
 * the login screen. A list picked by hand rots the day a component gains a
 * lookup, so this walks the import graph from the root layout, the error and
 * not-found pages and every public route, and fails on any namespace that
 * graph reads and the list lacks.
 *
 * It over-approximates on purpose: an import is followed whether or not it
 * renders on a public page, so the list can be larger than strictly needed but
 * never smaller. A lookup whose namespace is not a literal (or a whole-catalog
 * read) cannot be checked, so reaching one fails as well.
 */

const sources = import.meta.glob('/src/**/*.{ts,tsx}', {
  query: '?raw',
  eager: true,
  import: 'default',
}) as Record<string, string>;

/** As `ui-conventions.test.ts`: prose naming a lookup must not count as one. */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '))
    .replace(
      /(^|[^:])\/\/[^\n]*/g,
      (match, before: string) => before + ' '.repeat(match.length - before.length),
    );
}

function resolveImport(from: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith('@/')) {
    base = `/src/${specifier.slice(2)}`;
  } else if (specifier.startsWith('.')) {
    const parts = from.split('/').slice(0, -1);
    for (const segment of specifier.split('/')) {
      if (segment === '..') parts.pop();
      else if (segment !== '.') parts.push(segment);
    }
    base = parts.join('/');
  } else {
    return null;
  }
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
  ]) {
    if (candidate in sources) return candidate;
  }
  return null;
}

const IMPORT = /(?:\bfrom|\bimport\(?)\s*['"]([^'"]+)['"]/g;
const LITERAL_LOOKUP =
  /\b(?:useTranslations|getTranslations)\(\s*(?:\{[^})]*?namespace:\s*)?['"]([\w-]+)/g;
const ANY_LOOKUP = /\b(?:useTranslations|getTranslations)\(([^)]*)\)?/g;
const WHOLE_CATALOG = /\b(?:useMessages|getMessages)\(\)/g;

interface Reach {
  namespaces: Map<string, string>;
  unchecked: string[];
}

function reachFrom(entries: string[]): Reach {
  const seen = new Set<string>();
  const namespaces = new Map<string, string>();
  const unchecked: string[] = [];
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file) || /\.test\.tsx?$/.test(file)) continue;
    seen.add(file);
    const code = withoutComments(sources[file]);
    for (const [, namespace] of code.matchAll(LITERAL_LOOKUP)) {
      if (!namespaces.has(namespace)) namespaces.set(namespace, file);
    }
    for (const [call, args] of code.matchAll(ANY_LOOKUP)) {
      if (!/^\s*(?:['"]|\{[^}]*namespace:\s*['"])/.test(args)) {
        unchecked.push(`${file}: ${call}`);
      }
    }
    // The root layout's own getMessages() is the call being scoped.
    if (file !== '/src/app/layout.tsx') {
      for (const [call] of code.matchAll(WHOLE_CATALOG)) {
        unchecked.push(`${file}: ${call}`);
      }
    }
    for (const [, specifier] of code.matchAll(IMPORT)) {
      const target = resolveImport(file, specifier);
      if (target) queue.push(target);
    }
  }
  return { namespaces, unchecked };
}

function publicEntries(): string[] {
  const routeFiles = Object.keys(sources).filter((path) =>
    PUBLIC_PATHS.some(
      (route) =>
        path.startsWith(`/src/app${route}/`) &&
        /\/(?:page|layout)\.tsx$/.test(path),
    ),
  );
  return [
    '/src/app/layout.tsx',
    '/src/app/error.tsx',
    '/src/app/not-found.tsx',
    ...routeFiles,
  ];
}

describe('public client catalog', () => {
  it('finds every public route on disk', () => {
    const entries = publicEntries();
    for (const route of PUBLIC_PATHS) {
      expect(
        entries.some((path) => path.startsWith(`/src/app${route}/`)),
        `no page found for public route ${route}`,
      ).toBe(true);
    }
  });

  it('covers every namespace the shell and the public pages read', () => {
    const { namespaces } = reachFrom(publicEntries());
    const allowed = new Set<string>(PUBLIC_CLIENT_NAMESPACES);
    const missing = [...namespaces.entries()]
      .filter(([namespace]) => !allowed.has(namespace))
      .map(([namespace, file]) => `${namespace} (read in ${file})`);
    expect(
      missing,
      'Add these to PUBLIC_CLIENT_NAMESPACES in src/i18n/client-messages.ts',
    ).toEqual([]);
  });

  it('reaches no lookup whose namespace it cannot read', () => {
    expect(reachFrom(publicEntries()).unchecked).toEqual([]);
  });

  it('still sees a lookup through a relative import', () => {
    // The walker is only as good as its resolver: prove it follows a path the
    // shell actually takes, so an empty result above is not a blind spot.
    const { namespaces } = reachFrom(['/src/app/login/page.tsx']);
    expect(namespaces.has('auth')).toBe(true);
  });
});
