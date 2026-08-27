import { describe, it, expect } from 'vitest';

/**
 * Guard tests for the testing conventions in `frontend/CLAUDE.md`.
 *
 * Sibling of `ui-conventions.test.ts`, for mistakes in the *tests* rather than
 * in the components. Each one here produced act warnings that a green suite
 * happily printed and nobody read, so the rule needs a failing test rather than
 * a paragraph.
 */
const sources = import.meta.glob('/src/**/*.{test,spec}.{ts,tsx}', {
  query: '?raw',
  eager: true,
  import: 'default',
}) as Record<string, string>;

/** The body of every `afterEach(...)` callback in a file, braces balanced. */
function afterEachBodies(content: string): string[] {
  const bodies: string[] = [];
  const opener = /afterEach\(\s*(?:async\s*)?\(\s*\)\s*=>\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = opener.exec(content)) !== null) {
    const start = content.indexOf('{', match.index);
    let depth = 0;
    for (let i = start; i < content.length; i += 1) {
      if (content[i] === '{') depth += 1;
      else if (content[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          bodies.push(content.slice(start, i + 1));
          break;
        }
      }
    }
  }
  return bodies;
}

describe('a shared store is reset only after the tree is unmounted', () => {
  /**
   * Testing Library registers its `cleanup` at import time, and vitest runs
   * after-hooks in reverse registration order -- so a file's own `afterEach`
   * runs *first*, while the component it rendered is still mounted and still
   * subscribed. Writing to a Zustand store there re-renders that component
   * outside act, once per selector it reads through. `SecurityDetailHeader`
   * produced three such warnings in every one of its tests for exactly this.
   *
   * Call `cleanup()` at the top of the hook. A second cleanup afterwards is a
   * no-op, so this costs nothing where the hazard does not apply.
   */
  it('has no afterEach that writes a store before calling cleanup()', () => {
    const offenders = Object.entries(sources)
      .filter(([, content]) =>
        afterEachBodies(content).some(
          (body) => /\w+\.setState\(/.test(body) && !body.includes('cleanup('),
        ),
      )
      .map(([path]) => path);

    expect(offenders).toEqual([]);
  });
});

describe('a mocked selector hook applies its selector', () => {
  /**
   * `usePreferencesStore` and its siblings are Zustand hooks: called with a
   * selector, they return that selector applied to the state. A mock written as
   * `usePreferencesStore: () => ({ preferences: { ... } })` returns the whole
   * state whatever it is asked for -- so `usePreferencesStore((s) => s.preferences)`
   * receives `{ preferences: ... }`, one level too deep, and every read off it is
   * `undefined`.
   *
   * That is worse than a failing test: the component silently takes its
   * no-preferences branch while the fixture claims to have set a preference, so
   * the case pins the opposite of what it says. `FavouriteAccounts.test.tsx`
   * asserted balances under `defaultCurrency: "CAD"` and had been running on the
   * fallback since it was written; it only surfaced when the fallback's VALUE
   * changed, and then as four failures in a file nothing had touched.
   *
   * `frontend/CLAUDE.md`: a mock must return what the real collaborator returns.
   */
  const SELECTOR_STORES = [
    'usePreferencesStore',
    'useAuthStore',
    'useDemoStore',
    'useDensityPreference',
  ];

  it('has no store mock that ignores the selector it is handed', () => {
    const offenders: string[] = [];
    for (const [path, content] of Object.entries(sources)) {
      for (const store of SELECTOR_STORES) {
        // The mock's own factory: `<store>: <arrow or fn>` inside a vi.mock.
        const declaration = new RegExp(
          `${store}:\\s*(\\(([^)]*)\\)|[A-Za-z_$][\\w$]*)\\s*=>`,
          'g',
        );
        let match: RegExpExecArray | null;
        while ((match = declaration.exec(content)) !== null) {
          const params = match[2] ?? match[1];
          // A zero-argument mock cannot apply a selector. `vi.fn()` is fine --
          // those files set a return value per case and are not claiming to
          // model the store's shape.
          if (params.trim() === '') offenders.push(`${path} (${store})`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
