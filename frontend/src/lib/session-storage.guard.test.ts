import { describe, it, expect } from 'vitest';

/**
 * Guard test for INV-SHARE-003 on browser sessionStorage.
 *
 * sessionStorage survives a reload, which is exactly what a delegate context
 * switch does, and it survives a sign-out followed by another user's sign-in
 * on the same tab. An entry that carries one identity's data (a portfolio
 * series, a remembered entry date or currency) is therefore drawn to the next
 * identity unless it is keyed by identity or cleared at both moments.
 *
 * This scans every non-test source file that writes sessionStorage and holds it
 * against the map below. A new writer is a new line here, which is the moment
 * to say whether its value belongs to an identity. An identity-scoped writer is
 * cleared by `clearIdentityScopedSessionStorage` (`lib/identity-session-storage.ts`),
 * which `logout()` and the delegate context switch both call.
 */
const SESSION_STORAGE_WRITERS: Record<string, string> = {
  'src/components/investments/portfolio-chart-utils.tsx':
    'identity-scoped: the key carries the user id and acting context, and clearIdentityScopedSessionStorage clears it on logout and context switch.',
  'src/lib/identity-session-storage.ts':
    'identity-scoped: this is the clearing helper itself; it only removes entries.',
  'src/lib/lastTransactionDate.ts':
    'identity-scoped: remembers an entry date; cleared by clearIdentityScopedSessionStorage on logout and context switch.',
  'src/lib/lastTransactionCurrency.ts':
    'identity-scoped: remembers an entry currency; cleared by clearIdentityScopedSessionStorage on logout and context switch.',
  'src/lib/logout-state.ts':
    'identity-neutral: a sign-out-in-progress marker, no account data.',
  'src/lib/pre-login-locale.ts':
    'identity-neutral: the locale chosen before login, consumed once.',
  'src/lib/stepUpToken.ts':
    'identity-neutral: a step-up purpose sentinel, a return path and a one-time re-auth artifact removed when read; no account data.',
  'src/store/whatsNewStore.ts':
    'identity-neutral: a one-shot "login just happened" flag.',
  'src/app/login/page.tsx':
    'identity-neutral: the post-login return path.',
  'src/hooks/useSwipeNavigation.ts':
    'identity-neutral: the swipe direction of the next page transition.',
  'src/components/layout/WeakJwtSecretBanner.tsx':
    'identity-neutral: a dismissal flag for a server-wide notice.',
};

const sources = import.meta.glob('/src/**/*.{ts,tsx}', {
  query: '?raw',
  eager: true,
  import: 'default',
}) as Record<string, string>;

// `sessionStorage.setItem`, `window.sessionStorage.setItem`, and an alias
// (`const ss = window.sessionStorage`) through which a write could be made.
const WRITE_FORMS = [
  /\bsessionStorage\s*\.\s*setItem\s*\(/,
  /\bsessionStorage\s*\[\s*['"`][^'"`]+['"`]\s*\]\s*=[^=]/,
  /[=:]\s*(?:window\s*\.\s*|globalThis\s*\.\s*)?sessionStorage\s*[;,)\n]/,
];

function isTestFile(path: string): boolean {
  return (
    /\.(test|spec)\.tsx?$/.test(path) ||
    path.startsWith('/src/test/') ||
    path.endsWith('.d.ts')
  );
}

function writerFiles(): string[] {
  return Object.entries(sources)
    .filter(([path]) => !isTestFile(path))
    .filter(([, source]) => WRITE_FORMS.some((re) => re.test(source)))
    .map(([path]) => path.slice(1))
    .sort();
}

describe('sessionStorage writers (INV-SHARE-003)', () => {
  it('finds the writers the map names, so the scan is not blind', () => {
    expect(writerFiles().length).toBeGreaterThan(5);
  });

  it('has a classification for every file that writes sessionStorage', () => {
    const unclassified = writerFiles().filter(
      (file) => !(file in SESSION_STORAGE_WRITERS),
    );
    expect(
      unclassified,
      `${unclassified.join(', ')} writes sessionStorage with no entry in SESSION_STORAGE_WRITERS. ` +
        'sessionStorage survives a reload and a sign-out/sign-in on the same tab. If the value ' +
        'carries one account\'s data, key it by identity and clear it in ' +
        'clearIdentityScopedSessionStorage (lib/identity-session-storage.ts), then add the file as ' +
        '"identity-scoped: ..."; if it is a UI flag, a path or a locale, add it as "identity-neutral: ...".',
    ).toEqual([]);
  });

  it('lists no file that no longer writes sessionStorage', () => {
    const writers = new Set(writerFiles());
    const stale = Object.keys(SESSION_STORAGE_WRITERS).filter(
      (file) => !writers.has(file),
    );
    expect(
      stale,
      `${stale.join(', ')} is in SESSION_STORAGE_WRITERS but no longer writes sessionStorage; remove the line.`,
    ).toEqual([]);
  });

  it('states a classification for every entry', () => {
    for (const [file, reason] of Object.entries(SESSION_STORAGE_WRITERS)) {
      expect(reason, file).toMatch(/^identity-(neutral|scoped): \S/);
    }
  });
});
