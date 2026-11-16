/**
 * Blank comments while preserving line breaks, so a source-scanning guard can
 * name the pattern it bans in prose without tripping over the explanation,
 * and an offender still reports the right line.
 *
 * `document-scan.guard.test.ts` tests it in both directions: a scan that
 * prose can trip is also a scan that prose can satisfy.
 */
export function blankComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (match, prefix: string) =>
      prefix.concat(' '.repeat(match.length - prefix.length)),
    );
}
