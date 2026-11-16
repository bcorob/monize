'use client';

import type { ReactElement } from 'react';
import { chartColors } from '@/lib/chart-colors';
import { createLogger } from '@/lib/logger';
import { useAuthStore } from '@/store/authStore';
import {
  clearAllIntradayCache,
  INTRADAY_CACHE_PREFIX,
} from '@/lib/identity-session-storage';
import type { ChartDatePattern } from '@/lib/utils';

const logger = createLogger('PortfolioValueChart');

/**
 * Ranges that pull intraday bars from the live quote provider. 1W/MTD/1M move
 * from daily-snapshot data to intraday bars when every holding's provider
 * supports it; otherwise the backend signals fallbackToDaily=true and we
 * switch back to the daily endpoint.
 *
 * Each is served on its own window, already shaped: the server trims the bars
 * to the range and opens 1W, MTD and 1M on the close they are measured from
 * (`PortfolioService.planOpeningClose`), so nothing here reshapes a series.
 * `portfolio-chart-utils.test.ts` holds this set equal to the backend's
 * `INTRADAY_RANGES`; a range in one and not the other is a 400 at runtime.
 */
export type IntradayRange = '1d' | '1w' | 'mtd' | '1m';

export const INTRADAY_RANGES: ReadonlySet<string> = new Set<IntradayRange>([
  '1d',
  '1w',
  'mtd',
  '1m',
]);

export function isIntradayRange(range: string): range is IntradayRange {
  return INTRADAY_RANGES.has(range);
}

type FormatChartDate = (date: string, pattern: ChartDatePattern) => string;

/**
 * The label of one point of a month-end-sampled series
 * (`sampling: 'monthEnd'` / `granularity: 'monthEnd'`).
 *
 * The two ends are the closes the period figures are measured between, so
 * they are named by their day; the points in between are month-ends and are
 * named by their month. Keyed off the point's own `iso`, never parsed back out
 * of a localized label.
 */
export function sampledPointLabel(
  iso: string,
  index: number,
  count: number,
  formatChartDate: FormatChartDate,
): string {
  const boundary = index === 0 || index === count - 1;
  return formatChartDate(iso, boundary ? 'MMM d, yyyy' : 'MMM yyyy');
}

/**
 * The x-axis tick text for a month-end-sampled series, from the point's own
 * date: the day at either end, then the month, shortening as the series grows.
 */
export function sampledTickLabel(
  iso: string,
  index: number,
  count: number,
  formatChartDate: FormatChartDate,
): string {
  if (index === 0 || index === count - 1) {
    return formatChartDate(iso, count > 18 ? 'MMM yy' : 'MMM d');
  }
  if (count > 36) return formatChartDate(iso, 'yyyy');
  if (count > 18) return formatChartDate(iso, 'MMM yy');
  return formatChartDate(iso, 'MMM');
}

/**
 * The ticks a long month-end-sampled series shows: one per January, read from
 * each point's `iso` rather than from a label that only an English locale
 * starts with "Jan ". `undefined` leaves a short series to the chart's own
 * spacing.
 */
export function monthEndAxisTicks(
  points: ReadonlyArray<{ name: string; iso: string }>,
): string[] | undefined {
  if (points.length <= 36) return undefined;
  return points
    .filter(
      (point, index) =>
        index > 0 &&
        index < points.length - 1 &&
        point.iso.slice(5, 7) === '01',
    )
    .map((point) => point.name);
}

// The helpers live in `lib/identity-session-storage` so `authStore` can clear
// them without importing this module; re-exported for the existing callers.
export { clearAllIntradayCache, INTRADAY_CACHE_PREFIX };

const ANONYMOUS_CACHE_SCOPE = `${INTRADAY_CACHE_PREFIX}anonymous|`;

export interface IntradayCachePayload {
  fetchedAt: number;
  points: Array<{
    timestamp: string;
    value: number;
    securitiesValue?: number;
    fxComplete?: boolean;
    pricesComplete?: boolean;
    cashComplete?: boolean;
    sessionClose?: true;
  }>;
  /** Response-level lists, so a hydrated chart can name what is missing. */
  missingRatePairs?: string[];
  unpricedSecurityIds?: string[];
  interval: '1m' | '2m' | '5m' | '15m' | '30m' | '60m' | '90m';
  currency: string;
  fallbackToDaily: boolean;
  skippedSymbols: string[];
  failedSymbols: string[];
}

