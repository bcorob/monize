import fs from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';

/**
 * Row density is remembered per view, by one store (`useDensityPreference`),
 * and it got that way by consolidating thirteen places that stored it
 * themselves --
 * eleven `useLocalStorage('monize-<view>-density')` calls, one hand-rolled
 * `accounts.filter.density`, and three surfaces that stored it nowhere at all
 * and so reset to `normal` on every remount (issue #1193).
 *
 * The mistake that produced that is mechanical: a new list gets written, its
 * author reaches for `useState('normal')` because that is what the list beside
 * it looked like, and nothing fails. So the rule is a scan rather than a
 * paragraph -- none of those files was wrong on its own, which is exactly the
 * shape `frontend/CLAUDE.md` says only a source scan can hold.
 */

const SRC = path.join(process.cwd(), 'src');
const STORE_FILE = path.join('store', 'densityStore.ts');
const TOGGLE_FILE = path.join('components', 'ui', 'DensityToggle.tsx');
const SCALE_FILE = path.join('hooks', 'useTableDensity.ts');
const MESSAGES = path.join(SRC, 'i18n', 'messages');

function catalogFiles(): string[] {
  const out: string[] = [];
  for (const locale of fs.readdirSync(MESSAGES, { withFileTypes: true })) {
    if (!locale.isDirectory()) continue;
    const dir = path.join(MESSAGES, locale.name);
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.json')) out.push(path.join(dir, f));
    }
  }
  return out;
}

/**
 * Drop comment lines before matching.
 *
 * Prose about the defect is not the defect: this file and the store both spell
 * out the `useState('normal')` that started it, and a scan that cannot tell
 * the description from the thing fails on its own documentation. Only whole
 * comment lines and block comments go -- a trailing `//` is left alone rather
 * than risk cutting a line at the `//` inside a URL.
 */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*(?:\/\/|\*)/.test(line))
    .join('\n');
}

function sourceFiles(): { rel: string; source: string }[] {
  const out: { rel: string; source: string }[] = [];

  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue;
        walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name)) continue;
      if (/\.(test|spec)\.tsx?$/.test(entry.name)) continue;
      out.push({
        rel: path.relative(SRC, full),
        source: withoutComments(fs.readFileSync(full, 'utf8')),
      });
    }
  };

  walk(SRC);
  return out;
}

const FILES = sourceFiles();

