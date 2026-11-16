import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Keeps the import wizard's advertised file formats in step with the ones it
 * actually accepts, in every locale.
 *
 * `.mny` was added to the upload input's `accept` list when the Microsoft Money
 * importer landed, and the copy naming the formats was not: the page subtitle
 * and the "Supported formats" sentence went on listing QIF, OFX/QFX and CSV in
 * all 23 locales, and the drop-zone line was updated in `en` alone. The feature
 * worked and nothing on the page said so, which is the same defect as not
 * shipping it.
 *
 * The accept list is the source of truth because it is what the file picker
 * enforces. Adding an extension there and nowhere else now fails here rather
 * than shipping an undiscoverable format -- and it fails per locale, because a
 * translated catalog is exactly where the second half of the edit gets
 * forgotten.
 */

const here = dirname(fileURLToPath(import.meta.url));
const messagesDir = join(here, 'messages');

/**
 * Read the extensions straight out of the component rather than restating them
 * here, so this test cannot drift from the input the way the copy did.
 */
const ACCEPTED_EXTENSIONS = (() => {
  const source = readFileSync(
    join(here, '..', 'components', 'import', 'UploadStep.tsx'),
    'utf8',
  );
  const match = source.match(/accept="([^"]+)"/);
  if (!match) {
    throw new Error('No accept attribute found in UploadStep.tsx');
  }
  return match[1]
    .split(',')
    .map((entry) => entry.trim().replace(/^\./, '').toLowerCase())
    .filter(Boolean);
})();

/**
 * The strings a user reads to learn what they can upload: the page subtitle,
 * the instructions above the drop zone, the drop zone's own caption, and the
 * toast that refuses a dropped file of another type.
 */
const FORMAT_STRINGS: readonly [section: string, key: string][] = [
  ['page', 'subtitle'],
  ['upload', 'instructions'],
  ['upload', 'acceptedFormats'],
  ['upload', 'unsupportedDrop'],
];

const LOCALES = readdirSync(messagesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

describe('import format copy', () => {
  it('reads a non-empty accept list from the upload step', () => {
    expect(ACCEPTED_EXTENSIONS).toContain('mny');
    expect(ACCEPTED_EXTENSIONS.length).toBeGreaterThan(1);
  });

  describe.each(LOCALES)('%s', (locale) => {
    const catalog = JSON.parse(
      readFileSync(join(messagesDir, locale, 'import.json'), 'utf8'),
    ) as Record<string, Record<string, string> | undefined>;

    it.each(FORMAT_STRINGS)(
      'names every accepted extension in %s.%s',
      (section, key) => {
        const value = catalog[section]?.[key];
        // Regional variants (en-GB, en-US) carry only the keys that differ from
        // `en` and inherit the rest, so an absent string here is correct.
        if (typeof value !== 'string') return;

        const haystack = value.toLowerCase();
        for (const extension of ACCEPTED_EXTENSIONS) {
          expect(
            haystack,
            `${locale} ${section}.${key} does not name .${extension}`,
          ).toContain(extension);
        }
      },
    );
  });
});