/**
 * The key carries the signed-in user and the acting context, so two identities
 * never share an entry (INV-SHARE-003). With nobody signed in the key is the
 * anonymous scope, which is never written or read.
 */
export function buildIntradayCacheKey(
  range: string,
  accountIds: string[] | undefined,
  currency: string,
): string {
  const { user, actingAsUserId } = useAuthStore.getState();
  const accts = (accountIds ?? []).slice().sort().join(',');
  const scope = user?.id
    ? `${INTRADAY_CACHE_PREFIX}u:${user.id}|a:${actingAsUserId ?? 'self'}|`
    : ANONYMOUS_CACHE_SCOPE;
  return `${scope}${range}|${accts}|${currency}`;
}

export function readIntradayCache(key: string): IntradayCachePayload | null {
  if (typeof window === 'undefined') return null;
  if (key.startsWith(ANONYMOUS_CACHE_SCOPE)) return null;
  try {
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as IntradayCachePayload;
  } catch {
    return null;
  }
}

export function writeIntradayCache(
  key: string,
  payload: IntradayCachePayload,
): void {
  if (typeof window === 'undefined') return;
  if (key.startsWith(ANONYMOUS_CACHE_SCOPE)) return;
  try {
    window.sessionStorage.setItem(key, JSON.stringify(payload));
  } catch (error) {
    logger.warn('Failed to write intraday cache:', error);
  }
}

/**
 * Round `raw` up to a "nice" axis step (1, 2, 5 × 10^n). Used to pick a
 * y-axis tick interval so labels look clean at any scale.
 */
export function niceAxisStep(raw: number): number {
  if (raw <= 0) return 1;
  const exp = Math.floor(Math.log10(raw));
  const magnitude = Math.pow(10, exp);
  const f = raw / magnitude;
  let nf: number;
  if (f < 1.5) nf = 1;
  else if (f < 3) nf = 2;
  else if (f < 7) nf = 5;
  else nf = 10;
  return nf * magnitude;
}

/**
 * Tight-zoom y-axis bounds. Returns explicit [min, max] (not 'auto') so
 * Recharts doesn't pad the data into the top/bottom slivers of the plot
 * and small price moves stay visible.
 *
 *   - Flat line: ±1% padding (or ±1, whichever is larger).
 *   - Crosses zero: anchor at 0 with nice steps on both sides.
 *   - All-positive / all-negative: 5% padding, snapped to a nice step,
 *     clamped so we don't dive past zero just from padding.
 */
export function computeTightYAxisDomain(
  values: number[],
): [number, number] | [number, 'auto'] {
  if (values.length === 0) return [0, 'auto'];

  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);
  const range = maxValue - minValue;

  if (range === 0) {
    const pad = Math.max(Math.abs(minValue) * 0.01, 1);
    return [minValue - pad, maxValue + pad];
  }

  const crossesZero = minValue < 0 && maxValue > 0;
  if (crossesZero) {
    const niceMaxStep = niceAxisStep((maxValue - 0) / 5);
    const niceMax = Math.ceil(maxValue / niceMaxStep) * niceMaxStep;
    const niceMinStep = niceAxisStep((0 - minValue) / 5);
    const niceMin = Math.floor(minValue / niceMinStep) * niceMinStep;
    return [niceMin, niceMax];
  }

  const padding = range * 0.05;
  const rawMin = minValue - padding;
  const rawMax = maxValue + padding;
  const step = niceAxisStep(range / 5);
  const niceMin = Math.floor(rawMin / step) * step;
  const niceMax = Math.ceil(rawMax / step) * step;

  if (minValue >= 0) {
    return [Math.max(0, niceMin), niceMax];
  }
  return [niceMin, Math.min(0, niceMax)];
}

/**
 * Bubble-style "flag" callout pinned to a chart datapoint. Mirrors the
 * Cash Flow Forecast min-balance bubble: a colored dot with a dashed
 * connector up/down to a rounded label showing the value. Used to mark
 * the highest and lowest points on portfolio-value charts.
 *
 * Uses an SVG <filter> with id "chartFlagShadow"; callers must include
 * <ChartFlagShadowFilter /> (or the equivalent <defs>) inside the chart's
 * SVG once per render. Recharts dot renderers must return an SVGElement,
 * so this is a plain function rather than a React component.
 */
