/**
 * Escape a literal string for safe interpolation into a `RegExp` source.
 *
 * Every character with a meaning in a regular expression is neutralized,
 * `\` included -- and the backslash is the one that gets left out. Escaping
 * only the obvious metacharacter looks complete because it is the one the
 * value actually contains: `value.replace(/\./g, "\\.")` handles every dot in a
 * repository path and leaves `\` alone, so a literal `c\d` interpolates as the
 * digit class `\d` and the pattern silently matches input nobody wrote
 * (CWE-020, CodeQL `js/incomplete-sanitization`). An escape that is partial is
 * indistinguishable from a correct one until the value contains the character
 * it forgot.
 *
 * Use this anywhere a value -- a constant, a separator, a filename, a
 * user-supplied word -- is concatenated into a pattern, rather than writing the
 * character class out again: it was spelled out in five places, and the fifth
 * copy was the incomplete one. `escape-regexp.guard.spec.ts` fails on a sixth.
 *
 * The set is the standard one (`.*+?^${}()|[]\`). It deliberately does not
 * escape `-`: outside a character class `-` is literal, and `\-` is a
 * SyntaxError under the `u` flag. Do not interpolate the result *inside* a
 * character class.
 */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