describe('row density is one preference', () => {
  it('finds the store itself, so an empty scan cannot pass', () => {
    // Every assertion below is "no file does X". A walk that silently returned
    // nothing would satisfy all of them.
    expect(FILES.length).toBeGreaterThan(200);
    expect(FILES.map((f) => f.rel)).toContain(STORE_FILE);
  });

  it('has no component holding density in its own useState', () => {
    // `useState<DensityLevel>('normal')` in every list is what made the level
    // reset on remount, and made two surfaces on one page disagree.
    //
    // Caught two ways -- by the type, and by the name of the state it binds --
    // because the untyped `useState('normal')` a copy-paste produces has
    // neither a `DensityLevel` nor anything else to recognise it by. Keyed on
    // the name rather than the bare literal so an unrelated `useState('normal')`
    // (a priority, a font weight) is not dragged in.
    const offenders = FILES.filter(({ source }) =>
      /useState\s*<\s*(?:DensityLevel|'normal'\s*\|\s*'compact'\s*\|\s*'dense')\s*>/.test(source) ||
      /\[\s*\w*[Dd]ensity\w*\s*,[^\]]*\]\s*=\s*useState/.test(source),
    ).map((f) => f.rel);

    expect(
      offenders,
      'Density is app-wide state: read it with useDensityPreference() from @/store/densityStore instead of a local useState.',
    ).toEqual([]);
  });

  it('has no per-view density key in browser storage', () => {
    // Matched at the storage call site rather than on the word appearing
    // anywhere in the file: `t('page.densityTitle')` is a translation key, and
    // three of the pages carrying one also use `useLocalStorage` for something
    // unrelated. A file-wide grep calls all three offenders and teaches the
    // next reader to disable the guard.
    const STORAGE_CALL = [
      /(?:local|session)Storage\.(?:get|set|remove)Item\s*\(\s*([^,)]*density[^,)]*)/gi,
      /useLocalStorage\s*(?:<[^>]*>)?\s*\(\s*([^,)]*density[^,)]*)/gi,
      /getStoredValue\s*(?:<[^>]*>)?\s*\(\s*([^,)]*density[^,)]*)/gi,
    ];

    const offenders: string[] = [];
    for (const { rel, source } of FILES) {
      // The store names the twelve legacy keys in order to delete them.
      if (rel === STORE_FILE) continue;
      for (const re of STORAGE_CALL) {
        for (const match of source.matchAll(re)) {
          offenders.push(`${rel}: ${match[0].trim()}`);
        }
      }
    }

    expect(
      offenders,
      'A density key per view is the bug in issue #1193. There is one key, and densityStore.ts owns it.',
    ).toEqual([]);
  });

  it('has no component lifting density back out to its parent', () => {
    // `density` / `onDensityChange` props were how each page owned a copy.
    // A `density` prop passed *down* to a row or to RowActions is fine and
    // still used; a change callback travelling *up* is the pattern that split
    // one preference into twelve.
    const offenders = FILES.filter(({ source }) => /onDensityChange/.test(source)).map(
      (f) => f.rel,
    );

    expect(
      offenders,
      'A surface changes density by calling the store, not by reporting it to a parent that stores its own copy.',
    ).toEqual([]);
  });

  it('has no second copy of the density toggle', () => {
    // Eleven surfaces drew this button. Seven were byte-identical and each read
    // its label from its own namespace, which is how fourteen of nineteen
    // locales ended up labelling one control two or three different ways.
    const TOGGLE_MARKUP = [
      // The hamburger glyph the toggle is drawn with.
      /d="M4 6h16M4 1[02]h16M4 1[48]h16/,
      // The bar it hangs from above a table.
      /flex justify-end p-2 border-b border-gray-200/,
    ];

    const offenders: string[] = [];
    for (const { rel, source } of FILES) {
      if (rel === TOGGLE_FILE) continue;
      if (!/density/i.test(source)) continue;
      for (const re of TOGGLE_MARKUP) {
        if (re.test(source)) offenders.push(`${rel}: ${re.source}`);
      }
    }

    expect(
      offenders,
      'Render <DensityToggle /> or <DensityToggleBar /> from @/components/ui/DensityToggle rather than a second copy of the button.',
    ).toEqual([]);
  });

  it('keeps the density labels in one catalog entry', () => {
    // `common.density.*` is the only place these four strings live. A namespace
    // growing its own set is how the translations drifted the first time.
    const strays: string[] = [];
    for (const file of catalogFiles()) {
      const source = fs.readFileSync(file, 'utf8');
      if (path.basename(file) === 'common.json') continue;
      for (const match of source.matchAll(/"(density[A-Za-z]*|density)"\s*:/g)) {
        strays.push(`${path.relative(MESSAGES, file)}: ${match[1]}`);
      }
    }

    expect(
      strays,
      'Density copy belongs to common.density, so every surface says the same words. See DensityToggle.tsx.',
    ).toEqual([]);
  });

  it('has no component spelling out its own density padding', () => {
    // Three copies of the padding table lived in three files, agreeing at some
    // levels and silently disagreeing at others.
    const offenders = FILES.filter(
      ({ rel, source }) => rel !== SCALE_FILE && /case 'dense':\s*return\s*'px-/.test(source),
    ).map((f) => f.rel);

    expect(
      offenders,
      'Padding comes from useTableDensity(density, scale). Add a named scale there rather than a switch here.',
    ).toEqual([]);
  });

  it('makes every shared list name the view it is rendering for', () => {
    // `TransactionList` is rendered from six places and
    // `InvestmentTransactionList` from two, each remembering its own level. The
    // prop defaults to the owning page's view, so a caller that is *not* that
    // page and forgets it silently shares the register's bucket -- a bug with
    // no visible symptom until two unrelated screens move together.
    const OWNERS: Record<string, string> = {
      TransactionList: path.join('app', 'transactions', 'page.tsx'),
      InvestmentTransactionList: path.join('app', 'investments', 'page.tsx'),
    };

    const offenders: string[] = [];
    for (const { rel, source } of FILES) {
      for (const [component, owner] of Object.entries(OWNERS)) {
        if (rel === owner) continue;
        // Each JSX element runs to its closing bracket; `densityView` has to be
        // inside that element, not merely somewhere in the file.
        const re = new RegExp(`<${component}\\b[\\s\\S]*?/?>`, 'g');
        for (const match of source.matchAll(re)) {
          if (!/densityView=/.test(match[0])) {
            offenders.push(`${rel}: <${component}> without densityView`);
          }
        }
      }
    }

    expect(
      offenders,
      'Pass densityView so this surface remembers its own level instead of sharing the owning page\'s.',
    ).toEqual([]);
  });

  it('routes every density toggle through the shared preference', () => {
    // The positive half: a file that cycles density must get `cycleDensity`
    // from the store rather than deriving a new level and storing it itself.
    const offenders = FILES.filter(
      ({ rel, source }) =>
        rel !== STORE_FILE &&
        /\bcycleDensity\b/.test(source) &&
        !/useDensityPreference/.test(source),
    ).map((f) => f.rel);

    expect(
      offenders,
      'Import { useDensityPreference } from "@/store/densityStore" and use its cycleDensity.',
    ).toEqual([]);
  });
});
