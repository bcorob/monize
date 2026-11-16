/** A form's text field as the API stores it: blank is `null`, otherwise trimmed. */
export function textOrNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}
