'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent } from 'react';
import { clamp } from '@/lib/clamp';

/**
 * Pan and zoom for a fixed-size preview, so fine print can be checked before a
 * scan is kept.
 *
 * The image is drawn at the size the dialog gives it and this magnifies that
 * box rather than re-rendering at a higher resolution: it is a viewer control,
 * not a second pipeline, so it never changes the pixels that get stored.
 *
 * The content is transformed from its top-left corner, and the translation is
 * always clamped so the magnified image still covers the frame -- a pan can
 * never expose a strip of background, which reads as the picture having slipped.
 *
 * Gestures are the ones a phone gallery uses: a two-finger pinch zooms and pans
 * at once, a double tap (or double click) toggles magnification at the point
 * touched, a one-finger drag pans while magnified, and the wheel zooms on a
 * desktop. A single-pointer drag does nothing at 1x, so a caller drawing its
 * own handles over the image keeps them.
 */

/** How far a double tap magnifies, and the ceiling a pinch or wheel can reach. */
const DOUBLE_TAP_SCALE = 2.5;
const MAX_SCALE = 4;
/** One wheel notch. */
const WHEEL_STEP = 1.15;
/** Two taps closer than this in time, and nearer than the slop, are a double. */
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_SLOP = 24;

interface Transform {
  scale: number;
  x: number;
  y: number;
}

const IDENTITY: Transform = { scale: 1, x: 0, y: 0 };

export interface ImageZoom {
  /** The current magnification. 1 means untouched. */
  scale: number;
  /** Whether the image is magnified, so a caller can suspend its own gestures. */
  zoomed: boolean;
  /** Return to 1x and forget any gesture in progress. Call it when the shown
   *  image is replaced. */
  reset: () => void;
  /** Ref for the fixed-size frame: binds the non-passive wheel listener. */
  containerRef: (node: HTMLElement | null) => void;
  /** Spread on the fixed-size frame: the pointer handlers and clipping. */
  containerProps: {
    onPointerDown: (event: PointerEvent) => void;
    onPointerMove: (event: PointerEvent) => void;
    onPointerUp: (event: PointerEvent) => void;
    onPointerCancel: (event: PointerEvent) => void;
    style: CSSProperties;
  };
  /** Spread on the element holding the image (and any overlay): the transform. */
  contentStyle: CSSProperties;
}

/**
 * Clamp a translation so the scaled content still covers the `size`-wide frame.
 * At scale s the content is `s * size` wide, so the offset runs from
 * `size - s*size` (right/bottom edge flush) to `0` (left/top edge flush).
 */
function clampOffset(offset: number, scale: number, size: number): number {
  return clamp(offset, size - scale * size, 0);
}

/** Magnify to `nextScale` while keeping the frame point (px, py) fixed. */
function zoomToPoint(
  current: Transform,
  nextScale: number,
  px: number,
  py: number,
  width: number,
  height: number,
): Transform {
  const scale = clamp(nextScale, 1, MAX_SCALE);
  if (scale === 1) return IDENTITY;
  // The content point under the cursor stays under it: x2 = px - s*(px - x)/s0.
  const x = px - (scale * (px - current.x)) / current.scale;
  const y = py - (scale * (py - current.y)) / current.scale;
  return {
    scale,
    x: clampOffset(x, scale, width),
    y: clampOffset(y, scale, height),
  };
}

interface PinchAnchor {
  dist: number;
  midX: number;
  midY: number;
}

/** Distance and frame-relative midpoint of the two live pointers. */
function pinchOf(
  points: { x: number; y: number }[],
  left: number,
  top: number,
): PinchAnchor {
  const [a, b] = points;
  return {
    dist: Math.hypot(a.x - b.x, a.y - b.y),
    midX: (a.x + b.x) / 2 - left,
    midY: (a.y + b.y) / 2 - top,
  };
}

