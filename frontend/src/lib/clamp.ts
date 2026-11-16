/**
 * `value` bounded to `[min, max]`. When the range is empty (`max < min`, e.g. a
 * tooltip wider than the viewport it is placed in) the lower bound wins.
 */
export function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}
