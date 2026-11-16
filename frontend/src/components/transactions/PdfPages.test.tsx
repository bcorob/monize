import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, waitFor } from '@/test/render';
import { PdfPages } from './PdfPages';
import { openPdf } from '@/lib/attachment-preview/pdf-engine';

vi.mock('@/lib/attachment-preview/pdf-engine', () => ({
  openPdf: vi.fn(),
}));

const mockOpen = openPdf as ReturnType<typeof vi.fn>;
const OriginalResizeObserver = globalThis.ResizeObserver;

/** Reports a 600px-wide container as soon as it is observed. */
class WideResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe() {
    this.callback(
      [{ contentRect: { width: 600 } } as ResizeObserverEntry],
      this as unknown as ResizeObserver,
    );
  }
  unobserve() {}
  disconnect() {}
}

let observed: Element[] = [];
let report: ((entries: unknown[]) => void) | null = null;

function stubIntersectionObserver() {
  observed = [];
  report = null;
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(callback: (entries: unknown[]) => void) {
        report = callback;
      }
      observe(element: Element) {
        observed.push(element);
      }
      unobserve() {}
      disconnect() {
        observed = [];
        report = null;
      }
    },
  );
}

/** Tell the component which pages the reader can see. */
async function show(pages: number[]) {
  await act(async () => {
    report?.(
      observed.map((target) => ({
        target,
        isIntersecting: pages.includes(
          Number((target as HTMLElement).dataset.page),
        ),
      })),
    );
  });
}

function handleOf(numPages: number) {
  const renderPage = vi.fn(
    (_page: number, canvas: HTMLCanvasElement, _width: number, _ratio: number) => {
      // A real render allocates a backing store; the release path zeroes it.
      canvas.width = 100;
      return { done: Promise.resolve(), cancel: vi.fn() };
    },
  );
  const destroy = vi.fn(() => Promise.resolve());
  return { numPages, aspectRatio: 1.4, renderPage, destroy };
}

describe('PdfPages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.ResizeObserver = WideResizeObserver as unknown as typeof ResizeObserver;
    stubIntersectionObserver();
  });
  afterEach(() => {
    globalThis.ResizeObserver = OriginalResizeObserver;
    vi.unstubAllGlobals();
  });

  const bytes = new Uint8Array([1, 2, 3]).buffer;

  async function mount(numPages: number) {
    const handle = handleOf(numPages);
    mockOpen.mockResolvedValue(handle);
    let unmount: () => void = () => {};
    await act(async () => {
      ({ unmount } = render(<PdfPages bytes={bytes} />));
    });
    return { handle, unmount };
  }

  it('lists every page and labels each one', async () => {
    await mount(2);
    expect(mockOpen).toHaveBeenCalledWith(bytes);
    expect(screen.getByText('2 pages')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Page 1 of 2' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Page 2 of 2' })).toBeInTheDocument();
  });

  it('gives an undrawn page the height it will have, so it is not all on screen at once', async () => {
    await mount(3);
    const page3 = screen.getByRole('img', { name: 'Page 3 of 3' }) as HTMLCanvasElement;
    // 600px wide at the document's 1.4 aspect ratio.
    expect(page3.style.width).toBe('600px');
    expect(page3.style.height).toBe('840px');
  });

  it('draws the pages the reader can see, in order, at the container width', async () => {
    const { handle } = await mount(3);
    await show([1, 2]);

    await waitFor(() => expect(handle.renderPage).toHaveBeenCalledTimes(2));
    expect(handle.renderPage.mock.calls[0][0]).toBe(1);
    expect(handle.renderPage.mock.calls[1][0]).toBe(2);
    expect(handle.renderPage.mock.calls[0][2]).toBe(600);
  });

  /**
   * The whole point of the observer. Drawing every page of a long document
   * costs ~16 MB of canvas each, which is how a phone loses the tab on a
   * 20-page statement.
   */
  it('never draws a page the reader has not reached', async () => {
    const { handle } = await mount(20);
    await show([1]);

    await waitFor(() => expect(handle.renderPage).toHaveBeenCalledTimes(1));
    expect(handle.renderPage.mock.calls[0][0]).toBe(1);
    expect(
      handle.renderPage.mock.calls.some(([page]) => page !== 1),
    ).toBe(false);
  });

  it('releases the pixels of a page scrolled away, keeping its box', async () => {
    const { handle } = await mount(3);
    await show([1, 2]);
    await waitFor(() => expect(handle.renderPage).toHaveBeenCalledTimes(2));

    const page1 = screen.getByRole('img', { name: 'Page 1 of 3' }) as HTMLCanvasElement;
    expect(page1.width).toBe(100);

    await show([2, 3]);
    expect(page1.width).toBe(0);
    // The element still occupies its place, so nothing jumps.
    expect(page1.style.width).toBe('600px');
  });

  it('redraws a page the reader comes back to', async () => {
    const { handle } = await mount(3);
    await show([1]);
    await waitFor(() => expect(handle.renderPage).toHaveBeenCalledTimes(1));
    await show([3]);
    await show([1]);
    await waitFor(() => expect(handle.renderPage).toHaveBeenCalledTimes(3));
    expect(handle.renderPage.mock.calls.map(([page]) => page)).toEqual([1, 3, 1]);
  });

  it('draws a visible page only once while it stays visible', async () => {
    const { handle } = await mount(3);
    await show([1, 2]);
    await waitFor(() => expect(handle.renderPage).toHaveBeenCalledTimes(2));
    await show([1, 2]);
    expect(handle.renderPage).toHaveBeenCalledTimes(2);
  });

  it('shows the loading state until the document opens', async () => {
    mockOpen.mockReturnValue(new Promise(() => {}));
    await act(async () => {
      render(<PdfPages bytes={bytes} />);
    });
    expect(screen.getByText('Loading preview…')).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('destroys the document on unmount', async () => {
    const { handle, unmount } = await mount(1);
    await show([1]);
    await waitFor(() => expect(handle.renderPage).toHaveBeenCalled());
    unmount();
    expect(handle.destroy).toHaveBeenCalled();
  });

  it('reports a document it cannot open, rather than an empty one', async () => {
    mockOpen.mockRejectedValue(new Error('bad pdf'));
    await act(async () => {
      render(<PdfPages bytes={bytes} />);
    });
    expect(screen.getByRole('alert')).toHaveTextContent(
      'The preview could not be loaded',
    );
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('reports a page it cannot draw', async () => {
    const handle = handleOf(2);
    handle.renderPage.mockImplementation(() => {
      const done = Promise.reject(new Error('bad page'));
      // The component awaits this; the extra handler only stops the rejection
      // being reported as unhandled in the tick before it does.
      done.catch(() => {});
      return { done, cancel: vi.fn() };
    });
    mockOpen.mockResolvedValue(handle);
    await act(async () => {
      render(<PdfPages bytes={bytes} />);
    });
    await show([1]);
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'The preview could not be loaded',
      ),
    );
  });
});
