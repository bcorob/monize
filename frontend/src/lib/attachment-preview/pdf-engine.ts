/**
 * The one door to pdf.js.
 *
 * `pdfjs-dist` is named nowhere else in `src/` (`attachment-preview.guard.test.ts`
 * holds that), and this module is reached only through a dynamic `import()`
 * from `PdfPages`, so no page pays for a PDF renderer until somebody previews
 * a PDF. The module also touches `DOMMatrix`/`Path2D` at load, which is a
 * second reason it must never sit on a static import path a server render
 * could reach.
 *
 * pdf.js renders in a Web Worker it constructs itself from
 * `GlobalWorkerOptions.workerSrc`. That script is copied out of the installed
 * package at build time (`frontend/scripts/copy-vendor.mjs`) so it is served from
 * our own origin under the page's CSP, and the URL carries the API's version as a
 * query string: the worker must match the API exactly, and a stale copy in the
 * HTTP cache would otherwise answer for a newer API with "API version does not
 * match Worker version".
 */
import type { RenderTask } from 'pdfjs-dist';

export const PDFJS_WORKER_URL = '/vendor/pdfjs/pdf.worker.min.mjs';
export const PDFJS_STANDARD_FONTS_URL = '/vendor/pdfjs/standard_fonts/';

/**
 * A page is rasterised at the device's pixel ratio for crisp text, but a
 * 3x phone drawing a full-width page allocates a canvas ten times the size of
 * the CSS box, per page. Four megapixels keeps each canvas near 16 MB.
 */
export const MAX_PAGE_PIXELS = 4_000_000;

export interface PdfPageRender {
  /** Resolves when the page is drawn, or when the render was cancelled. */
  done: Promise<void>;
  cancel(): void;
}

export interface PdfHandle {
  numPages: number;
  /**
   * Height divided by width of the first page.
   *
   * A page that has not been drawn yet still has to occupy the height it will
   * occupy once it is, or every page of the document is inside the viewport at
   * once and "render what the reader can see" degrades to "render everything".
   * One ratio for the whole document is an approximation -- a PDF may mix page
   * sizes -- and it only sizes the placeholder: the real size is set from the
   * page's own viewport the moment it is drawn.
   */
  aspectRatio: number;
  /**
   * Draw one page into `canvas` at `cssWidth` CSS pixels wide, sizing the
   * canvas itself for the device's pixel ratio.
   */
  renderPage(
    pageNumber: number,
    canvas: HTMLCanvasElement,
    cssWidth: number,
    devicePixelRatio: number,
  ): PdfPageRender;
  destroy(): Promise<void>;
}

/** The pixel ratio a page can be drawn at inside `MAX_PAGE_PIXELS`. */
export function clampPixelRatio(
  cssWidth: number,
  cssHeight: number,
  devicePixelRatio: number,
): number {
  const requested = Math.max(1, devicePixelRatio || 1);
  const area = cssWidth * cssHeight;
  if (area <= 0) return requested;
  const ceiling = Math.sqrt(MAX_PAGE_PIXELS / area);
  return Math.max(1, Math.min(requested, ceiling));
}

export async function openPdf(bytes: ArrayBuffer): Promise<PdfHandle> {
  const pdfjs = await import('pdfjs-dist');
  const workerSrc = `${PDFJS_WORKER_URL}?v=${pdfjs.version}`;
  if (pdfjs.GlobalWorkerOptions.workerSrc !== workerSrc) {
    pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;
  }

  const loadingTask = pdfjs.getDocument({
    // `getDocument` TRANSFERS the buffer to the worker, leaving the caller's
    // detached. The caller keeps its bytes (a re-render, a resize, a second
    // open), so the worker gets a copy.
    data: new Uint8Array(bytes.slice(0)),
    standardFontDataUrl: PDFJS_STANDARD_FONTS_URL,
  });
  const document = await loadingTask.promise;
  const firstPage = await document.getPage(1);
  const firstViewport = firstPage.getViewport({ scale: 1 });

  return {
    numPages: document.numPages,
    aspectRatio:
      firstViewport.width > 0 ? firstViewport.height / firstViewport.width : 1,
    renderPage(pageNumber, canvas, cssWidth, devicePixelRatio) {
      let cancelled = false;
      let task: RenderTask | null = null;
      const done = document
        .getPage(pageNumber)
        .then((page) => {
          if (cancelled) return;
          const base = page.getViewport({ scale: 1 });
          const viewport = page.getViewport({ scale: cssWidth / base.width });
          const ratio = clampPixelRatio(
            viewport.width,
            viewport.height,
            devicePixelRatio,
          );
          canvas.width = Math.floor(viewport.width * ratio);
          canvas.height = Math.floor(viewport.height * ratio);
          canvas.style.width = `${Math.floor(viewport.width)}px`;
          canvas.style.height = `${Math.floor(viewport.height)}px`;
          task = page.render({
            canvas,
            viewport,
            transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
          });
          return task.promise;
        })
        .catch((error: unknown) => {
          // A cancelled render rejects with RenderingCancelledException; a
          // destroyed document rejects its outstanding getPage. Neither is
          // news to a caller that asked for it.
          if (cancelled) return;
          throw error;
        });
      return {
        done,
        cancel() {
          cancelled = true;
          task?.cancel();
        },
      };
    },
    // The loading task owns the worker connection; destroying it releases
    // the document with it.
    destroy: () => loadingTask.destroy(),
  };
}
