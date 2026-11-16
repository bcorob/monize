'use client';

import { RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { createLogger } from '@/lib/logger';
import type { PdfHandle, PdfPageRender } from '@/lib/attachment-preview/pdf-engine';

const logger = createLogger('PdfPages');

/** How far outside the scroller a page is drawn before the reader reaches it. */
const PRERENDER_MARGIN = '400px 0px';

/**
 * Every page of a PDF, drawn top to bottom into one canvas each.
 *
 * This is the only place the pdf.js engine is loaded from, and it is loaded
 * lazily inside an effect: the engine is a separate chunk plus a vendored
 * worker, fetched the first time somebody previews a PDF and never before.
 *
 * **A page is drawn when the reader can see it, and released when they scroll
 * away.** A canvas costs its pixels whether or not anyone is looking: at the
 * dialog's width a full page clamps to `MAX_PAGE_PIXELS`, which is 16 MB of
 * backing store, so drawing every page of a 20-page statement up front asks
 * the browser for hundreds of megabytes and loses the tab on a phone. What
 * bounds the cost is the number of pages on screen, not the length of the
 * document. Releasing a page keeps its measured box, so nothing moves under
 * the reader when it goes blank and is redrawn.
 */
export function PdfPages({
  bytes,
  scrollRootRef,
}: {
  bytes: ArrayBuffer;
  /**
   * The element the pages scroll inside, so visibility is measured against it.
   * Its absence is not fatal: the viewport is the fallback root, which is
   * correct but cannot pre-draw the page just below the fold.
   */
  scrollRootRef?: RefObject<HTMLElement | null>;
}) {
  const t = useTranslations('attachments');
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRefs = useRef<(HTMLCanvasElement | null)[]>([]);
  const handleRef = useRef<PdfHandle | null>(null);
  /** Which width each drawn page was drawn at, so a resize redraws it. */
  const drawnRef = useRef<Map<number, number>>(new Map());
  // Both are keyed to the bytes they describe, so a new document shows the
  // loading state on the render it arrives, without a reset in an effect.
  const [opened, setOpened] = useState<{
    bytes: ArrayBuffer;
    pageCount: number;
    aspectRatio: number;
  } | null>(null);
  const [failure, setFailure] = useState<ArrayBuffer | null>(null);
  const [width, setWidth] = useState<number | null>(null);
  const [visible, setVisible] = useState<number[]>([]);

  const document = opened?.bytes === bytes ? opened : null;
  const pageCount = document?.pageCount ?? null;
  const failed = failure === bytes;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { openPdf } = await import('@/lib/attachment-preview/pdf-engine');
        const handle = await openPdf(bytes);
        if (cancelled) {
          void handle.destroy();
          return;
        }
        handleRef.current = handle;
        drawnRef.current = new Map();
        setOpened({
          bytes,
          pageCount: handle.numPages,
          aspectRatio: handle.aspectRatio,
        });
      } catch (error) {
        if (cancelled) return;
        logger.error('Failed to open PDF:', error);
        setFailure(bytes);
      }
    })();
    return () => {
      cancelled = true;
      const handle = handleRef.current;
      handleRef.current = null;
      if (handle) void handle.destroy();
    };
  }, [bytes]);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const next = Math.floor(entries[0]?.contentRect.width ?? 0);
      if (next > 0) setWidth((prev) => (prev === next ? prev : next));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Before anything is measured: give every undrawn page the height it will
  // have. A run of zero-height canvases all intersect at once, and the very
  // first visibility report would then name every page in the document --
  // which is the eager render this component exists to avoid. Layout, not
  // effect, so it lands before the observer's first callback.
  useLayoutEffect(() => {
    if (document === null || width === null) return;
    const height = Math.round(width * document.aspectRatio);
    for (let page = 1; page <= document.pageCount; page++) {
      if (drawnRef.current.has(page)) continue;
      const canvas = canvasRefs.current[page - 1];
      if (!canvas) continue;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
    }
  }, [document, width]);

  useEffect(() => {
    if (pageCount === null) return;
    const onScreen = new Set<number>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const page = Number((entry.target as HTMLElement).dataset.page);
          if (!page) continue;
          if (entry.isIntersecting) onScreen.add(page);
          else onScreen.delete(page);
        }
        const next = Array.from(onScreen).sort((a, b) => a - b);
        setVisible((prev) =>
          prev.length === next.length && prev.every((p, i) => p === next[i])
            ? prev
            : next,
        );
      },
      { root: scrollRootRef?.current ?? null, rootMargin: PRERENDER_MARGIN },
    );
    for (let page = 1; page <= pageCount; page++) {
      const canvas = canvasRefs.current[page - 1];
      if (canvas) observer.observe(canvas);
    }
    return () => observer.disconnect();
  }, [pageCount, scrollRootRef]);

  useEffect(() => {
    const handle = handleRef.current;
    if (!handle || pageCount === null || width === null) return;
    let cancelled = false;
    let current: PdfPageRender | null = null;

    // Hand back the pixels of anything the reader has scrolled past. The
    // element keeps the size it was drawn at, so releasing it moves nothing.
    for (const page of Array.from(drawnRef.current.keys())) {
      if (visible.includes(page)) continue;
      const canvas = canvasRefs.current[page - 1];
      if (canvas) {
        canvas.width = 0;
        canvas.height = 0;
      }
      drawnRef.current.delete(page);
    }

    const ratio = typeof window === 'undefined' ? 1 : window.devicePixelRatio;
    (async () => {
      for (const page of visible) {
        if (cancelled) return;
        if (drawnRef.current.get(page) === width) continue;
        const canvas = canvasRefs.current[page - 1];
        if (!canvas) continue;
        current = handle.renderPage(page, canvas, width, ratio);
        try {
          await current.done;
        } catch (error) {
          if (cancelled) return;
          logger.error(`Failed to render PDF page ${page}:`, error);
          setFailure(bytes);
          return;
        }
        if (cancelled) return;
        drawnRef.current.set(page, width);
      }
    })();
    return () => {
      cancelled = true;
      current?.cancel();
    };
  }, [bytes, pageCount, width, visible]);

  return (
    <div ref={containerRef} className="w-full">
      {failed ? (
        <div
          role="alert"
          className="rounded-md border border-red-300 bg-red-50 p-4 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200"
        >
          {t('preview.failed')}
        </div>
      ) : pageCount === null ? (
        <LoadingSpinner text={t('preview.loading')} />
      ) : (
        <>
          <p className="mb-2 text-center text-xs text-gray-500 dark:text-gray-400">
            {t('preview.pageCount', { count: pageCount })}
          </p>
          {Array.from({ length: pageCount }, (_, index) => (
            <canvas
              key={index}
              ref={(element) => {
                canvasRefs.current[index] = element;
              }}
              data-page={index + 1}
              role="img"
              aria-label={t('preview.page', {
                page: index + 1,
                total: pageCount,
              })}
              className="mx-auto mb-3 block max-w-full bg-white shadow"
            />
          ))}
        </>
      )}
    </div>
  );
}
