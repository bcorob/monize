/**
 * Join names the way the locale lists things ("A, B and C"), falling back to
 * the runtime's default locale when the tag is one `Intl.ListFormat` rejects.
 */
export function formatNameList(locale: string, names: string[]): string {
  try {
    return new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' }).format(names);
  } catch {
    return new Intl.ListFormat(undefined, { style: 'long', type: 'conjunction' }).format(names);
  }
}
