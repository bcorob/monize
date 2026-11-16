import { describe, it, expect } from 'vitest';

/**
 * A phone number is STORED as E.164 and SHOWN grouped, and exactly one function
 * turns one into the other: `formatPhoneForDisplay` (`@/lib/phone-number`).
 *
 * Rendering `payee.phone` straight into the markup puts `+442079460958` in
 * front of a reader, which is the number and is not how anyone reads one -- and
 * because the column used to hold whatever was typed, a raw render looked
 * perfectly fine for every row written before normalization and wrong for every
 * row written after. `docs/frontend/forms-and-formatting.md` states the rule; per the repo's
 * "prefer the rule the machine can check", this scan is what keeps it, modelled
 * on `number-parse.guard.test.ts`.
 */
const sources = import.meta.glob('/src/**/*.{ts,tsx}', {
  query: '?raw',
  eager: true,
  import: 'default',
}) as Record<string, string>;

/**
 * Blank comment lines, preserving line count so a reported line number still
 * points at the offending line. The paragraphs above and in `CLAUDE.md` have to
 * be able to NAME the pattern being banned without tripping the scan -- the
 * alternative is a weaker explanation, which is the opposite of the point.
 */
function stripComments(source: string): string {
  return source
    .split('\n')
    .map((line) => {
      const trimmed = line.trimStart();
      return trimmed.startsWith('//') ||
        trimmed.startsWith('*') ||
        trimmed.startsWith('/*')
        ? ''
        : line;
    })
    .join('\n');
}

/**
 * A phone value rendered into JSX: `{payee.phone}`, `{row.phone ?? ...}`,
 * `{x.phone || ...}`. By shape rather than by variable name, because the alias
 * is how this kind of thing gets through -- `preview.phone` and `payee.phone`
 * are the same mistake.
 */
const RAW_JSX_RENDER = /\{\s*\w+(?:\?)?\.phone\s*(?:\}|\?\?|\|\|)/;

/**
 * A phone value put into a form control. An input is a surface a person reads
 * exactly as much as a rendered span, and rendering is not the only way a value
 * reaches one: the payee form's lookup prefill wrote the Phone input through
 * `setValue`, so the scan above saw nothing while the field showed
 * `+442079460958;ext=12` -- a machine-only suffix in a box labelled Phone --
 * and the same input formatted the stored value on load, three lines away.
 *
 * Named `'phone'` outright is the easy half.
 */
