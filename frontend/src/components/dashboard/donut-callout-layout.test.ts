import { describe, it, expect } from 'vitest';
import {
  CalloutBox,
  CalloutPoint,
  CalloutLayout,
  DEFAULT_CALLOUT_OPTIONS,
  layoutCallouts,
  sliceMidAngles,
} from './donut-callout-layout';

const TEN = [500, 320, 240, 180, 120, 90, 60, 40, 25, 10];

function overlaps(a: CalloutBox, b: CalloutBox): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** Shortest distance from `c` to the segment from `a` to `b`. */
function distanceToSegment(c: CalloutPoint, a: CalloutPoint, b: CalloutPoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((c.x - a.x) * dx + (c.y - a.y) * dy) / lengthSq));
  return Math.hypot(a.x + t * dx - c.x, a.y + t * dy - c.y);
}

function expectWellFormed(layout: CalloutLayout, width: number, height: number) {
  const boxes = layout.callouts.map((c) => c.box);
  for (const box of boxes) {
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    expect(box.y + box.height).toBeLessThanOrEqual(height);
    // Clear of the donut, horizontally.
    const nearest = Math.min(Math.abs(box.x - layout.cx), Math.abs(box.x + box.width - layout.cx));
    expect(nearest).toBeGreaterThan(layout.outerRadius);
  }
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      expect(overlaps(boxes[i], boxes[j]), `boxes ${i} and ${j} overlap`).toBe(false);
    }
  }
  const centre = { x: layout.cx, y: layout.cy };
  for (const callout of layout.callouts) {
    // No leader line crosses the donut.
    for (let i = 1; i < callout.line.length; i++) {
      expect(
        distanceToSegment(centre, callout.line[i - 1], callout.line[i]),
        `line ${callout.index} segment ${i} crosses the donut`,
      ).toBeGreaterThan(layout.outerRadius);
    }
    for (const point of callout.line) {
      expect(point.x).toBeGreaterThanOrEqual(0);
      expect(point.x).toBeLessThanOrEqual(width);
      expect(point.y).toBeGreaterThanOrEqual(0);
      expect(point.y).toBeLessThanOrEqual(height);
    }
  }
}

describe('sliceMidAngles', () => {
  it('matches the way Recharts spreads slices with padding between them', () => {
    // Two equal slices over 360 with 2 degrees of padding after each: 178 each.
    expect(sliceMidAngles([1, 1], { paddingAngle: 2, startAngle: 0, endAngle: 360 })).toEqual([89, 269]);
  });

  it('drops the padding for a single slice', () => {
    expect(sliceMidAngles([5], { paddingAngle: 2, startAngle: 0, endAngle: 360 })).toEqual([180]);
  });

  it('follows a clockwise sweep', () => {
    expect(sliceMidAngles([1, 1], { paddingAngle: 0, startAngle: 90, endAngle: -270 })).toEqual([0, -180]);
  });
});

describe('layoutCallouts', () => {
  it.each([
    [360, 260],
    [480, 260],
    [640, 300],
    [1100, 420],
  ])('keeps ten boxes apart and inside a %ix%i area', (width, height) => {
    const layout = layoutCallouts(TEN, width, height);
    expect(layout).not.toBeNull();
    expect(layout!.callouts).toHaveLength(10);
    expectWellFormed(layout!, width, height);
  });

  it('balances one oversized column onto the other side', () => {
    // A single dominant slice pushes the nine small ones into one half, and
    // 220px holds five boxes a column.
    const lopsided = [5000, 10, 10, 10, 10, 10, 10, 10, 10, 10];
    const layout = layoutCallouts(lopsided, 480, 220)!;
    expect(layout).not.toBeNull();
    const perSide = (side: 'left' | 'right') => layout.callouts.filter((c) => c.side === side).length;
    expect(perSide('left')).toBe(5);
    expect(perSide('right')).toBe(5);
    // The slices handed across reach their boxes around the donut, not over it.
    expect(layout.callouts.some((c) => c.line.length > 3)).toBe(true);
    expectWellFormed(layout, 480, 220);
  });

  it('keeps each box beside its slice when there is room', () => {
    const layout = layoutCallouts([1, 1], 480, 260)!;
    // The first slice sits at the top right, the second at the bottom left.
    const [first, second] = layout.callouts;
    expect(first.side).toBe('right');
    expect(second.side).toBe('left');
    expect(first.box.y + first.box.height / 2).toBeLessThan(layout.cy);
    expect(second.box.y + second.box.height / 2).toBeGreaterThan(layout.cy);
    // Nothing to route around: each line runs straight from slice to box.
    expect(layout.callouts.map((c) => c.line.length)).toEqual([3, 3]);
    expectWellFormed(layout, 480, 260);
  });

  it.each([
    ['one dominant', [9000, 5, 5, 5, 5, 5, 5, 5, 5, 5]],
    ['two dominant', [4000, 3500, 10, 10, 10, 10, 10, 10, 10, 10]],
    ['geometric', [512, 256, 128, 64, 32, 16, 8, 4, 2, 1]],
    ['even', [1, 1, 1, 1, 1, 1, 1, 1, 1, 1]],
    ['small tail first half', [10, 10, 10, 10, 10, 3000, 2000, 1000, 500, 250]],
  ])('keeps a %s distribution well formed at every size', (_name, values) => {
    for (const [width, height] of [
      [340, 220],
      [360, 260],
      [480, 260],
      [640, 300],
      [1100, 420],
    ]) {
      const layout = layoutCallouts(values, width, height);
      if (layout) expectWellFormed(layout, width, height);
    }
  });

  it('starts each leader line on its own slice and ends it on its box', () => {
    const layout = layoutCallouts(TEN, 480, 260)!;
    for (const callout of layout.callouts) {
      const anchor = callout.line[0];
      const end = callout.line[callout.line.length - 1];
      const fromCentre = Math.hypot(anchor.x - layout.cx, anchor.y - layout.cy);
      expect(fromCentre).toBeCloseTo(layout.outerRadius + 2, 5);
      const edge = callout.side === 'left' ? callout.box.x + callout.box.width : callout.box.x;
      expect(end.x).toBe(edge);
      expect(end.y).toBe(callout.box.y + callout.box.height / 2);
    }
  });

  it('refuses an area too narrow for readable boxes', () => {
    expect(layoutCallouts(TEN, 300, 260)).toBeNull();
  });

  it('refuses an area too short for ten boxes', () => {
    expect(layoutCallouts(TEN, 640, 200)).toBeNull();
    // Four fit the same height.
    expect(layoutCallouts(TEN.slice(0, 4), 640, 200)).not.toBeNull();
  });

  it('refuses nothing to draw or an unmeasured area', () => {
    expect(layoutCallouts([], 480, 260)).toBeNull();
    expect(layoutCallouts(TEN, 0, 0)).toBeNull();
  });

  it('caps the box width and centres the donut in a wide area', () => {
    const layout = layoutCallouts(TEN, 1100, 420)!;
    expect(layout.callouts[0].box.width).toBe(DEFAULT_CALLOUT_OPTIONS.maxBoxWidth);
    expect(layout.cx).toBe(550);
    expect(layout.innerRadius).toBeCloseTo(layout.outerRadius * DEFAULT_CALLOUT_OPTIONS.innerRadiusRatio);
  });
});
