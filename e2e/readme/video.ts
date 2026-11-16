import type { Browser, BrowserContext, BrowserContextOptions, Locator, Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureSession } from './session';
import { RAW_DIR, RECORDING_DIR } from './settings';

// Recording a flow as a video: a context that is already signed in, a pointer
// the viewer can follow (Playwright draws none), and the pacing a person reading
// along needs. The pauses in these flows are the point, not a wait for the page.

/** A mouse pointer and a click ripple, drawn in the page because a recording does not capture the real one. */
const POINTER_SCRIPT = `(() => {
  const install = () => {
    if (document.getElementById('readme-pointer')) return;
    const pointer = document.createElement('div');
    pointer.id = 'readme-pointer';
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('width', '26');
    svg.setAttribute('height', '26');
    svg.setAttribute('viewBox', '0 0 22 22');
    const arrow = document.createElementNS(ns, 'path');
    arrow.setAttribute('d', 'M3 2l14 8-6 1.6L8.4 18z');
    arrow.setAttribute('fill', '#fff');
    arrow.setAttribute('stroke', '#111');
    arrow.setAttribute('stroke-width', '1.4');
    arrow.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(arrow);
    pointer.appendChild(svg);
    Object.assign(pointer.style, { position: 'fixed', left: '0', top: '0', zIndex: '2147483647', pointerEvents: 'none', transform: 'translate(-100px,-100px)', filter: 'drop-shadow(0 1px 2px rgba(0,0,0,.55))' });
    document.documentElement.appendChild(pointer);
    addEventListener('mousemove', (e) => { pointer.style.transform = 'translate(' + (e.clientX - 3) + 'px,' + (e.clientY - 2) + 'px)'; }, true);
    addEventListener('mousedown', (e) => {
      const ring = document.createElement('div');
      Object.assign(ring.style, { position: 'fixed', left: e.clientX - 16 + 'px', top: e.clientY - 16 + 'px', width: '32px', height: '32px', borderRadius: '50%', border: '3px solid rgba(96,165,250,.95)', zIndex: '2147483646', pointerEvents: 'none', transition: 'transform .45s ease-out, opacity .45s ease-out' });
      document.documentElement.appendChild(ring);
      requestAnimationFrame(() => { ring.style.transform = 'scale(1.9)'; ring.style.opacity = '0'; });
      setTimeout(() => ring.remove(), 600);
    }, true);
  };
  if (document.documentElement) install(); else addEventListener('DOMContentLoaded', install);
})();`;

/** A translucent dot under the finger, so a swipe can be seen to be a swipe. */
const TOUCH_SCRIPT = `(() => {
  const install = () => {
    if (document.getElementById('readme-touch')) return;
    const dot = document.createElement('div');
    dot.id = 'readme-touch';
    Object.assign(dot.style, { position: 'fixed', left: '0', top: '0', width: '44px', height: '44px', borderRadius: '50%', background: 'rgba(96,165,250,.45)', border: '2px solid rgba(147,197,253,.95)', zIndex: '2147483647', pointerEvents: 'none', opacity: '0', transition: 'opacity .15s' });
    document.documentElement.appendChild(dot);
    const place = (t) => { dot.style.transform = 'translate(' + (t.clientX - 22) + 'px,' + (t.clientY - 22) + 'px)'; };
    addEventListener('touchstart', (e) => { place(e.touches[0]); dot.style.opacity = '1'; }, true);
    addEventListener('touchmove', (e) => { place(e.touches[0]); }, true);
    addEventListener('touchend', () => { dot.style.opacity = '0'; }, true);
    addEventListener('touchcancel', () => { dot.style.opacity = '0'; }, true);
  };
  if (document.documentElement) install(); else addEventListener('DOMContentLoaded', install);
})();`;

export interface Recording {
  name: string;
  context: BrowserContext;
  page: Page;
  startedAt: number;
  readyAt: number | null;
}

/**
 * Open a signed-in context that records a video. The session is made in a
 * context without one, so the recording never shows a login screen; what the
 * page shows before the first flow starts is trimmed by `markReady`.
 */
export async function startRecording(
  browser: Browser,
  name: string,
  options: BrowserContextOptions & { size: { width: number; height: number }; touch?: boolean },
): Promise<Recording> {
  const storageState = await ensureSession(browser);
  mkdirSync(RAW_DIR, { recursive: true });
  const { size, touch, ...contextOptions } = options;
  const context = await browser.newContext({
    ...contextOptions,
    storageState,
    recordVideo: { dir: RAW_DIR, size },
  });
  await context.addInitScript(touch ? TOUCH_SCRIPT : POINTER_SCRIPT);
  const startedAt = Date.now();
  const page = await context.newPage();
  return { name, context, page, startedAt, readyAt: null };
}

/** The flow starts now: everything recorded before this is trimmed from the GIF. */
export function markReady(recording: Recording): void {
  recording.readyAt = Date.now();
}

/** Close the context, keep the video as `<name>.webm` and note how much of its start to cut. */
export async function finishRecording(recording: Recording): Promise<void> {
  const video = recording.page.video();
  if (!video) throw new Error('The context was not recording');
  await recording.context.close();
  await video.saveAs(join(RECORDING_DIR, `${recording.name}.webm`));
  const trimSeconds = ((recording.readyAt ?? recording.startedAt) - recording.startedAt) / 1000;
  writeFileSync(
    join(RECORDING_DIR, `${recording.name}.json`),
    JSON.stringify({ trimSeconds: Math.round(trimSeconds * 100) / 100 }),
  );
}

/** Hold still so a reader can take the screen in. */
export const pause = (page: Page, ms: number) => page.waitForTimeout(ms);

/** Glide the pointer to the middle of `target` and click it. */
export async function glideClick(page: Page, target: Locator, afterMs = 400): Promise<void> {
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (!box) throw new Error('Nothing to click: the target has no box');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 20 });
  await pause(page, 120);
  await target.click();
  await pause(page, afterMs);
}

/** Type like a person: one key at a time. */
export async function typeInto(page: Page, target: Locator, text: string, delayMs = 45): Promise<void> {
  await glideClick(page, target, 120);
  await target.pressSequentially(text, { delay: delayMs });
}

/** Scroll the window by `dy` pixels in small wheel steps, so the motion is visible. */
export async function scrollBy(page: Page, dy: number, steps = 14): Promise<void> {
  const step = dy / steps;
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, step);
    await page.waitForTimeout(28);
  }
}

/** Scroll until the top of `target` sits `gap` pixels below the top of the window. */
export async function scrollToTarget(
  page: Page,
  target: Locator,
  gap = 90,
  steps = 14,
): Promise<void> {
  const top = await target.first().evaluate((el) => el.getBoundingClientRect().top);
  await scrollBy(page, top - gap, steps);
}

/** Drag a finger across the screen with real touch events (what the swipe hooks listen for). */
export async function swipe(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
  steps = 16,
): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [from] });
    for (let i = 1; i <= steps; i++) {
      const x = from.x + ((to.x - from.x) * i) / steps;
      const y = from.y + ((to.y - from.y) * i) / steps;
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] });
      await page.waitForTimeout(24);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } finally {
    await cdp.detach();
  }
}