const RAW_FORM_WRITE =
  // The lookahead spans the whitespace rather than sitting after it: `\s*` can
  // give back what it matched, and a lookahead placed after it always finds a
  // position where the formatter does not start.
  /\bsetValue\(\s*(?:'phone'|"phone"|`phone`)\s*,(?!\s*formatPhoneForDisplay)/;

/**
 * The hard half, and the shape the defect actually had: a loop over the contact
 * fields writing each one by its variable, where nothing on the line says
 * "phone" at all. A file that writes contact fields into a form generically has
 * to decide the phone's form at the write site -- so if it writes
 * `setValue(field, ...)`, it must also carry the per-field mapping.
 *
 * Two questions rather than one wider pattern: banning `setValue(field, ...)`
 * outright would fail every generic form in the codebase, and exempting them by
 * name is how the one that matters keeps its exemption.
 */
const LOOPS_FIELDS_INTO_FORM = /\bsetValue\(\s*field\s*,/;
const MAPS_PHONE_AT_THE_WRITE_SITE =
  /field === 'phone'\s*\?\s*formatPhoneForDisplay\(/;

/**
 * The files allowed to handle a raw phone value, each with the reason.
 *
 * `phone-number.ts` is where the formatting lives. `contact-links.ts` builds the
 * `tel:` href, which needs the stored digits and the stored `;ext=` suffix, not
 * the grouped display form.
 */
const ALLOWED = new Set(['/src/lib/phone-number.ts', '/src/lib/contact-links.ts']);

function productionSources(): [string, string][] {
  return Object.entries(sources)
    .filter(([path]) => !path.includes('.test.'))
    .filter(([path]) => !ALLOWED.has(path))
    .map(([path, source]) => [path, stripComments(source)]);
}

describe('a phone number is displayed through one formatter', () => {
  it('loads the sources, so the scan is not vacuous', () => {
    // A broken glob would make the rule below pass over an empty list, and the
    // guard would silently stop guarding.
    expect(productionSources().length).toBeGreaterThan(100);
  });

  it('is never rendered raw', () => {
    const offenders = productionSources()
      .filter(([, source]) => RAW_JSX_RENDER.test(source))
      .map(([path]) => path);
    // Wrap the value in `formatPhoneForDisplay` from `@/lib/phone-number`.
    expect(offenders).toEqual([]);
  });

  it('is never written straight into a form control', () => {
    const offenders = productionSources()
      .filter(([, source]) => RAW_FORM_WRITE.test(source))
      .map(([path]) => path);
    // Wrap the value in `formatPhoneForDisplay` from `@/lib/phone-number`.
    expect(offenders).toEqual([]);
  });

  it('decides the phone\'s form where a loop writes fields generically', () => {
    const offenders = productionSources()
      .filter(([, source]) => LOOPS_FIELDS_INTO_FORM.test(source))
      .filter(([, source]) => !MAPS_PHONE_AT_THE_WRITE_SITE.test(source))
      .map(([path]) => path);
    // A loop that writes contact fields into a form must format the phone at
    // the write site: `field === 'phone' ? formatPhoneForDisplay(value) : value`.
    expect(offenders).toEqual([]);
  });

  it('finds the loop, so the rule above is not vacuous', () => {
    // The one file this is about. Were the shape to change, the scan would
    // pass over an empty list and stop guarding anything.
    const looping = productionSources()
      .filter(([, source]) => LOOPS_FIELDS_INTO_FORM.test(source))
      .map(([path]) => path);
    expect(looping).toContain('/src/components/payees/PayeeForm.tsx');
  });

  it('catches a raw form write, and reads a formatted one as fine', () => {
    // The counter-test, both ways: a scan that cannot fail is not a guard, and
    // one that cannot pass gets weakened until it is.
    expect(RAW_FORM_WRITE.test("setValue('phone', value)")).toBe(true);
    expect(RAW_FORM_WRITE.test('setValue("phone", suggestion.phone, opts)')).toBe(true);
    expect(
      RAW_FORM_WRITE.test("setValue('phone', formatPhoneForDisplay(value))"),
    ).toBe(false);
    expect(RAW_FORM_WRITE.test("setValue('email', value)")).toBe(false);

    // ...and the loop form, which is the one that got through: the original
    // mistake names no field on the line at all.
    const original = "setValue(field, value, { shouldDirty: true });";
    expect(LOOPS_FIELDS_INTO_FORM.test(original)).toBe(true);
    expect(MAPS_PHONE_AT_THE_WRITE_SITE.test(original)).toBe(false);
    const fixed =
      "const shown = field === 'phone' ? formatPhoneForDisplay(value) : value;\n" +
      'setValue(field, shown, { shouldDirty: true });';
    expect(MAPS_PHONE_AT_THE_WRITE_SITE.test(fixed)).toBe(true);
  });

  it('is formatted at every surface that shows one', () => {
    // The other half of the rule: the scan above cannot see a value passed
    // through a variable, so the surfaces known to display a phone are also
    // required to reference the formatter. A new one added without it fails
    // the scan above; one that renames its variable fails this.
    const displaySurfaces = [
      '/src/components/payees/detail/PayeeKeyInfoCard.tsx',
      '/src/components/payees/ContactLookupDialog.tsx',
      '/src/components/ai/TransactionConfirmationCard.tsx',
      '/src/components/ai/BulkConfirmationCard.tsx',
      '/src/components/payees/PayeeForm.tsx',
    ];
    const missing = displaySurfaces.filter(
      (path) => !sources[path]?.includes('formatPhoneForDisplay'),
    );
    expect(missing).toEqual([]);
  });

  it('catches a raw render, so the rule cannot pass by matching nothing', () => {
    // The counter-test.
    for (const offending of [
      '<span>{payee.phone}</span>',
      '<span>{preview.phone}</span>',
      "value: row.phone || '-',".replace('value:', '{'),
      '{payee?.phone}',
      '{selected.phone ?? none}',
    ]) {
      expect(RAW_JSX_RENDER.test(offending)).toBe(true);
    }
  });

  it('does not read a formatted render as a raw one', () => {
    for (const allowed of [
      '<span>{formatPhoneForDisplay(payee.phone)}</span>',
      '{phoneDisplay}',
      'const link = telHref(payee.phone);',
    ]) {
      expect(RAW_JSX_RENDER.test(allowed)).toBe(false);
    }
  });

  it('blanks comments without moving the lines after them', () => {
    const source = ['// {payee.phone}', 'const a = 1;', ' * {row.phone}'].join('\n');
    const blanked = stripComments(source);
    expect(RAW_JSX_RENDER.test(blanked)).toBe(false);
    expect(blanked.split('\n')).toHaveLength(3);
    expect(blanked.split('\n')[1]).toBe('const a = 1;');
    // ...and a real render on the line after a comment still matches.
    expect(RAW_JSX_RENDER.test(stripComments('// note\n<b>{payee.phone}</b>'))).toBe(
      true,
    );
  });
});
