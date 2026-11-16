import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import vm from 'node:vm';
import { safeNotificationTarget } from './notification-target';

/**
 * A notification's `target` is a claim about two things nothing else checks: the
 * app's route tree, and the rule that decides whether a target may be followed.
 *
 * Both have already been wrong. A BILL_DUE notification shipped with
 * `/scheduled-transactions/<id>`, which is not a route -- and because a stored
 * target WINS over the client's type table, the fix for "the bell should know
 * where to go" replaced a working destination with the not-found page. And the
 * rule itself exists twice: the service worker resolves a push payload's target
 * against the origin, while the app checks a stored one before `router.push`.
 * The worker is a classic script that cannot import app code, so the duplication
 * is forced by the platform -- what is not forced is the two answers drifting.
 */

const APP_DIR = resolve(__dirname, '../app');

/** The origin the worker sandbox runs on, so both rules resolve against one. */
const WORKER_ORIGIN = 'https://monize.test';
const BACKEND_SRC = resolve(__dirname, '../../../backend/src');

// ---------------------------------------------------------------------------
// Every target a producer writes must resolve to a route
// ---------------------------------------------------------------------------

/** A backend file's contents with comments blanked, so prose cannot declare a target. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
}

function backendFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return backendFiles(path);
    if (!path.endsWith('.ts') || path.endsWith('.spec.ts')) return [];
    return [path];
  });
}

/**
 * The object literal enclosing `index`, found by walking out to the nearest
 * unmatched `{` and back in to its `}`.
 *
 * Scanning for `target:` alone is not an option: `target` is an ordinary word in
 * this codebase (class-validator's `target: object.constructor`, the GEM
 * strategy's composition target), so the anchor has to be the thing that makes a
 * literal a notification -- its `type: NotificationType.X`.
 */
function enclosingObject(source: string, index: number): string {
  let depth = 0;
  let start = index;
  while (start > 0) {
    const char = source[start];
    if (char === '}') depth += 1;
    else if (char === '{') {
      if (depth === 0) break;
      depth -= 1;
    }
    start -= 1;
  }
  depth = 0;
  let end = start;
  while (end < source.length) {
    const char = source[end];
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
    end += 1;
  }
  return source.slice(start, end + 1);
}

interface ProducedTarget {
  file: string;
  /** The route pattern, with each `${...}` collapsed to one dynamic segment. */
  target: string | null;
  /** The raw text when it is not a string literal, so the report can name it. */
  unverifiable?: string;
}

/**
 * Every notification a backend producer builds, with the target it asks for.
 *
 * A target that is not a string literal is reported rather than skipped: the
 * route claim is then unverifiable from here, and silently passing it would let
 * the next invented route through the way the first one got through.
 */
