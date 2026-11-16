/**
 * Geometry for a dashboard donut's callout view (Top Recurring Expenses,
 * Expenses by Category): a donut in the middle, one labelled box per slice in a
 * column on either side, and a leader line from each slice to its box.
 *
 * Pure so the guarantees the view makes can be tested without a browser: no two
 * boxes overlap, nothing leaves the measured area, and when the area is too
 * small to keep both promises the layout is `null` and the caller draws the
 * legend instead of a cramped chart.
 */

export interface CalloutPoint {
  x: number;
  y: number;
}

export interface CalloutBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CalloutPlacement {
  /** Index of the slice in the values passed in. */
  index: number;
  side: 'left' | 'right';
  box: CalloutBox;
  /**
   * The leader line: on the slice's rim, out along its middle, then to the
   * box -- directly, or around the donut where the direct line would cross it.
   */
  line: CalloutPoint[];
}

export interface CalloutLayout {
  cx: number;
  cy: number;
  innerRadius: number;
  outerRadius: number;
  /** In slice order. */
  callouts: CalloutPlacement[];
}

export interface CalloutLayoutOptions {
  /** Height of one box. */
  boxHeight: number;
  /** Vertical space between two boxes in a column. */
  boxGap: number;
  /** Space kept clear inside the measured area's edges. */
  padding: number;
  /** Horizontal space between the donut's rim and a box column. */
  leaderGap: number;
  /** How far the leader line runs out along the slice before turning. */
  elbow: number;
  minBoxWidth: number;
  maxBoxWidth: number;
  /** The smallest donut worth drawing. */
  minRadius: number;
  /** The donut's hole as a share of its radius. */
  innerRadiusRatio: number;
  /** Recharts' `paddingAngle`, `startAngle` and `endAngle` for the same Pie. */
  paddingAngle: number;
  startAngle: number;
  endAngle: number;
}

export const DEFAULT_CALLOUT_OPTIONS: CalloutLayoutOptions = {
  boxHeight: 36,
  boxGap: 6,
  padding: 4,
  leaderGap: 28,
  elbow: 10,
  minBoxWidth: 76,
  maxBoxWidth: 160,
  minRadius: 44,
  innerRadiusRatio: 0.55,
  paddingAngle: 2,
  startAngle: 0,
  endAngle: 360,
};

const RADIAN = Math.PI / 180;

/** Recharts' polar convention: angles in degrees, counter-clockwise from 3 o'clock. */
function polarToCartesian(cx: number, cy: number, radius: number, angle: number): CalloutPoint {
  return {
    x: cx + Math.cos(-angle * RADIAN) * radius,
    y: cy + Math.sin(-angle * RADIAN) * radius,
  };
}

/**
 * The middle angle of each slice, computed the way Recharts' Pie lays its
 * sectors out (padding between non-zero slices, the rest shared by value), so
 * a leader line starts on the slice it names.
 */
export function sliceMidAngles(
  values: readonly number[],
  options: Pick<CalloutLayoutOptions, 'paddingAngle' | 'startAngle' | 'endAngle'>,
): number[] {
  const { startAngle, endAngle } = options;
  const paddingAngle = values.length <= 1 ? 0 : options.paddingAngle;
  const delta = Math.max(-360, Math.min(360, endAngle - startAngle));
  const sign = Math.sign(delta) || 1;
  const absDelta = Math.abs(delta);
  const sum = values.reduce((acc, v) => acc + Math.abs(v), 0);
  const nonZero = values.filter((v) => v !== 0).length;
  const totalPadding = (absDelta >= 360 ? nonZero : nonZero - 1) * paddingAngle;
  const realTotal = absDelta - totalPadding;

  const mids: number[] = [];
  let prevEnd = startAngle;
  values.forEach((value, i) => {
    const percent = sum > 0 ? Math.abs(value) / sum : 0;
    const start = i > 0 ? prevEnd + sign * paddingAngle * (value !== 0 ? 1 : 0) : startAngle;
    const end = start + sign * percent * realTotal;
    mids.push((start + end) / 2);
    prevEnd = end;
  });
  return mids;
}

interface Pending {
  index: number;
  angle: number;
  anchor: CalloutPoint;
  elbow: CalloutPoint;
}

/**
 * Stack one column's boxes: each as close to its own slice as it can sit,
 * in slice-height order, never overlapping and never past either edge. The
 * caller guarantees the column fits.
 */
function stackColumn(items: Pending[], top: number, bottom: number, step: number, boxHeight: number): number[] {
  const ys = items.map((item) =>
    Math.min(Math.max(item.elbow.y - boxHeight / 2, top), bottom - boxHeight),
  );
  // Push down past the box above...
  for (let i = 1; i < ys.length; i++) {
    ys[i] = Math.max(ys[i], ys[i - 1] + step);
  }
  // ...then back up from the bottom edge.
  for (let i = ys.length - 1; i >= 0; i--) {
    const limit = i === ys.length - 1 ? bottom - boxHeight : ys[i + 1] - step;
    ys[i] = Math.min(ys[i], limit);
  }
  return ys;
}

