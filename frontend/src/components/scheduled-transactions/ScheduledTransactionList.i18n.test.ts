import { describe, expect, it } from 'vitest';

/**
 * Every string this list shows a reader comes from a catalog.
 *
 * The first version of this guard listed the four literals that had just been
 * translated and asserted they were gone. That certifies a diff, not a rule:
 * two more English literals sat in the same component the whole time -- the
 * transfer chip's `` title={`Transfer to ${...|| 'account'}`} `` and the split
 * chip's `s.category?.name || 'Uncategorized'` -- and a test naming four
 * strings can only ever find those four.
 *
 * So this scans instead. The subject is every attribute a reader actually reads
 * (`title`, `aria-label`, `placeholder`, `alt`, and `InfoTooltip`'s `text`,
 * which is both its popover and its accessible name), and the rule is that after the
 * translator calls are blanked out, no prose literal is left in one. That is
 * mechanical, it covers a literal nobody has thought of yet, and it says
 * `path:line` when it fails.
 *
 * What it does NOT see, stated so the next reader does not over-trust it: a
 * literal assembled in a variable and passed in by name (the scan follows no
 * identifier), copy inside a `<span>` text child, a value coming from another
 * module, and anything outside these attributes. It is a floor, not a proof.
 *
 * The source is read through `import.meta.glob`, like its siblings
 * (`SecurityTypeAllocationReport.i18n.guard.test.ts`,
 * `src/test/ui-conventions.test.ts`), because the previous `process.cwd()` join
 * resolves against wherever vitest was started -- it throws ENOENT the moment
 * the suite is run from the repository root rather than from `frontend/`.
 */
const SUBJECT = '/src/components/scheduled-transactions/ScheduledTransactionList.tsx';

const sources = import.meta.glob(
  '/src/components/scheduled-transactions/ScheduledTransactionList.tsx',
  { query: '?raw', eager: true, import: 'default' },
) as Record<string, string>;

/** Blank comment bodies, keeping line breaks so reported lines still line up. */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '))
    .replace(
      /(^|[^:])\/\/[^\n]*/g,
      (match, before: string) => before + ' '.repeat(match.length - before.length),
    );
}

/**
 * The `{...}` expression (or `"..."` value) of every user-facing attribute,
 * with the line it starts on. Brace-matched, because these expressions hold
 * ternaries, template literals and calls with braces of their own.
 */
function userFacingAttributes(source: string): { line: number; expression: string }[] {
  const found: { line: number; expression: string }[] = [];
  const attribute = /\b(?:title|aria-label|placeholder|alt|text)\s*=\s*/g;
  let match: RegExpExecArray | null;
  while ((match = attribute.exec(source)) !== null) {
    const start = match.index + match[0].length;
    const line = source.slice(0, match.index).split('\n').length;
    if (source[start] === '"' || source[start] === "'") {
      const quote = source[start];
      const end = source.indexOf(quote, start + 1);
      found.push({ line, expression: source.slice(start, end + 1) });
      continue;
    }
    if (source[start] !== '{') continue;
    let depth = 0;
    for (let i = start; i < source.length; i += 1) {
      if (source[i] === '{') depth += 1;
      else if (source[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          found.push({ line, expression: source.slice(start, i + 1) });
          break;
        }
      }
    }
  }
  return found;
}

/**
 * A translator call and the catalog key it takes -- `t('list.splitBadge'`,
 * `tCommon('transferPayee'`. Blanked before looking for prose, since a key is a
 * quoted literal full of letters and is the one that is meant to be there.
 */
const TRANSLATOR_CALL = /\b[A-Za-z_$][\w$]*\(\s*(['"`])[^'"`]*\1/g;

/** A quoted literal holding a word: what a reader would read. */
const PROSE_LITERAL = /(['"`])([^'"`]*[A-Za-z]{2,}[^'"`]*)\1/;

function proseLiteralsIn(expression: string): string | null {
  const withoutKeys = expression.replace(TRANSLATOR_CALL, (call) =>
    call.replace(/[^\n]/g, ' '),
  );
  return PROSE_LITERAL.exec(withoutKeys)?.[2] ?? null;
}

describe('ScheduledTransactionList shows no untranslated copy', () => {
  it('scans the production component', () => {
    // A glob that matches nothing passes every check below over an empty set.
    expect(Object.keys(sources)).toEqual([SUBJECT]);
    expect(userFacingAttributes(withoutComments(sources[SUBJECT])).length).toBeGreaterThan(8);
  });

  it('has no prose literal in a title, aria-label, placeholder, alt or text', () => {
    const source = withoutComments(sources[SUBJECT]);
    const offenders = userFacingAttributes(source)
      .map(({ line, expression }) => ({ line, prose: proseLiteralsIn(expression) }))
      .filter(({ prose }) => prose !== null)
      .map(({ line, prose }) => `${SUBJECT}:${line} "${prose}"`);

    expect(
      offenders,
      'Read these through useTranslations(); grep the catalogs for the string first.',
    ).toEqual([]);
  });

  it('keeps using the strings other surfaces already own', () => {
    const source = withoutComments(sources[SUBJECT]);
    // The scan above is satisfied by ANY translator call, so these two pin
    // WHICH one: a second spelling of either string in this component's own
    // namespace would pass the scan and ship different words for one thing.
    expect(source).toContain("tCommon('transferPayee'");
    expect(source).toContain("tTransactions('list.row.uncategorized')");
  });

  it('catches the literals it was written for, and reads a key as a key', () => {
    // Both directions, so neither half can quietly stop working. The first two
    // are the exact expressions this guard failed to see.
    // A template literal holding an inner quote reports whichever literal
    // comes first (here the `'account'` fallback rather than the `Transfer to `
    // prefix) -- the report names a real offender either way, which is what it
    // is for.
    expect(
      proseLiteralsIn("{`Transfer to ${tx.transferAccount?.name || 'account'}`}"),
    ).not.toBeNull();
    expect(proseLiteralsIn('{`Transfer to ${tx.transferAccount?.name}`}')).toBe(
      'Transfer to ${tx.transferAccount?.name}',
    );
    expect(
      proseLiteralsIn("{tx.splits?.map(s => s.category?.name || 'Uncategorized').join(', ')}"),
    ).toBe('Uncategorized');
    expect(proseLiteralsIn('"Date modified for this occurrence"')).toBe(
      'Date modified for this occurrence',
    );
    // ...and a catalog key, a data value and a punctuation-only literal are not
    // offenders.
    expect(proseLiteralsIn("{t('list.modifiedDateTitle')}")).toBeNull();
    expect(proseLiteralsIn('{transaction.account?.name}')).toBeNull();
    expect(
      proseLiteralsIn(
        '{tCommon(`transferPayee`, { direction: SCHEDULED_TRANSFER_DIRECTION, name: n })}',
      ),
    ).toBeNull();
    expect(proseLiteralsIn("{parts.join(', ')}")).toBeNull();
    // A known false positive, and the reason the direction is a named constant
    // rather than an inline `'to'`: an ICU select arm is a key, not copy, but
    // it is a quoted word in an attribute and this scan cannot tell them
    // apart. Naming it is cheaper than teaching the scan about ICU.
    expect(
      proseLiteralsIn("{tCommon('transferPayee', { direction: 'to', name: n })}"),
    ).toBe('to');
  });
});