export interface FlagDotOptions {
  cx: number;
  cy: number;
  index: number;
  /** Color of dot/bubble (e.g. chartColors.income for highest, chartColors.expense for lowest). */
  color: string;
  /** Pre-formatted label text (caller chooses compact vs full). */
  label: string;
  /**
   * Which side of the dot the bubble sits on. 'left' / 'right' produce a
   * horizontal connector; 'above' / 'below' produce a vertical one.
   */
  side: 'above' | 'below' | 'left' | 'right';
  /**
   * Distance in pixels from the dot center to the bubble's near edge.
   * Default: 24. Use a smaller value when the bubble is near a chart
   * edge that would clip it.
   */
  gap?: number;
  /**
   * When provided, the bubble grows a small "x" control on its right edge
   * that calls this on click, letting the user temporarily hide the bubble to
   * see the chart behind it. The dismissal is the caller's state to track.
   */
  onDismiss?: () => void;
  /** Localized title/aria label for the dismiss control. */
  dismissLabel?: string;
  /**
   * When false, omit the pin dot, dashed connector, and arrow -- rendering just
   * the labelled box. Useful for anchoring the box to a reference line rather
   * than a single datapoint. Default true.
   */
  showDot?: boolean;
  /**
   * Vertical placement of the box for the horizontal sides ('left' / 'right'):
   * 'middle' centers it on cy (default); 'top' puts the box's top edge at cy so
   * it hangs below the anchor (e.g. flush under a reference line).
   */
  boxVerticalAlign?: 'middle' | 'top';
}

