'use client';

import { useCallback, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';

import {
  clampToFrame,
  isConvexQuad,
} from '@/lib/document-scanner/document-scan-geometry';
import type { Point, Quad } from '@/lib/document-scanner/document-scan.types';

/**
 * The four draggable corners over the original photo.
 *
 * Detection is right most of the time and wrong in exactly the situations a
 * user cannot fix by retaking -- a patterned tablecloth, a document on a page
 * of the same colour. Dragging a corner is the repair, and it is cheaper than
 * asking somebody to photograph a receipt again.
 *
 * Drawn as an SVG overlay in DISPLAY coordinates while the quad it edits is in
 * SOURCE pixels: the photo is shown scaled to fit a dialog, and every corner
 * the pipeline is given has to be in the image's own coordinates or the warp
 * samples the wrong region.
 */

/** How far, in source pixels, an arrow key nudges a corner. */
const NUDGE_STEP = 4;

/** The same nudge with Shift held, for crossing a large image quickly. */
const NUDGE_STEP_LARGE = 24;

/** Radius of the drawn handle, in display pixels. */
const HANDLE_RADIUS = 11;

/** The same handle while it is being dragged, so it stays visible under a thumb. */
const HANDLE_RADIUS_DRAGGING = 14;

/**
 * Radius of the invisible circle that actually takes the pointer.
 *
 * 22 gives a 44px target, the size a fingertip can be relied on to hit. The
 * drawn handle stays small: making the visible dot finger-sized would cover
 * the very corner the user is trying to place.
 */
const HANDLE_HIT_RADIUS = 22;

/**
 * How far the overlay extends beyond the photo, in display pixels.
 *
 * A detected corner usually sits ON the edge of the frame, and an overlay
 * clipped to the photo cuts its target in half -- the reason the corners were
 * hard to grab on a phone was that only the inward half of each one existed.
 * Extending by the hit radius keeps every target whole.
 */
const OVERLAY_PADDING = HANDLE_HIT_RADIUS;

export interface DocumentCornerHandlesProps {
  /** The corners being edited, in source-image pixels. */
  quad: Quad;
  /** The photo's own dimensions, which the corners are expressed in. */
  imageWidth: number;
  imageHeight: number;
  /** The size the photo is displayed at. */
  displayWidth: number;
  displayHeight: number;
  /** Called as a corner moves, so the outline follows the pointer. */
  onChange: (quad: Quad) => void;
  /** Called once, when a drag or a nudge finishes. */
  onCommit: (quad: Quad) => void;
  disabled?: boolean;
}

/** Corner order is fixed by `orderCorners`, so the labels can be too. */
const CORNER_LABEL_KEYS = [
  'scan.corners.topLeft',
  'scan.corners.topRight',
  'scan.corners.bottomRight',
  'scan.corners.bottomLeft',
] as const;

export function DocumentCornerHandles({
  quad,
  imageWidth,
  imageHeight,
  displayWidth,
  displayHeight,
  onChange,
  onCommit,
  disabled = false,
}: DocumentCornerHandlesProps) {
  const t = useTranslations('attachments');
  const svgRef = useRef<SVGSVGElement>(null);
  const [dragging, setDragging] = useState<number | null>(null);

  const scaleX = displayWidth / imageWidth;
  const scaleY = displayHeight / imageHeight;

  /** Source pixels -> display pixels. */
  const toDisplay = useCallback(
    (point: Point) => ({ x: point.x * scaleX, y: point.y * scaleY }),
    [scaleX, scaleY],
  );

  /**
   * Replace one corner, refusing a move that folds the quadrilateral.
   *
   * `getPerspectiveTransform` accepts a bow tie and returns a folded, unreadable
   * image, so the refusal happens here rather than being discovered in the
   * preview. Refusing means the handle stops moving, which reads as the drag
   * hitting a limit.
   */
  const withCorner = useCallback(
    (index: number, next: Point): Quad | null => {
      const clamped = clampToFrame(next, imageWidth, imageHeight);
      const candidate = quad.map((corner, i) =>
        i === index ? clamped : corner,
      ) as unknown as Quad;
      return isConvexQuad(candidate) ? candidate : null;
    },
    [quad, imageWidth, imageHeight],
  );

  const pointFromEvent = useCallback(
    (event: { clientX: number; clientY: number }): Point | null => {
      const svg = svgRef.current;
      if (!svg) return null;
      const rect = svg.getBoundingClientRect();
      // Guard a zero-sized box: a dialog that has not laid out yet would divide
      // by zero and send every corner to NaN.
      if (rect.width === 0 || rect.height === 0) return null;
      // The box is the photo plus `OVERLAY_PADDING` on every side, so the
      // padding comes off before the fraction means anything about the image.
      const displayX =
        ((event.clientX - rect.left) / rect.width) *
          (displayWidth + OVERLAY_PADDING * 2) -
        OVERLAY_PADDING;
      const displayY =
        ((event.clientY - rect.top) / rect.height) *
          (displayHeight + OVERLAY_PADDING * 2) -
        OVERLAY_PADDING;
      return { x: displayX / scaleX, y: displayY / scaleY };
    },
    [displayWidth, displayHeight, scaleX, scaleY],
  );

  const handlePointerDown =
    (index: number) => (event: React.PointerEvent<SVGCircleElement>) => {
      if (disabled) return;
      event.preventDefault();
      // Capture, so a fast drag that leaves the handle keeps sending moves here
      // instead of stopping the moment the pointer outruns the circle.
      event.currentTarget.setPointerCapture(event.pointerId);
      setDragging(index);
    };

  const handlePointerMove =
    (index: number) => (event: React.PointerEvent<SVGCircleElement>) => {
      if (dragging !== index) return;
      const point = pointFromEvent(event);
      if (!point) return;
      const next = withCorner(index, point);
      if (next) onChange(next);
    };

  const endDrag =
    (index: number) => (event: React.PointerEvent<SVGCircleElement>) => {
      if (dragging !== index) return;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      setDragging(null);
      // One re-warp per drag, on release: re-running the pipeline for every
      // pointermove would queue dozens of scans of the same photo.
      onCommit(quad);
    };

  const handleKeyDown =
    (index: number) => (event: React.KeyboardEvent<SVGCircleElement>) => {
      if (disabled) return;
      const step = event.shiftKey ? NUDGE_STEP_LARGE : NUDGE_STEP;
      const deltas: Record<string, Point> = {
        ArrowLeft: { x: -step, y: 0 },
        ArrowRight: { x: step, y: 0 },
        ArrowUp: { x: 0, y: -step },
        ArrowDown: { x: 0, y: step },
      };
      const delta = deltas[event.key];
      if (!delta) return;
      event.preventDefault();
      const corner = quad[index];
      const next = withCorner(index, {
        x: corner.x + delta.x,
        y: corner.y + delta.y,
      });
      if (!next) return;
      onChange(next);
      onCommit(next);
    };

  const outline = quad
    .map((corner) => {
      const point = toDisplay(corner);
      return `${point.x},${point.y}`;
    })
    .join(' ');

  return (
    <svg
      ref={svgRef}
      // Extends past the photo so a handle sitting on the frame edge is whole.
      // The SVG itself has no fill, so it intercepts nothing outside the
      // circles it draws.
      className="absolute"
      style={{
        top: -OVERLAY_PADDING,
        left: -OVERLAY_PADDING,
        width: displayWidth + OVERLAY_PADDING * 2,
        height: displayHeight + OVERLAY_PADDING * 2,
        // Without this a drag on a touch screen scrolls the dialog instead of
        // moving the corner.
        touchAction: 'none',
      }}
      viewBox={`${-OVERLAY_PADDING} ${-OVERLAY_PADDING} ${
        displayWidth + OVERLAY_PADDING * 2
      } ${displayHeight + OVERLAY_PADDING * 2}`}
      role="group"
      aria-label={t('scan.corners.label')}
    >
      <polygon
        points={outline}
        className="fill-blue-500/10 stroke-blue-500"
        strokeWidth={2}
      />
      {quad.map((corner, index) => {
        const point = toDisplay(corner);
        return (
          <g key={CORNER_LABEL_KEYS[index]}>
            {/* Drawn small so it does not hide the corner being placed... */}
            <circle
              cx={point.x}
              cy={point.y}
              r={dragging === index ? HANDLE_RADIUS_DRAGGING : HANDLE_RADIUS}
              className={
                disabled
                  ? 'fill-gray-400 stroke-white'
                  : 'fill-blue-600 stroke-white'
              }
              strokeWidth={2}
              // The transparent circle over it is what takes the pointer.
              style={{ pointerEvents: 'none' }}
            />
            {/* ...and grabbed large, so a fingertip can hit it. */}
            <circle
              cx={point.x}
              cy={point.y}
              r={HANDLE_HIT_RADIUS}
              fill="transparent"
              className={
                disabled
                  ? undefined
                  : 'cursor-grab focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-400'
              }
              role="slider"
              tabIndex={disabled ? -1 : 0}
              aria-label={t(CORNER_LABEL_KEYS[index])}
              // The corner's position is two numbers, and a slider reports one.
              // The x is reported and the label names the corner, which is what
              // makes the arrow keys discoverable at all.
              aria-valuemin={0}
              aria-valuemax={imageWidth}
              aria-valuenow={Math.round(corner.x)}
              onPointerDown={handlePointerDown(index)}
              onPointerMove={handlePointerMove(index)}
              onPointerUp={endDrag(index)}
              onPointerCancel={endDrag(index)}
              onKeyDown={handleKeyDown(index)}
            />
          </g>
        );
      })}
    </svg>
  );
}