/** Shortest distance from `c` to the segment from `a` to `b`. */
function distanceToSegment(c: CalloutPoint, a: CalloutPoint, b: CalloutPoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((c.x - a.x) * dx + (c.y - a.y) * dy) / lengthSq));
  return Math.hypot(a.x + t * dx - c.x, a.y + t * dy - c.y);
}

/**
 * The leader line from a slice to its box. The direct line from the elbow can
 * cut across the donut: a slice handed to the other column, or one whose box
 * was stacked far from it. That line is routed around instead -- out past the
 * rim at the elbow's x (moving away from the centre keeps it outside), across
 * above or below the donut, down the gap beside the box's column, and in.
 */
function leaderLine(
  item: Pending,
  end: CalloutPoint,
  side: 'left' | 'right',
  geometry: { cx: number; cy: number; outerRadius: number; elbow: number; leaderGap: number },
): CalloutPoint[] {
  const { cx, cy, outerRadius, elbow, leaderGap } = geometry;
  if (distanceToSegment({ x: cx, y: cy }, item.elbow, end) > outerRadius + 1) {
    return [item.anchor, item.elbow, end];
  }
  const clearY = item.elbow.y <= cy ? cy - outerRadius - elbow : cy + outerRadius + elbow;
  const gapX = side === 'left' ? cx - outerRadius - leaderGap / 2 : cx + outerRadius + leaderGap / 2;
  return [
    item.anchor,
    item.elbow,
    { x: item.elbow.x, y: clearY },
    { x: gapX, y: clearY },
    { x: gapX, y: end.y },
    end,
  ];
}

/**
 * Lay out a donut with a callout box per value inside a `width` x `height`
 * area, or `null` when the boxes cannot all fit at a readable size.
 */
export function layoutCallouts(
  values: readonly number[],
  width: number,
  height: number,
  overrides: Partial<CalloutLayoutOptions> = {},
): CalloutLayout | null {
  const options = { ...DEFAULT_CALLOUT_OPTIONS, ...overrides };
  const { boxHeight, boxGap, padding, leaderGap, elbow } = options;
  if (values.length === 0 || width <= 0 || height <= 0) return null;

  const radiusByHeight = height / 2 - padding - elbow;
  if (radiusByHeight < options.minRadius) return null;

  // The boxes take what the smallest donut leaves of the width, up to a cap;
  // the donut then grows into whatever is left over.
  const spareWidth = width - 2 * padding - 2 * leaderGap;
  const boxWidth = Math.min(options.maxBoxWidth, Math.floor((spareWidth - 2 * options.minRadius) / 2));
  if (boxWidth < options.minBoxWidth) return null;
  const outerRadius = Math.min(radiusByHeight, (spareWidth - 2 * boxWidth) / 2);

  const top = padding;
  const bottom = height - padding;
  const step = boxHeight + boxGap;
  const perColumn = Math.floor((bottom - top + boxGap) / step);
  if (values.length > 2 * perColumn) return null;

  const cx = width / 2;
  const cy = height / 2;
  const angles = sliceMidAngles(values, options);
  const pending: Pending[] = angles.map((angle, index) => ({
    index,
    angle,
    anchor: polarToCartesian(cx, cy, outerRadius + 2, angle),
    elbow: polarToCartesian(cx, cy, outerRadius + elbow, angle),
  }));

  const right = pending.filter((p) => Math.cos(p.angle * RADIAN) >= 0);
  const left = pending.filter((p) => Math.cos(p.angle * RADIAN) < 0);
  // A column with more boxes than it holds hands its most vertical slices,
  // the ones nearest the other column, across.
  const rebalance = (from: Pending[], to: Pending[]) => {
    while (from.length > perColumn) {
      let pick = 0;
      for (let i = 1; i < from.length; i++) {
        if (Math.abs(Math.cos(from[i].angle * RADIAN)) < Math.abs(Math.cos(from[pick].angle * RADIAN))) {
          pick = i;
        }
      }
      to.push(...from.splice(pick, 1));
    }
  };
  rebalance(right, left);
  rebalance(left, right);

  const leftX = cx - outerRadius - leaderGap - boxWidth;
  const rightX = cx + outerRadius + leaderGap;
  const placements: CalloutPlacement[] = [];
  for (const [side, column] of [
    ['left', left],
    ['right', right],
  ] as const) {
    const ordered = [...column].sort((a, b) => a.elbow.y - b.elbow.y);
    const ys = stackColumn(ordered, top, bottom, step, boxHeight);
    ordered.forEach((item, i) => {
      const box = { x: side === 'left' ? leftX : rightX, y: ys[i], width: boxWidth, height: boxHeight };
      const end = { x: side === 'left' ? box.x + box.width : box.x, y: box.y + boxHeight / 2 };
      const line = leaderLine(item, end, side, { cx, cy, outerRadius, elbow, leaderGap });
      placements.push({ index: item.index, side, box, line });
    });
  }

  return {
    cx,
    cy,
    innerRadius: outerRadius * options.innerRadiusRatio,
    outerRadius,
    callouts: placements.sort((a, b) => a.index - b.index),
  };
}
