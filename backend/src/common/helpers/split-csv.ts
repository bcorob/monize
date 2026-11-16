/** A comma-separated query parameter, as a trimmed non-empty array. */
export function splitCsv({ value }: { value: unknown }): unknown {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return value;
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}