export function renderChartFlagDot({
  cx,
  cy,
  index,
  color,
  label,
  side,
  gap = 24,
  onDismiss,
  dismissLabel,
  showDot = true,
  boxVerticalAlign = 'middle',
}: FlagDotOptions): ReactElement {
  // Reserve room on the right of the bubble for the dismiss "x" when present.
  const hasClose = typeof onDismiss === 'function';
  const closeZone = hasClose ? 16 : 0;
  const labelWidth = label.length * 7 + 14 + closeZone;
  const labelHeight = 22;
  // No arrow when the pin dot is suppressed -- the box anchors directly.
  const arrowSize = showDot ? 5 : 0;

  // Bubble centroid + arrow tip geometry. Vertical sides ('above'/'below')
  // anchor the arrow on the top/bottom edge of the bubble; horizontal sides
  // anchor it on the left/right edge.
  let bubbleX: number;
  let bubbleY: number;
  let arrowTipX: number;
  let arrowTipY: number;
  let connectorX1: number;
  let connectorY1: number;
  let arrowPoints: string;

  if (side === 'above') {
    bubbleX = cx - labelWidth / 2;
    bubbleY = cy - gap - arrowSize - labelHeight;
    arrowTipX = cx;
    arrowTipY = cy - gap;
    connectorX1 = cx;
    connectorY1 = cy - 5;
    arrowPoints = `${cx - arrowSize},${arrowTipY - arrowSize} ${cx + arrowSize},${arrowTipY - arrowSize} ${cx},${arrowTipY}`;
  } else if (side === 'below') {
    bubbleX = cx - labelWidth / 2;
    bubbleY = cy + gap + arrowSize;
    arrowTipX = cx;
    arrowTipY = cy + gap;
    connectorX1 = cx;
    connectorY1 = cy + 5;
    arrowPoints = `${cx - arrowSize},${arrowTipY + arrowSize} ${cx + arrowSize},${arrowTipY + arrowSize} ${cx},${arrowTipY}`;
  } else if (side === 'right') {
    bubbleX = cx + gap + arrowSize;
    bubbleY = boxVerticalAlign === 'top' ? cy : cy - labelHeight / 2;
    arrowTipX = cx + gap;
    arrowTipY = cy;
    connectorX1 = cx + 5;
    connectorY1 = cy;
    arrowPoints = `${arrowTipX + arrowSize},${cy - arrowSize} ${arrowTipX + arrowSize},${cy + arrowSize} ${arrowTipX},${cy}`;
  } else {
    // 'left'
    bubbleX = cx - gap - arrowSize - labelWidth;
    bubbleY = boxVerticalAlign === 'top' ? cy : cy - labelHeight / 2;
    arrowTipX = cx - gap;
    arrowTipY = cy;
    connectorX1 = cx - 5;
    connectorY1 = cy;
    arrowPoints = `${arrowTipX - arrowSize},${cy - arrowSize} ${arrowTipX - arrowSize},${cy + arrowSize} ${arrowTipX},${cy}`;
  }

  // Explicit fillOpacity / strokeOpacity / opacity on every shape:
  // recharts' <Area fillOpacity={...}> propagates a fillOpacity attribute
  // down to dot children via SVG inheritance, which would render the
  // bubble at the area's translucent fill instead of solid color.
  return (
    <g
      key={`flag-${index}-${side}`}
      fillOpacity={1}
      strokeOpacity={1}
      opacity={1}
    >
      {showDot && (
        <>
          <circle
            cx={cx}
            cy={cy}
            r={5}
            fill={color}
            fillOpacity={1}
            // The ring exists to separate the dot from the line beneath it, so it
            // is the card colour rather than white -- on a dark card a white
            // ring is an outline instead of a gap.
            stroke={chartColors.surface}
            strokeWidth={2}
            strokeOpacity={1}
          />
          <line
            x1={connectorX1}
            y1={connectorY1}
            x2={arrowTipX}
            y2={arrowTipY}
            stroke={color}
            strokeWidth={1.5}
            strokeDasharray="3 2"
            strokeOpacity={1}
          />
        </>
      )}
      <rect
        x={bubbleX}
        y={bubbleY}
        width={labelWidth}
        height={labelHeight}
        rx={5}
        fill={color}
        fillOpacity={1}
        filter="url(#chartFlagShadow)"
      />
      {showDot && <polygon points={arrowPoints} fill={color} fillOpacity={1} />}
      {/* Everything from here down is drawn ON the filled bubble, not on the
          card: the label, the divider and the dismiss cross are all contrast
          against `color`. They stay literal white deliberately -- swapping in
          `chartColors.surface` would make them the card colour and so
          invisible on the bubble in dark mode. */}
      <text
        x={bubbleX + (labelWidth - closeZone) / 2}
        y={bubbleY + labelHeight / 2}
        textAnchor="middle"
        dominantBaseline="central"
        fill="#fff"
        fillOpacity={1}
        fontSize={11}
        fontWeight={600}
      >
        {label}
      </text>
      {hasClose && (
        <g
          role="button"
          aria-label={dismissLabel}
          className="chart-flag-dismiss"
          style={{ cursor: 'pointer', pointerEvents: 'all' }}
          onClick={(event) => {
            event.stopPropagation();
            onDismiss!();
          }}
        >
          {dismissLabel ? <title>{dismissLabel}</title> : null}
          {/* Faint divider separating the value from the dismiss control. */}
          <line
            x1={bubbleX + labelWidth - closeZone}
            y1={bubbleY + 5}
            x2={bubbleX + labelWidth - closeZone}
            y2={bubbleY + labelHeight - 5}
            stroke="#fff"
            strokeOpacity={0.4}
            strokeWidth={1}
          />
          {/* Transparent hit area so the whole close zone is clickable. */}
          <rect
            x={bubbleX + labelWidth - closeZone}
            y={bubbleY}
            width={closeZone}
            height={labelHeight}
            fill="transparent"
          />
          <line
            x1={bubbleX + labelWidth - closeZone / 2 - 3}
            y1={bubbleY + labelHeight / 2 - 3}
            x2={bubbleX + labelWidth - closeZone / 2 + 3}
            y2={bubbleY + labelHeight / 2 + 3}
            stroke="#fff"
            strokeWidth={1.3}
            strokeLinecap="round"
            strokeOpacity={1}
          />
          <line
            x1={bubbleX + labelWidth - closeZone / 2 - 3}
            y1={bubbleY + labelHeight / 2 + 3}
            x2={bubbleX + labelWidth - closeZone / 2 + 3}
            y2={bubbleY + labelHeight / 2 - 3}
            stroke="#fff"
            strokeWidth={1.3}
            strokeLinecap="round"
            strokeOpacity={1}
          />
        </g>
      )}
    </g>
  );
}

/** SVG <defs> block providing the drop-shadow filter the flag dots reference. */
export function ChartFlagShadowFilter(): ReactElement {
  return (
    <defs>
      <filter id="chartFlagShadow" x="-20%" y="-20%" width="140%" height="140%">
        <feDropShadow dx="0" dy="1" stdDeviation="2" floodOpacity="0.3" />
      </filter>
    </defs>
  );
}

