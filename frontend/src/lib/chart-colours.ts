/**
 * Shared chart colour palettes for Recharts visualizations.
 *
 * CHART_COLOURS (20) — general-purpose, used by most reports.
 * CHART_COLOURS_INCOME (10) — green-to-purple gradient for income charts.
 * CHART_COLOURS_ASSETS / CHART_COLOURS_LIABILITIES — semantic pair for a chart
 * mixing values of both signs (issue #1243): positive values cycle cool hues,
 * negative ones warm reds, so the two sides never share a colour however far
 * either cycle runs.
 */

export const CHART_COLOURS = [
  '#3b82f6', '#22c55e', '#f97316', '#8b5cf6', '#ec4899',
  '#14b8a6', '#eab308', '#ef4444', '#6366f1', '#06b6d4',
  '#84cc16', '#f43f5e', '#a855f7', '#10b981', '#f59e0b',
  '#64748b', '#78716c', '#71717a', '#737373', '#6b7280',
] as const;

export const CHART_COLOURS_INCOME = [
  '#22c55e', '#10b981', '#14b8a6', '#06b6d4', '#0ea5e9',
  '#3b82f6', '#6366f1', '#8b5cf6', '#a855f7', '#d946ef',
] as const;

export const CHART_COLOURS_ASSETS = [
  '#3b82f6', '#22c55e', '#8b5cf6', '#14b8a6', '#6366f1',
  '#06b6d4', '#10b981', '#a855f7', '#0ea5e9', '#84cc16',
] as const;

export const CHART_COLOURS_LIABILITIES = [
  '#ef4444', '#f97316', '#e11d48', '#dc2626', '#ea580c',
  '#be123c', '#b91c1c', '#c2410c',
] as const;