function producedTargets(): ProducedTarget[] {
  const found: ProducedTarget[] = [];
  for (const file of backendFiles(BACKEND_SRC)) {
    const source = stripComments(readFileSync(file, 'utf8'));
    for (const marker of source.matchAll(/type:\s*NotificationType\.[A-Z_]+/g)) {
      const literal = enclosingObject(source, marker.index ?? 0);
      const target = /(?:^|[\s,{])target:\s*([^\n]*)/.exec(literal);
      if (!target) continue;
      const value = target[1].trim().replace(/,$/, '');
      const quoted = /^(?:`([^`]*)`|"([^"]*)"|'([^']*)')$/.exec(value);
      if (!quoted) {
        found.push({
          file: file.slice(BACKEND_SRC.length + 1),
          target: null,
          unverifiable: value.slice(0, 80),
        });
        continue;
      }
      const path = quoted[1] ?? quoted[2] ?? quoted[3];
      found.push({
        file: file.slice(BACKEND_SRC.length + 1),
        target: path.replace(/\$\{[^}]*\}/g, ':param'),
      });
    }
  }
  return found;
}

/**
 * Whether a path pattern resolves to a page in the App Router, matching a
 * literal segment to a directory of that name and `:param` to a `[...]` one.
 */
function routeExists(pattern: string): boolean {
  const segments = pattern.split('?')[0].split('#')[0].split('/').filter(Boolean);
  let dir = APP_DIR;
  for (const segment of segments) {
    if (!existsSync(dir)) return false;
    const entries = readdirSync(dir).filter((entry) =>
      statSync(join(dir, entry)).isDirectory(),
    );
    const match =
      segment === ':param'
        ? entries.find((entry) => entry.startsWith('['))
        : entries.find((entry) => entry === segment);
    if (!match) return false;
    dir = join(dir, match);
  }
  return existsSync(join(dir, 'page.tsx'));
}

describe('every notification target resolves to a route', () => {
  const targets = producedTargets();

  it('finds the targets it is meant to check', () => {
    // A regex that stops matching, or a producer that stops writing targets,
    // would otherwise make the assertion below trivially true.
    expect(targets.length).toBeGreaterThan(0);
  });

  it('recognises the app router tree it checks against', () => {
    expect(routeExists('/bills')).toBe(true);
    expect(routeExists('/budgets/:param')).toBe(true);
    expect(routeExists('/scheduled-transactions/:param')).toBe(false);
  });

  it('resolves every produced target', () => {
    const broken = targets
      .filter(({ target }) => target !== null && !routeExists(target))
      .map(({ file, target }) => `${file}: ${target}`);
    expect(broken).toEqual([]);
  });

  it('leaves no target it cannot check', () => {
    // A target built from a variable is a route claim this test cannot read, and
    // skipping it quietly is how the first invented route reached production.
    // Inline it, or state the reason here.
    const unverifiable = targets
      .filter((entry) => entry.unverifiable !== undefined)
      .map(({ file, unverifiable }) => `${file}: ${unverifiable}`);
    expect(unverifiable).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The worker's rule and the app's rule agree on what may be followed
// ---------------------------------------------------------------------------

/**
 * `safeNotificationPath` out of the worker, evaluated the way the browser runs
 * it: a classic script in a sandbox, whose top-level function declarations land
 * on the contextified global.
 */
function loadWorkerRule(): (value: unknown) => string {
  const source = readFileSync(resolve(__dirname, '../../public/sw.js'), 'utf8');
  const sandbox: Record<string, unknown> = {
    self: {
      addEventListener: () => {},
      skipWaiting: () => {},
      location: { origin: WORKER_ORIGIN },
      registration: { showNotification: async () => {}, pushManager: {} },
      clients: { claim: () => {}, matchAll: async () => [], openWindow: async () => {} },
    },
    caches: { open: async () => ({}), match: async () => undefined, keys: async () => [] },
    fetch: async () => ({}),
    console: { log: () => {}, warn: () => {}, error: () => {} },
    // A vm context has its own globals and does NOT inherit the host's, so the
    // worker's `new URL(...)` throws `URL is not defined` and its catch answers
    // `/` for every input -- a harness that agrees with nothing while looking
    // like it agrees with everything.
    URL,
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(source, context);
  const rule = sandbox.safeNotificationPath;
  if (typeof rule !== 'function') {
    throw new Error(
      'safeNotificationPath was not found on the worker global -- this guard has lost its subject',
    );
  }
  return rule as (value: unknown) => string;
}

/**
 * The verdicts that must match. The worker answers `/` for a refusal and a
 * normalised path for an acceptance; the app answers `null` and the value.
 * Comparing the verdict rather than the string is what makes them comparable at
 * all -- and what the two must never disagree about, because one notification
 * is reachable through both surfaces.
 */
const SHARED_CASES: readonly { name: string; value: string; follow: boolean }[] = [
  { name: 'a plain path', value: '/budgets/b-1', follow: true },
  { name: 'a path with a query and hash', value: '/bills?due=today#top', follow: true },
  { name: 'the root', value: '/', follow: true },
  { name: 'protocol-relative', value: '//evil.example/steal', follow: false },
  { name: 'backslash protocol-relative', value: '/\\evil.example/steal', follow: false },
  // The four the app got wrong while the worker got them right: one slash, no
  // backslash, and the URL parser strips the whitespace and reads
  // `//evil.example`. A prefix test cannot see that.
  { name: 'tab then protocol-relative', value: '/\t/evil.example/steal', follow: false },
  { name: 'newline then protocol-relative', value: '/\n/evil.example/steal', follow: false },
  { name: 'return then protocol-relative', value: '/\r/evil.example/steal', follow: false },
  { name: 'tab then backslash', value: '/\t\\evil.example/steal', follow: false },
  { name: 'an absolute https URL', value: 'https://evil.example/steal', follow: false },
  { name: 'a scheme', value: 'javascript:alert(1)', follow: false },
  { name: 'a relative path', value: 'budgets/b-1', follow: false },
  { name: 'empty', value: '', follow: false },
];

describe('the worker and the app agree on what may be followed', () => {
  const workerRule = loadWorkerRule();

  it('loads a working rule, not one that refuses everything', () => {
    // A vm context has its own globals: without `URL` in the sandbox the
    // worker's catch answers `/` for every input, and every agreement
    // assertion below would pass for the wrong reason.
    expect(workerRule('/budgets/b-1')).toBe('/budgets/b-1');
    expect(workerRule('//evil.example')).toBe('/');
  });

  it.each(SHARED_CASES)('$name', ({ value, follow }) => {
    expect(safeNotificationTarget(value, WORKER_ORIGIN) !== null).toBe(follow);
    expect(workerRule(value) !== '/' || value === '/').toBe(follow);
  });

  /**
   * The one place they still differ, pinned so a change to either side has to
   * come here and say so.
   *
   * The worker refuses a target over 512 characters; the app has no cap. That is
   * unreachable for a STORED target -- the write door caps the column at 255 --
   * and reachable for a PUSH PAYLOAD, which the worker receives from an external
   * service and the app never sees. The stricter side is the exposed one.
   *
   * There used to be a second difference, and it was not a difference of
   * strictness: the app pattern-matched the prefix and the worker resolved, so
   * `/<tab>/evil.example` was refused by the worker and FOLLOWED by the app. The
   * shared table above is where that now lives.
   */
  it('differs only on the payload-only length cap', () => {
    const tooLong = `/${'a'.repeat(600)}`;
    expect(workerRule(tooLong)).toBe('/');
    expect(safeNotificationTarget(tooLong, WORKER_ORIGIN)).toBe(tooLong);
  });

  it('normalises an accepted target to the same path on both sides', () => {
    // One notification is reachable through both surfaces, so agreeing on
    // "followable" is not enough -- they have to land on the same page.
    for (const value of ['/budgets/b-1', '/bills?due=today#top', '/']) {
      expect(safeNotificationTarget(value, WORKER_ORIGIN)).toBe(
        workerRule(value),
      );
    }
  });
});
