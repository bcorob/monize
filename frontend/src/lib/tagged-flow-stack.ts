/**
 * Recharts props for a bar that may sit in a stack with a tagged-flow bar.
 *
 * Stacking is presentation only (`docs/specs/report-tag-key-breakdown.md`
 * section 10.7, INV-REPORT-003): a tagged flow shares a column with the income
 * (or expense) bar it is drawn on, and is never added into it. Off, every bar
 * keeps its own column and its own rounded top, exactly as before.
 */
export type FlowBarRole = 'base' | 'tagged';

const ROUNDED_TOP: [number, number, number, number] = [4, 4, 0, 0];
const SQUARE: [number, number, number, number] = [0, 0, 0, 0];

export function flowBarStack(
  stacked: boolean,
  stackId: string,
  role: FlowBarRole,
): { stackId?: string; radius: [number, number, number, number] } {
  if (!stacked) return { radius: ROUNDED_TOP };
  // Only the top of the stack is rounded.
  return { stackId, radius: role === 'tagged' ? ROUNDED_TOP : SQUARE };
}
