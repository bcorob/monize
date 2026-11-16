import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  clampPixelRatio,
  MAX_PAGE_PIXELS,
  openPdf,
  PDFJS_STANDARD_FONTS_URL,
  PDFJS_WORKER_URL,
} from './pdf-engine';

const workerOptions = { workerSrc: '' };
const render = vi.fn();
const renderTask = { promise: Promise.resolve(), cancel: vi.fn() };
const page = {
  getViewport: vi.fn(({ scale }: { scale: number }) => ({
    width: 400 * scale,
    height: 800 * scale,
  })),
  render: render.mockReturnValue(renderTask),
};
const document = { numPages: 3, getPage: vi.fn(() => Promise.resolve(page)) };
const loadingTask = {
  promise: Promise.resolve(document),
  destroy: vi.fn(() => Promise.resolve()),
};
type DocumentParams = { data: Uint8Array; standardFontDataUrl: string };
const getDocument = vi.fn((_params: DocumentParams) => loadingTask);

vi.mock('pdfjs-dist', () => ({
  version: '6.3.289',
  GlobalWorkerOptions: workerOptions,
  getDocument: (params: DocumentParams) => getDocument(params),
}));

describe('pdf-engine', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workerOptions.workerSrc = '';
  });

  it('points pdf.js at the vendored worker, pinned to its own version', async () => {
    await openPdf(new Uint8Array([1]).buffer);
    expect(workerOptions.workerSrc).toBe(`${PDFJS_WORKER_URL}?v=6.3.289`);
    expect(PDFJS_WORKER_URL.startsWith('/vendor/pdfjs/')).toBe(true);
  });

  it('hands the worker a copy of the bytes and names the font directory', async () => {
    const bytes = new Uint8Array([1, 2, 3]).buffer;
    await openPdf(bytes);
    const params = getDocument.mock.calls[0][0];
    expect(params.data).toBeInstanceOf(Uint8Array);
    // A transfer detaches the buffer it is given; the caller keeps its own.
    expect(params.data.buffer).not.toBe(bytes);
    expect(Array.from(params.data)).toEqual([1, 2, 3]);
    expect(params.standardFontDataUrl).toBe(PDFJS_STANDARD_FONTS_URL);
  });

  it('reports the page count and forwards destroy to the loading task', async () => {
    const handle = await openPdf(new Uint8Array([1]).buffer);
    expect(handle.numPages).toBe(3);
    await handle.destroy();
    expect(loadingTask.destroy).toHaveBeenCalled();
  });

  it('sizes the canvas for the pixel ratio and draws at the CSS width', async () => {
    const handle = await openPdf(new Uint8Array([1]).buffer);
    const canvas = { width: 0, height: 0, style: {} } as HTMLCanvasElement;
    await handle.renderPage(2, canvas, 200, 2).done;

    expect(document.getPage).toHaveBeenCalledWith(2);
    // 400pt wide page drawn at 200 CSS px is scale 0.5: 200 x 400 CSS px.
    expect(canvas.style.width).toBe('200px');
    expect(canvas.style.height).toBe('400px');
    expect(canvas.width).toBe(400);
    expect(canvas.height).toBe(800);
    expect(render).toHaveBeenCalledWith(
      expect.objectContaining({ canvas, transform: [2, 0, 0, 2, 0, 0] }),
    );
  });

  it('sends no transform at ratio 1', async () => {
    const handle = await openPdf(new Uint8Array([1]).buffer);
    const canvas = { width: 0, height: 0, style: {} } as HTMLCanvasElement;
    await handle.renderPage(1, canvas, 200, 1).done;
    expect(render).toHaveBeenCalledWith(
      expect.objectContaining({ transform: undefined }),
    );
  });

  it('cancels a render and swallows the rejection that follows', async () => {
    let rejectRender!: (reason: unknown) => void;
    render.mockReturnValueOnce({
      promise: new Promise((_, reject) => {
        rejectRender = reject;
      }),
      cancel: vi.fn(() => rejectRender(new Error('RenderingCancelled'))),
    });
    const handle = await openPdf(new Uint8Array([1]).buffer);
    const canvas = { width: 0, height: 0, style: {} } as HTMLCanvasElement;
    const job = handle.renderPage(1, canvas, 200, 1);
    // Let getPage resolve so the task exists to be cancelled.
    await Promise.resolve();
    await Promise.resolve();
    job.cancel();
    await expect(job.done).resolves.toBeUndefined();
  });

  describe('clampPixelRatio', () => {
    it('keeps the device ratio when the page fits the budget', () => {
      expect(clampPixelRatio(400, 800, 2)).toBe(2);
    });

    it('lowers the ratio so the canvas stays inside MAX_PAGE_PIXELS', () => {
      const ratio = clampPixelRatio(2000, 2000, 3);
      expect(ratio).toBeLessThan(3);
      expect(2000 * 2000 * ratio * ratio).toBeLessThanOrEqual(MAX_PAGE_PIXELS + 1);
    });

    it('never goes below 1, and treats a missing ratio as 1', () => {
      expect(clampPixelRatio(4000, 4000, 2)).toBe(1);
      expect(clampPixelRatio(100, 100, 0)).toBe(1);
    });
  });
});
