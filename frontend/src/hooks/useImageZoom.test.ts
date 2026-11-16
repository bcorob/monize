import { describe, it, expect, vi } from 'vitest';
import { act, renderHook } from '@/test/render';

import { useImageZoom, type ImageZoom } from './useImageZoom';

const WIDTH = 200;
const HEIGHT = 100;

/** A pointer event whose frame sits at the viewport origin. */
function makeEvent(
  overrides: Partial<{ clientX: number; clientY: number; pointerId: number }> = {},
) {
  const capture = { held: new Set<number>() };
  return {
    clientX: overrides.clientX ?? 0,
    clientY: overrides.clientY ?? 0,
    pointerId: overrides.pointerId ?? 1,
    preventDefault: vi.fn(),
    currentTarget: {
      getBoundingClientRect: () => ({ left: 0, top: 0, width: WIDTH, height: HEIGHT }),
      setPointerCapture: (id: number) => capture.held.add(id),
      releasePointerCapture: (id: number) => capture.held.delete(id),
      hasPointerCapture: (id: number) => capture.held.has(id),
    },
  } as never;
}

/** Bind the container ref to a real element whose frame sits at the origin. */
function attachFrame(current: ImageZoom): HTMLElement {
  const el = document.createElement('div');
  el.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: WIDTH, height: HEIGHT }) as DOMRect;
  act(() => current.containerRef(el));
  return el;
}

/** Dispatch a native, non-passive wheel notch on the bound element. */
function wheel(el: HTMLElement, deltaY: number, clientX = 0, clientY = 0) {
  act(() => {
    el.dispatchEvent(
      new WheelEvent('wheel', { deltaY, clientX, clientY, cancelable: true, bubbles: true }),
    );
  });
}

function setup() {
  return renderHook(() => useImageZoom(WIDTH, HEIGHT));
}

describe('useImageZoom', () => {
  it('starts unmagnified', () => {
    const { result } = setup();
    expect(result.current.scale).toBe(1);
    expect(result.current.zoomed).toBe(false);
    expect(result.current.contentStyle.transform).toContain('scale(1)');
  });

  it('magnifies on a wheel up and shrinks back to 1x on wheel down', () => {
    const { result } = setup();
    const el = attachFrame(result.current);

    wheel(el, -1);
    expect(result.current.scale).toBeGreaterThan(1);
    expect(result.current.zoomed).toBe(true);

    // Enough wheel-down snaps back to exactly 1x with the transform reset.
    for (let i = 0; i < 10; i++) wheel(el, 1);
    expect(result.current.scale).toBe(1);
    expect(result.current.contentStyle.transform).toBe(
      'translate(0px, 0px) scale(1)',
    );
  });

  it('binds the wheel listener as non-passive so it can suppress the scroll', () => {
    const { result } = setup();
    const el = attachFrame(result.current);
    const event = new WheelEvent('wheel', { deltaY: -1, cancelable: true, bubbles: true });
    act(() => el.dispatchEvent(event));
    // preventDefault took effect -- a passive listener could not have cancelled.
    expect(event.defaultPrevented).toBe(true);
  });

  it('toggles magnification on a double tap and back again', () => {
    const { result } = setup();
    const tap = () =>
      act(() =>
        result.current.containerProps.onPointerDown(makeEvent({ clientX: 100, clientY: 50 })),
      );

    tap();
    tap();
    expect(result.current.scale).toBeGreaterThan(1);

    tap();
    tap();
    expect(result.current.scale).toBe(1);
  });

  it('reset returns to 1x', () => {
    const { result } = setup();
    const el = attachFrame(result.current);
    wheel(el, -1);
    expect(result.current.zoomed).toBe(true);

    act(() => result.current.reset());
    expect(result.current.scale).toBe(1);
    expect(result.current.zoomed).toBe(false);
  });

  it('pans only while magnified, and never past the edge', () => {
    const { result } = setup();
    const el = attachFrame(result.current);

    // At 1x a one-finger drag does nothing: the offset stays put so an overlay
    // owns it. Released after, so the finger does not linger into the next part.
    act(() =>
      result.current.containerProps.onPointerDown(makeEvent({ pointerId: 1, clientX: 100, clientY: 50 })),
    );
    act(() =>
      result.current.containerProps.onPointerMove(makeEvent({ pointerId: 1, clientX: 40, clientY: 50 })),
    );
    expect(result.current.contentStyle.transform).toContain('translate(0px, 0px)');
    act(() =>
      result.current.containerProps.onPointerUp(makeEvent({ pointerId: 1, clientX: 40, clientY: 50 })),
    );

    // Magnify, then drag from a point well clear of the first (so it is not read
    // as a double tap): the image pans, clamped so it still covers the frame.
    for (let i = 0; i < 6; i++) wheel(el, -1, 10, 10);
    const scale = result.current.scale;
    act(() =>
      result.current.containerProps.onPointerDown(makeEvent({ pointerId: 2, clientX: 10, clientY: 90 })),
    );
    act(() =>
      result.current.containerProps.onPointerMove(makeEvent({ pointerId: 2, clientX: 300, clientY: 90 })),
    );
    // Dragging right cannot pull the left edge past 0.
    const match = /translate\((-?\d+(?:\.\d+)?)px, (-?\d+(?:\.\d+)?)px\)/.exec(
      result.current.contentStyle.transform as string,
    );
    const x = Number(match![1]);
    expect(x).toBeLessThanOrEqual(0);
    expect(x).toBeGreaterThanOrEqual(WIDTH - scale * WIDTH);
  });

  it('magnifies on a two-finger pinch that spreads', () => {
    const { result } = setup();

    // Two fingers down, 20px apart: the pinch begins without moving anything.
    act(() => {
      result.current.containerProps.onPointerDown(
        makeEvent({ pointerId: 1, clientX: 90, clientY: 50 }),
      );
      result.current.containerProps.onPointerDown(
        makeEvent({ pointerId: 2, clientX: 110, clientY: 50 }),
      );
    });
    expect(result.current.scale).toBe(1);

    // Spread to 60px apart -- a factor of three.
    act(() =>
      result.current.containerProps.onPointerMove(
        makeEvent({ pointerId: 2, clientX: 150, clientY: 50 }),
      ),
    );
    expect(result.current.scale).toBeGreaterThan(1);

    // Lifting a finger ends the pinch; the magnification stays.
    act(() => {
      result.current.containerProps.onPointerUp(makeEvent({ pointerId: 2, clientX: 150, clientY: 50 }));
      result.current.containerProps.onPointerUp(makeEvent({ pointerId: 1, clientX: 90, clientY: 50 }));
    });
    expect(result.current.zoomed).toBe(true);
  });
});
