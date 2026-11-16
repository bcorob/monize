import { beforeAll, describe, expect, it } from 'vitest';

import {
  handleScanMessage,
  transferablesFor,
} from './document-scan-messages';
import { loadEngine } from './opencv-engine';
import { DEFAULT_QUAD, syntheticDocument } from './synthetic-document';
import type { Quad, ScanStyle } from './document-scan.types';

/**
 * What the worker does with a message, tested without a worker.
 *
 * The entry point is three lines of `postMessage` plumbing that no unit
 * environment can run, so the decisions live here: which pipeline steps a
 * request kind runs, and what a failure becomes.
 */
beforeAll(async () => {
  await loadEngine();
}, 60_000);

describe('handleScanMessage', () => {
  it('answers a scan with the detection, the enhanced image and the warnings', async () => {
    const response = await handleScanMessage({
      kind: 'scan',
      requestId: 7,
      image: syntheticDocument(),
      style: 'colour',
    });

    expect(response.kind).toBe('result');
    if (response.kind !== 'result') return;
    expect(response.requestId).toBe(7);
    expect(response.result.documentFound).toBe(true);
    expect(response.result.enhanced.width).toBeGreaterThan(0);
    expect(Array.isArray(response.result.warnings)).toBe(true);
  });

  // The user has just overruled the detection by dragging a corner; detecting
  // again would throw their correction away.
  it('keeps the corners it was given on a re-warp', async () => {
    const moved: Quad = [
      { x: 160, y: 110 },
      { x: 600, y: 170 },
      { x: 560, y: 620 },
      { x: 120, y: 540 },
    ];

    const response = await handleScanMessage({
      kind: 'rewarp',
      requestId: 9,
      image: syntheticDocument(),
      quad: moved,
      style: 'colour',
    });

    expect(response.kind).toBe('result');
    if (response.kind !== 'result') return;
    expect(response.result.quad).toEqual(moved);
    // The corners are the user's own now, so there is no detection to report
    // as having failed.
    expect(response.result.documentFound).toBe(true);
  });

  // A re-warp is the expensive path, so it must run only for the reason it
  // exists: corners that moved. Rotation is applied to the finished pixels.
  it('carries no rotation, so a turn cannot trigger the pipeline', async () => {
    const image = syntheticDocument();
    const request = {
      kind: 'rewarp' as const,
      requestId: 1,
      image,
      quad: DEFAULT_QUAD,
      style: 'colour' as const,
    };

    expect(Object.keys(request)).not.toContain('rotation');

    const response = await handleScanMessage(request);
    if (response.kind !== 'result') throw new Error('expected a result');
    // The warp's own orientation: taller than wide for this fixture, and the
    // same whatever the user has since turned the preview to.
    expect(response.result.enhanced.width).toBeGreaterThan(0);
  });

  // The warp is what a later style change is applied to, so it has to come
  // back -- otherwise switching to greyscale would have to warp the photo again.
  it('answers a scan with the warp it finished, already size-limited', async () => {
    const response = await handleScanMessage({
      kind: 'scan',
      requestId: 3,
      image: syntheticDocument(),
      style: 'colour',
    });
    if (response.kind !== 'result') throw new Error('expected a result');

    expect(response.result.warped.width).toBe(response.result.enhanced.width);
    expect(response.result.warped.height).toBe(response.result.enhanced.height);
    expect(response.result.style).toBe('colour');
    // Two different images, or the finish did nothing.
    expect(Array.from(response.result.warped.data)).not.toEqual(
      Array.from(response.result.enhanced.data),
    );
  });

  describe('a restyle', () => {
    /** The warp a style change would be applied to. */
    async function warpOf(style: ScanStyle = 'colour') {
      const response = await handleScanMessage({
        kind: 'scan',
        requestId: 1,
        image: syntheticDocument(),
        style,
      });
      if (response.kind !== 'result') throw new Error('expected a result');
      return response.result;
    }

    it('answers with pixels alone, naming the style it applied', async () => {
      const scanned = await warpOf();

      const response = await handleScanMessage({
        kind: 'restyle',
        requestId: 11,
        image: scanned.warped,
        style: 'grayscale',
      });

      expect(response.kind).toBe('image');
      if (response.kind !== 'image') return;
      expect(response.requestId).toBe(11);
      expect(response.style).toBe('grayscale');
      expect(response.image.width).toBe(scanned.warped.width);
    });

    // A restyle is handed a warp and told nothing else, which is what makes it
    // cheap. A reply shaped like a whole scan could only repeat that back.
    it('reports no corners, because it was told none', async () => {
      const scanned = await warpOf();
      const response = await handleScanMessage({
        kind: 'restyle',
        requestId: 12,
        image: scanned.warped,
        style: 'none',
      });

      expect(response.kind).toBe('image');
      expect(response).not.toHaveProperty('result');
    });

    // The same style through either door has to mean the same thing, or the
    // picture changes when nothing about the document did.
    it('agrees with a scan asked for that style outright', async () => {
      const scanned = await warpOf('colour');
      const direct = await handleScanMessage({
        kind: 'scan',
        requestId: 2,
        image: syntheticDocument(),
        style: 'blackAndWhite',
      });
      if (direct.kind !== 'result') throw new Error('expected a result');

      const restyled = await handleScanMessage({
        kind: 'restyle',
        requestId: 13,
        image: scanned.warped,
        style: 'blackAndWhite',
      });
      if (restyled.kind !== 'image') throw new Error('expected an image');

      expect(Array.from(restyled.image.data)).toEqual(
        Array.from(direct.result.enhanced.data),
      );
    });
  });

  describe('what a reply hands over rather than copies', () => {
    async function scanWith(style: ScanStyle) {
      const response = await handleScanMessage({
        kind: 'scan',
        requestId: 1,
        image: syntheticDocument(),
        style,
      });
      if (response.kind !== 'result') throw new Error('expected a result');
      return response;
    }

    it('transfers both images a scan produces', async () => {
      const response = await scanWith('colour');
      const buffers = transferablesFor(response);

      expect(buffers).toHaveLength(2);
      expect(buffers).toContain(response.result.enhanced.data.buffer);
      // The crop travels too. Left out it is structured-cloned on every scan --
      // several megabytes of copy for a buffer the worker is done with.
      expect(buffers).toContain(response.result.warped.data.buffer);
    });

    // `applyStyle` returns its input unchanged for `none`, so the two images
    // are one buffer -- and `postMessage` throws DataCloneError on a transfer
    // list that names it twice, which would break that finish outright.
    it('names an aliased buffer once', async () => {
      const response = await scanWith('none');
      expect(response.result.warped.data.buffer).toBe(
        response.result.enhanced.data.buffer,
      );

      expect(transferablesFor(response)).toHaveLength(1);
    });

    it('transfers the image a restyle produces', async () => {
      const scanned = await scanWith('colour');
      const response = await handleScanMessage({
        kind: 'restyle',
        requestId: 2,
        image: scanned.result.warped,
        style: 'grayscale',
      });
      if (response.kind !== 'image') throw new Error('expected an image');

      expect(transferablesFor(response)).toEqual([response.image.data.buffer]);
    });

    it('has nothing to transfer for a failure', async () => {
      const response = await handleScanMessage({
        kind: 'scan',
        requestId: 3,
        image: { width: 0, height: 0, data: new Uint8ClampedArray(0) },
        style: 'colour',
      });
      expect(response.kind).toBe('error');
      expect(transferablesFor(response)).toEqual([]);
    });
  });

  // A rejected promise inside the worker never reaches the page, so a failure
  // has to come back as a message -- carrying the id, or the client cannot
  // match it to the request that is waiting.
  it('reports a failure as a message carrying the request id', async () => {
    const response = await handleScanMessage({
      kind: 'scan',
      requestId: 42,
      // Zero-sized: the pipeline cannot build a Mat from it.
      image: { width: 0, height: 0, data: new Uint8ClampedArray(0) },
      style: 'colour',
    });

    expect(response.kind).toBe('error');
    expect(response.requestId).toBe(42);
  });
});