export interface MinMaxFlagIndices {
  /** Index of the first datapoint at the series maximum, or -1 when empty. */
  maxIndex: number;
  /** Index of the first datapoint at the series minimum, or -1 when empty. */
  minIndex: number;
  /**
   * Whether to draw the high/low bubbles. False for an empty or flat series,
   * where the two flags would coincide and convey nothing.
   */
  show: boolean;
}

/**
 * Locate the highest and lowest points of a chart series so the high/low
 * bubbles (see {@link renderMinMaxFlagDots}) can be pinned to them. Ties
 * resolve to the first occurrence, matching the Portfolio Value chart.
 */
export function computeMinMaxFlagIndices(
  values: readonly number[],
): MinMaxFlagIndices {
  // A gap (NaN/Infinity) is neither a high nor a low. Anchoring the running
  // indices at 0 breaks when index 0 is a gap: every `NaN > NaN` / `NaN < NaN`
  // comparison is false, so both flags stay pinned to the gap and `show`
  // (NaN !== NaN) is true, drawing callouts on a point with no value. Seed the
  // indices from the first finite point and skip the rest.
  let maxIndex = -1;
  let minIndex = -1;
  for (let i = 0; i < values.length; i++) {
    if (!Number.isFinite(values[i])) continue;
    if (maxIndex === -1 || values[i] > values[maxIndex]) maxIndex = i;
    if (minIndex === -1 || values[i] < values[minIndex]) minIndex = i;
  }
  if (maxIndex === -1 || minIndex === -1) {
    return { maxIndex: -1, minIndex: -1, show: false };
  }
  return { maxIndex, minIndex, show: values[maxIndex] !== values[minIndex] };
}

export interface MinMaxFlagDotOptions {
  /** Recharts dot x coordinate. */
  cx?: number;
  /** Recharts dot y coordinate. */
  cy?: number;
  /** Recharts datapoint index. */
  index?: number;
  /** High/low indices for the series (see {@link computeMinMaxFlagIndices}). */
  flags: MinMaxFlagIndices;
  /** Number of points in the series, used to choose each bubble's side. */
  pointCount: number;
  /** Bubble color for the maximum (e.g. chartColors.income, green). */
  highColor: string;
  /** Bubble color for the minimum (e.g. chartColors.expense, red). */
  lowColor: string;
  /** Pre-formatted label for the maximum point. */
  highLabel: string;
  /** Pre-formatted label for the minimum point. */
  lowLabel: string;
  /** When true, the high/low bubble is hidden (the user dismissed it). */
  highDismissed?: boolean;
  lowDismissed?: boolean;
  /** Called when the user clicks the high/low bubble's dismiss control. */
  onDismissHigh?: () => void;
  onDismissLow?: () => void;
  /** Localized title/aria label for the dismiss control. */
  dismissLabel?: string;
}

/**
 * Recharts `dot` renderer that pins a high (max, green) and low (min, red)
 * bubble to a balance/value series. A point on the chart's left half places
 * its bubble to the right and vice versa, so the callouts stay clear of the
 * plot's left/right edges and the marker -- the same scheme used by the
 * Portfolio Value chart. Every other point renders an invisible zero-radius
 * dot.
 */
export function renderMinMaxFlagDots({
  cx,
  cy,
  index,
  flags,
  pointCount,
  highColor,
  lowColor,
  highLabel,
  lowLabel,
  highDismissed,
  lowDismissed,
  onDismissHigh,
  onDismissLow,
  dismissLabel,
}: MinMaxFlagDotOptions): ReactElement {
  if (cx == null || cy == null || index == null) {
    return <circle cx={0} cy={0} r={0} fill="none" />;
  }
  // A dismissed extreme renders like any other point: an invisible dot.
  const isMax = flags.show && index === flags.maxIndex && !highDismissed;
  const isMin = flags.show && index === flags.minIndex && !lowDismissed;
  if (!isMax && !isMin) {
    return <circle key={`dot-${index}`} cx={cx} cy={cy} r={0} fill="none" />;
  }
  const isLeftHalf = index < pointCount / 2;
  return renderChartFlagDot({
    cx,
    cy,
    index,
    color: isMax ? highColor : lowColor,
    label: isMax ? highLabel : lowLabel,
    side: isLeftHalf ? 'right' : 'left',
    onDismiss: isMax ? onDismissHigh : onDismissLow,
    dismissLabel,
  });
}