/** `width` and `height` are the frame's size in CSS pixels. */
export function useImageZoom(width: number, height: number): ImageZoom {
  const [transform, setTransform] = useState<Transform>(IDENTITY);
  // Whether the image is magnified, kept in a ref so the pointer-down handler
  // can decide "pan or leave the drag to the overlay" without a stale closure.
  // Updated in an effect rather than during render (the refs lint rule); every
  // pixel computation below reads the live value through a state updater.
  const zoomedRef = useRef(false);
  useEffect(() => {
    zoomedRef.current = transform.scale > 1;
  }, [transform.scale]);

  const lastTapRef = useRef<{ time: number; x: number; y: number } | null>(null);
  const panRef = useRef<{ x: number; y: number } | null>(null);
  // Every pointer currently down on the frame, in client coordinates, so two of
  // them can be read together as a pinch.
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const pinchRef = useRef<PinchAnchor | null>(null);

  const reset = useCallback(() => {
    // Forget any half-finished gesture too, so a pinch or pan interrupted by the
    // dialog closing cannot leak a stale pointer into the next scan.
    pointersRef.current.clear();
    pinchRef.current = null;
    panRef.current = null;
    lastTapRef.current = null;
    setTransform(IDENTITY);
  }, []);

  const pointInFrame = (event: PointerEvent) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { px: event.clientX - rect.left, py: event.clientY - rect.top };
  };

  // The wheel listener is native and non-passive. React registers wheel as a
  // passive root listener, so preventDefault in a synthetic onWheel is ignored
  // and the page scrolls while zooming; binding it ourselves lets the zoom
  // suppress the scroll (the same reason useSwipeNavigation binds touchmove).
  const wheelCleanupRef = useRef<(() => void) | null>(null);
  const containerRef = useCallback(
    (node: HTMLElement | null) => {
      wheelCleanupRef.current?.();
      wheelCleanupRef.current = null;
      if (!node) return;
      const handler = (event: WheelEvent) => {
        event.preventDefault();
        const rect = node.getBoundingClientRect();
        const px = event.clientX - rect.left;
        const py = event.clientY - rect.top;
        const factor = event.deltaY < 0 ? WHEEL_STEP : 1 / WHEEL_STEP;
        setTransform((current) =>
          zoomToPoint(current, current.scale * factor, px, py, width, height),
        );
      };
      node.addEventListener('wheel', handler, { passive: false });
      wheelCleanupRef.current = () =>
        node.removeEventListener('wheel', handler);
    },
    [width, height],
  );

  const onPointerDown = useCallback(
    (event: PointerEvent) => {
      const pointers = pointersRef.current;
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

      // Second finger down: a pinch. Capture both so their moves arrive here
      // even if one began on an overlay handle, and drop any tap or pan guess.
      if (pointers.size === 2) {
        lastTapRef.current = null;
        panRef.current = null;
        const rect = event.currentTarget.getBoundingClientRect();
        pinchRef.current = pinchOf([...pointers.values()], rect.left, rect.top);
        for (const id of pointers.keys()) {
          event.currentTarget.setPointerCapture(id);
        }
        return;
      }
      if (pointers.size !== 1) return;

      const { px, py } = pointInFrame(event);
      const last = lastTapRef.current;
      const now = Date.now();
      const isDoubleTap =
        last !== null &&
        now - last.time < DOUBLE_TAP_MS &&
        Math.abs(px - last.x) < DOUBLE_TAP_SLOP &&
        Math.abs(py - last.y) < DOUBLE_TAP_SLOP;

      if (isDoubleTap) {
        lastTapRef.current = null;
        setTransform((current) =>
          current.scale > 1
            ? IDENTITY
            : zoomToPoint(current, DOUBLE_TAP_SCALE, px, py, width, height),
        );
        return;
      }
      lastTapRef.current = { time: now, x: px, y: py };

      // Only a magnified image pans on one finger; at 1x the drag belongs to
      // whatever the caller draws over the image (the corner handles).
      if (zoomedRef.current) {
        panRef.current = { x: event.clientX, y: event.clientY };
        event.currentTarget.setPointerCapture(event.pointerId);
      }
    },
    [width, height],
  );

  const onPointerMove = useCallback(
    (event: PointerEvent) => {
      const pointers = pointersRef.current;
      if (pointers.has(event.pointerId)) {
        pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      }

      // A pinch drives both scale and position from the two fingers together.
      const anchor = pinchRef.current;
      if (anchor && pointers.size >= 2) {
        const rect = event.currentTarget.getBoundingClientRect();
        const next = pinchOf([...pointers.values()], rect.left, rect.top);
        if (anchor.dist > 0) {
          const factor = next.dist / anchor.dist;
          const dx = next.midX - anchor.midX;
          const dy = next.midY - anchor.midY;
          setTransform((current) => {
            const zoomed = zoomToPoint(
              current,
              current.scale * factor,
              next.midX,
              next.midY,
              width,
              height,
            );
            // The pinch also slides under the fingers.
            return {
              scale: zoomed.scale,
              x: clampOffset(zoomed.x + dx, zoomed.scale, width),
              y: clampOffset(zoomed.y + dy, zoomed.scale, height),
            };
          });
        }
        pinchRef.current = next;
        return;
      }

      const pan = panRef.current;
      if (!pan) return;
      const dx = event.clientX - pan.x;
      const dy = event.clientY - pan.y;
      panRef.current = { x: event.clientX, y: event.clientY };
      setTransform((current) => ({
        scale: current.scale,
        x: clampOffset(current.x + dx, current.scale, width),
        y: clampOffset(current.y + dy, current.scale, height),
      }));
    },
    [width, height],
  );

  const endPointer = useCallback((event: PointerEvent) => {
    const pointers = pointersRef.current;
    pointers.delete(event.pointerId);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    // A pinch needs two fingers; with fewer, it is over. The remaining finger
    // does not silently become a pan.
    if (pointers.size < 2) pinchRef.current = null;
    if (pointers.size === 0) panRef.current = null;
  }, []);

  const contentStyle = useMemo<CSSProperties>(
    () => ({
      transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`,
      transformOrigin: '0 0',
      willChange: transform.scale > 1 ? 'transform' : undefined,
    }),
    [transform],
  );

  const containerStyle = useMemo<CSSProperties>(
    () => ({
      // Clip and swallow touch scrolling only while magnified. At 1x an overlay
      // may extend past the image on purpose (the corner handles' targets do),
      // and a swipe over the preview should still scroll a tall dialog.
      overflow: transform.scale > 1 ? 'hidden' : 'visible',
      touchAction: transform.scale > 1 ? 'none' : undefined,
      cursor: transform.scale > 1 ? 'grab' : undefined,
    }),
    [transform.scale],
  );

  return {
    scale: transform.scale,
    zoomed: transform.scale > 1,
    reset,
    containerRef,
    containerProps: {
      onPointerDown,
      onPointerMove,
      onPointerUp: endPointer,
      onPointerCancel: endPointer,
      style: containerStyle,
    },
    contentStyle,
  };
}
