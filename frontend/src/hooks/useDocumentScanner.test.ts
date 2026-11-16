import { act, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/test/render';
import { useDocumentScanner } from './useDocumentScanner';
import type {
  Quad,
  RawImage,
  ScanResult,
  ScanStyle,
  ScannerRequest,
  ScannerResponse,
} from '@/lib/document-scanner/document-scan.types';

/**
 * The hook's one job beyond wiring: making sure what is on screen belongs to
 * the photo on screen.
 *
 * A scan takes seconds and a user can retake in the middle of one, so the
 * answer to the abandoned photo arrives while the new one is still running.
 * Showing it is not a cosmetic slip -- the user then approves an enhanced
 * image of a document they discarded, and that is what gets stored.
 */

const decoded: RawImage = {
  width: 4,
  height: 4,
  data: new Uint8ClampedArray(64),
};

vi.mock('@/lib/document-scanner/decode-image', () => ({
  decodeImageFile: vi.fn(async () => decoded),
}));

import { decodeImageFile } from '@/lib/document-scanner/decode-image';

const quad: Quad = [
  { x: 0, y: 0 },
  { x: 4, y: 0 },
  { x: 4, y: 4 },
  { x: 0, y: 4 },
];

/** The crop the scan produced, which a restyle is applied to. */
const warped: RawImage = {
  width: 2,
  height: 2,
  data: new Uint8ClampedArray(16),
};

function resultWith(warning: 'blurry' | 'lowResolution'): ScanResult {
  return {
    documentFound: true,
    quad,
    warped,
    enhanced: { width: 1, height: 1, data: new Uint8ClampedArray(4) },
    style: 'colour',
    warnings: [warning],
  };
}

/** A worker double whose replies the test releases by hand. */
class ControllableWorker {
  readonly sent: ScannerRequest[] = [];
  onmessage: ((event: MessageEvent<ScannerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;

  postMessage(request: ScannerRequest): void {
    this.sent.push(request);
  }

  terminate(): void {
    /* nothing to release in the double */
  }

  reply(index: number, result: ScanResult): void {
    this.onmessage?.({
      data: { kind: 'result', requestId: this.sent[index].requestId, result },
    } as MessageEvent<ScannerResponse>);
  }

  replyImage(index: number, image: RawImage, style: ScanStyle): void {
    this.onmessage?.({
      data: {
        kind: 'image',
        requestId: this.sent[index].requestId,
        image,
        style,
      },
    } as MessageEvent<ScannerResponse>);
  }

  replyError(index: number, message: string): void {
    this.onmessage?.({
      data: { kind: 'error', requestId: this.sent[index].requestId, message },
    } as MessageEvent<ScannerResponse>);
  }
}

describe('useDocumentScanner', () => {
  let worker: ControllableWorker;

  beforeEach(() => {
    worker = new ControllableWorker();
  });

  const render = () =>
    renderHook(() => useDocumentScanner(() => worker as unknown as Worker));

  const file = (name: string) =>
    new File([new Uint8Array([1, 2, 3])], name, { type: 'image/jpeg' });

  it('starts idle', () => {
    const { result } = render();
    expect(result.current.status).toBe('idle');
    expect(result.current.result).toBeNull();
  });

  it('reports a completed scan with the photo it came from', async () => {
    const { result } = render();

    await act(async () => {
      void result.current.scan(file('receipt.jpg'));
    });
    await waitFor(() => expect(worker.sent).toHaveLength(1));

    await act(async () => {
      worker.reply(0, resultWith('blurry'));
    });

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.result?.warnings).toEqual(['blurry']);
    expect(result.current.source).toEqual(decoded);
  });

  // The whole reason requests carry an id: the user retook the photo, and the
  // first scan's answer must not replace the second's.
  it('ignores the answer to a photo that has been replaced', async () => {
    const { result } = render();

    await act(async () => {
      void result.current.scan(file('first.jpg'));
    });
    await waitFor(() => expect(worker.sent).toHaveLength(1));

    await act(async () => {
      void result.current.scan(file('second.jpg'));
    });
    await waitFor(() => expect(worker.sent).toHaveLength(2));

    // The SECOND photo answers first, then the abandoned first one.
    await act(async () => {
      worker.reply(1, resultWith('lowResolution'));
    });
    await waitFor(() => expect(result.current.status).toBe('ready'));

    await act(async () => {
      worker.reply(0, resultWith('blurry'));
    });

    expect(result.current.result?.warnings).toEqual(['lowResolution']);
  });

  it('drops a scan that answers after a reset', async () => {
    const { result } = render();

    await act(async () => {
      void result.current.scan(file('receipt.jpg'));
    });
    await waitFor(() => expect(worker.sent).toHaveLength(1));

    act(() => {
      result.current.reset();
    });
    await act(async () => {
      worker.reply(0, resultWith('blurry'));
    });

    expect(result.current.status).toBe('idle');
    expect(result.current.result).toBeNull();
  });

  it('reports a failure without leaving the dialog waiting', async () => {
    const { result } = render();

    await act(async () => {
      void result.current.scan(file('receipt.jpg'));
    });
    await waitFor(() => expect(worker.sent).toHaveLength(1));

    await act(async () => {
      worker.replyError(0, 'the engine failed');
    });

    await waitFor(() => expect(result.current.status).toBe('failed'));
    expect(result.current.error).toBe('the engine failed');
  });

  describe('refine', () => {
    /** Scan a photo and land its result, which every refine builds on. */
    async function scanned(result: { current: ReturnType<typeof useDocumentScanner> }) {
      await act(async () => {
        void result.current.scan(file('receipt.jpg'));
      });
      await waitFor(() => expect(worker.sent).toHaveLength(1));
      await act(async () => {
        worker.reply(0, resultWith('blurry'));
      });
      await waitFor(() => expect(result.current.status).toBe('ready'));
    }

    const moved: Quad = [
      { x: 1, y: 1 },
      { x: 3, y: 1 },
      { x: 3, y: 3 },
      { x: 1, y: 3 },
    ];

    it('re-warps the photo already on screen with the user\u2019s corners', async () => {
      const { result } = render();
      await scanned(result);

      await act(async () => {
        void result.current.refine({ quad: moved, style: 'colour' });
      });
      await waitFor(() => expect(worker.sent).toHaveLength(2));

      expect(worker.sent[1]).toMatchObject({
        kind: 'rewarp',
        quad: moved,
        style: 'colour',
        // The same decoded photo, not a re-read of the file.
        image: decoded,
      });
    });

    // The point of splitting the warp from the finish: changing the finish over
    // corners that have not moved is one pass over a crop that already exists,
    // not a second warp of several megapixels.
    it('restyles the existing warp when only the finish changed', async () => {
      const { result } = render();
      await scanned(result);

      await act(async () => {
        void result.current.refine({ quad, style: 'blackAndWhite' });
      });
      await waitFor(() => expect(worker.sent).toHaveLength(2));

      expect(worker.sent[1]).toMatchObject({
        kind: 'restyle',
        style: 'blackAndWhite',
        // The warp the scan produced, not the photo.
        image: warped,
      });
      expect(worker.sent[1]).not.toHaveProperty('quad');
    });

    // The decision is the hook\u2019s, not the caller\u2019s: whether the crop on hand is
    // still the right one is a fact about what has landed, not about the click.
    it('warps again when the corners moved, even for the same finish', async () => {
      const { result } = render();
      await scanned(result);

      await act(async () => {
        void result.current.refine({ quad: moved, style: 'colour' });
      });
      await waitFor(() => expect(worker.sent).toHaveLength(2));
      expect(worker.sent[1].kind).toBe('rewarp');
    });

    // A restyle answers with pixels alone, so the hook builds the result around
    // them -- and the corners and warnings have to survive that, or the handles
    // jump back to the detection the moment somebody picks greyscale.
    it('keeps the corners and warnings a restyle was not told about', async () => {
      const { result } = render();
      await scanned(result);

      await act(async () => {
        void result.current.refine({ quad, style: 'grayscale' });
      });
      await waitFor(() => expect(worker.sent).toHaveLength(2));

      const restyled: RawImage = {
        width: 2,
        height: 2,
        data: new Uint8ClampedArray(16),
      };
      await act(async () => {
        worker.replyImage(1, restyled, 'grayscale');
      });
      await waitFor(() => expect(result.current.recomputing).toBe(false));

      expect(result.current.result?.enhanced).toBe(restyled);
      expect(result.current.result?.style).toBe('grayscale');
      expect(result.current.result?.quad).toEqual(quad);
      expect(result.current.result?.warnings).toEqual(['blurry']);
    });

    // A restyle uses the crop the last warp produced, so a corner move that
    // landed in between has to be the crop it works from.
    it('restyles the newest warp, not the one the scan produced', async () => {
      const { result } = render();
      await scanned(result);

      await act(async () => {
        void result.current.refine({ quad: moved, style: 'colour' });
      });
      await waitFor(() => expect(worker.sent).toHaveLength(2));

      const rewarped = resultWith('lowResolution');
      const movedWarp: RawImage = {
        width: 3,
        height: 3,
        data: new Uint8ClampedArray(36),
      };
      await act(async () => {
        worker.reply(1, { ...rewarped, quad: moved, warped: movedWarp });
      });
      await waitFor(() => expect(result.current.recomputing).toBe(false));

      await act(async () => {
        void result.current.refine({ quad: moved, style: 'none' });
      });
      await waitFor(() => expect(worker.sent).toHaveLength(3));

      expect(worker.sent[2]).toMatchObject({
        kind: 'restyle',
        image: movedWarp,
      });
    });

    // Producing the document takes seconds on a large photo. Several quick
    // adjustments used to queue, so the user waited for every intermediate
    // result they had already replaced -- which is what "press it a few times
    // and wait 30 seconds" was.
    it('runs the newest recipe and drops the ones overtaken', async () => {
      const { result } = render();
      await scanned(result);

      const corners = (offset: number): Quad => [
        { x: offset, y: offset },
        { x: 4 - offset, y: offset },
        { x: 4 - offset, y: 4 - offset },
        { x: offset, y: 4 - offset },
      ];

      // Three adjustments while the first is still running.
      await act(async () => {
        void result.current.refine({ quad: corners(1), style: 'colour' });
        void result.current.refine({ quad: corners(2), style: 'colour' });
        void result.current.refine({ quad: corners(3), style: 'colour' });
      });
      await waitFor(() => expect(worker.sent).toHaveLength(2));

      // Only the first has been sent so far; the middle one is already gone.
      expect(worker.sent[1]).toMatchObject({ quad: corners(1) });

      await act(async () => {
        worker.reply(1, resultWith('lowResolution'));
      });

      // The newest corners run next -- not the one in between.
      await waitFor(() => expect(worker.sent).toHaveLength(3));
      expect(worker.sent[2]).toMatchObject({ quad: corners(3) });

      await act(async () => {
        worker.reply(2, resultWith('blurry'));
      });
      await waitFor(() => expect(worker.sent).toHaveLength(3));
    });

    it('reports that it is recomputing while one runs', async () => {
      const { result } = render();
      await scanned(result);
      expect(result.current.recomputing).toBe(false);

      await act(async () => {
        void result.current.refine({ quad: moved, style: 'colour' });
      });
      await waitFor(() => expect(result.current.recomputing).toBe(true));
      // The previous result stays on screen: this is not a loading state.
      expect(result.current.status).toBe('ready');
      expect(result.current.result).not.toBeNull();

      await act(async () => {
        worker.reply(1, resultWith('lowResolution'));
      });
      await waitFor(() => expect(result.current.recomputing).toBe(false));
    });

    // A failure must release the queue, or every later adjustment sits behind
    // a drain that never runs again.
    it('keeps accepting adjustments after one fails', async () => {
      const { result } = render();
      await scanned(result);

      await act(async () => {
        void result.current.refine({ quad: moved, style: 'colour' });
      });
      await waitFor(() => expect(worker.sent).toHaveLength(2));
      await act(async () => {
        worker.replyError(1, 'the engine failed');
      });
      await waitFor(() => expect(result.current.status).toBe('failed'));
      expect(result.current.recomputing).toBe(false);

      await act(async () => {
        void result.current.refine({ quad: moved, style: 'colour' });
      });
      await waitFor(() => expect(worker.sent).toHaveLength(3));
    });

    // The loop drains recipes queued while it was awaiting, and a retake in
    // that window changes which photo those corners belong to. Working from a
    // photo captured before the loop started produced a warp of the DISCARDED
    // document, stamped with the current photo's attempt -- so the user could
    // approve and store an image of a receipt they had already replaced (I6).
    it('works from the photo current when each recipe runs, not the first', async () => {
      const { result } = render();
      await scanned(result);

      // A refine on the first photo, left in flight.
      await act(async () => {
        void result.current.refine({ quad: moved, style: 'colour' });
      });
      await waitFor(() => expect(worker.sent).toHaveLength(2));

      // A second photo is scanned and lands while that refine is still running.
      const second: RawImage = {
        width: 8,
        height: 8,
        data: new Uint8ClampedArray(8 * 8 * 4),
      };
      vi.mocked(decodeImageFile).mockResolvedValueOnce(second);
      await act(async () => {
        void result.current.scan(file('second.jpg'));
      });
      await waitFor(() => expect(worker.sent).toHaveLength(3));
      await act(async () => {
        worker.reply(2, resultWith('blurry'));
      });
      await waitFor(() => expect(result.current.status).toBe('ready'));

      // Corners moved on the SECOND photo, queued behind the first refine.
      const later: Quad = [
        { x: 2, y: 2 },
        { x: 6, y: 2 },
        { x: 6, y: 6 },
        { x: 2, y: 6 },
      ];
      await act(async () => {
        void result.current.refine({ quad: later, style: 'colour' });
      });

      // The first refine finally answers, releasing the queue.
      await act(async () => {
        worker.reply(1, resultWith('lowResolution'));
      });
      await waitFor(() => expect(worker.sent).toHaveLength(4));

      // The queued recipe runs against the photo on screen now.
      expect(worker.sent[3]).toMatchObject({ kind: 'rewarp', quad: later });
      expect((worker.sent[3] as { image: RawImage }).image).toBe(second);
    });

    it('does nothing when there is no photo to work from', async () => {
      const { result } = render();
      await act(async () => {
        await result.current.refine({ quad, style: 'colour' });
      });
      expect(worker.sent).toHaveLength(0);
    });

    // A refine works on the photo on screen, so it must not outrank a scan of a
    // different photo that started after it.
    it('is discarded when a new photo has been chosen meanwhile', async () => {
      const { result } = render();

      await act(async () => {
        void result.current.scan(file('first.jpg'));
      });
      await waitFor(() => expect(worker.sent).toHaveLength(1));
      await act(async () => {
        worker.reply(0, resultWith('blurry'));
      });
      await waitFor(() => expect(result.current.status).toBe('ready'));

      await act(async () => {
        void result.current.refine({ quad: moved, style: 'colour' });
      });
      await waitFor(() => expect(worker.sent).toHaveLength(2));

      // A new photo is picked before the refine comes back.
      await act(async () => {
        void result.current.scan(file('second.jpg'));
      });
      await waitFor(() => expect(worker.sent).toHaveLength(3));

      await act(async () => {
        worker.reply(1, resultWith('lowResolution'));
      });

      // Still loading the new photo; the stale refine did not land.
      expect(result.current.status).toBe('loading');
    });
  });
});
