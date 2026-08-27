import { describe, it, expect } from 'vitest';

// The report switcher lifts starred reports into a "Favourites" section whose
// group identity IS the translated `detailHeader.favourites` string, and
// EntitySwitcher merges any items that share a group string into one section.
// So if a locale ever translated `detailHeader.favourites` to the same text as
// one of its `page.categories.*` labels, that category's non-favourite reports
// would collapse under the Favourites heading. No shipped locale does this
// today; this guard keeps a future translation edit from introducing it
// silently (a machine-checkable rule beats a comment).

type ReportsCatalog = {
  detailHeader?: { favourites?: string };
  page?: { categories?: Record<string, string> };
};

const catalogs = import.meta.glob<{ default: ReportsCatalog }>(
  '@/i18n/messages/*/reports.json',
  { eager: true },
);

const base = Object.entries(catalogs).find(([path]) =>
  path.includes('/en/reports.json'),
)?.[1].default;

function localeOf(path: string): string {
  return path.split('/').slice(-2, -1)[0];
}

describe('report switcher Favourites group label', () => {
  it('resolves an en base with categories to compare against', () => {
    expect(base?.page?.categories).toBeTruthy();
  });

  for (const [path, mod] of Object.entries(catalogs)) {
    const locale = localeOf(path);
    it(`${locale}: Favourites label collides with no category label`, () => {
      const catalog = mod.default;
      // Lean regional variants ship only overrides, so the effective value is the
      // locale's own string when present, else the en base's -- exactly what the
      // running app renders after next-intl merges them.
      const favourites =
        catalog.detailHeader?.favourites ?? base?.detailHeader?.favourites;
      const categories = {
        ...(base?.page?.categories ?? {}),
        ...(catalog.page?.categories ?? {}),
      };
      expect(favourites).toBeTruthy();
      expect(Object.values(categories)).not.toContain(favourites);
    });
  }
});
