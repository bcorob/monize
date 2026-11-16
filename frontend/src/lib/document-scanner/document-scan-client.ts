import type {
  Quad,
  RawImage,
  ScanResult,
  ScanStyle,
  ScannerRequest,
  ScannerResponse,
} from './document-scan.types';

/**
 * The main thread's handle on the scanner worker.
 *
 * Two things it owns that the worker cannot. First, request identity: a scan
 * takes seconds, a user can retake a photo or drag a corner while one is in
 * flight, and a late reply describing the PREVIOUS photo must not be shown as
 * the current one -- so every request carries an id and a reply for an id that
 * is no longer outstanding is dropped (`I6`, and `docs/frontend/api-and-cache.md`'s rule
 * that asynchronous data belongs to the request that produced it).
 *
 * Second, failure: a worker that dies takes every pending promise with it
 * unless somebody rejects them, and a scan dialogue waiting forever on a
 * promise nobody will settle is the worst of the failure modes.
 */

/** How long a single scan may take before it is treated as hung. */
export const SCAN_TIMEOUT_MS = 60_000;

/** A restyle's answer: the finished pixels, and what they were finished as. */
export interface RestyledImage {
  image: RawImage;
  style: ScanStyle;
}

/** What a worker reply can carry: a whole scan, or finished pixels alone. */
type ScannerPayload = ScanResult | RestyledImage;

interface Pending {
  resolve: (payload: ScannerPayload) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface ScannerClient {
  scan(image: RawImage, style: ScanStyle): Promise<ScanResult>;
  rewarp(image: RawImage, quad: Quad, style: ScanStyle): Promise<ScanResult>;
  /**
   * Finish an already-warped document a different way. Takes a
   * `ScanResult.warped` and answers with the pixels and the finish they were
   * produced with -- the worker states what it made, rather than the caller
   * assuming its request was honoured.
   */
  restyle(warped: RawImage, style: ScanStyle): Promise<RestyledImage>;
  dispose(): void;
}

/**
 * Narrow a reply to the shape the request asked for.
 *
 * A cast would do the same thing and be wrong silently: the request kind and
 * the reply kind are agreed between two files, and a worker answering the wrong
 * one would otherwise reach the dialog as a preview built from undefined.
 */
function asScanResult(payload: ScannerPayload): ScanResult {
  if (!('enhanced' in payload)) {
    throw new Error('The document scanner answered with the wrong shape');
  }
  return payload;
}

function asRestyled(payload: ScannerPayload): RestyledImage {
  if ('enhanced' in payload) {
    throw new Error('The document scanner answered with the wrong shape');
  }
  return payload;
}

/** Build the worker. Replaceable so tests can supply a double. */
export type WorkerFactory = () => Worker;

const defaultWorkerFactory: WorkerFactory = () =>
  new Worker(new URL('./document-scan.worker.ts', import.meta.url), {
    type: 'module',
  });

export function createScannerClient(
  createWorker: WorkerFactory = defaultWorkerFactory,
): ScannerClient {
  const worker = createWorker();
  const pending = new Map<number, Pending>();
  let nextId = 1;
  let disposed = false;

  const settle = (id: number, apply: (entry: Pending) => void): void => {
    const entry = pending.get(id);
    // No entry means the request was already settled -- timed out, or answered
    // and then answered again. Dropping it is the point.
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(id);
    apply(entry);
  };

  worker.onmessage = (event: MessageEvent<ScannerResponse>) => {
    const response = event.data;
    settle(response.requestId, (entry) => {
      if (response.kind === 'result') entry.resolve(response.result);
      else if (response.kind === 'image')
        entry.resolve({ image: response.image, style: response.style });
      else entry.reject(new Error(response.message));
    });
  };

  worker.onerror = (event: ErrorEvent) => {
    // The worker itself failed, so nothing outstanding will ever be answered.
    const error = new Error(event.message || 'The document scanner failed');
    for (const id of [...pending.keys()]) {
      settle(id, (entry) => entry.reject(error));
    }
  };

  const send = (
    build: (requestId: number) => ScannerRequest,
  ): Promise<ScannerPayload> => {
    if (disposed) {
      return Promise.reject(new Error('The document scanner was closed'));
    }
    const requestId = nextId++;
    const request = build(requestId);
    return new Promise<ScannerPayload>((resolve, reject) => {
      const timer = setTimeout(() => {
        settle(requestId, (entry) =>
          entry.reject(new Error('The document scanner timed out')),
        );
      }, SCAN_TIMEOUT_MS);
      pending.set(requestId, { resolve, reject, timer });
      worker.postMessage(request);
    });
  };

  return {
    scan: (image, style) =>
      send((requestId) => ({ kind: 'scan', requestId, image, style })).then(
        asScanResult,
      ),
    rewarp: (image, quad, style) =>
      send((requestId) => ({
        kind: 'rewarp',
        requestId,
        image,
        quad,
        style,
      })).then(asScanResult),
    restyle: (warped, style) =>
      send((requestId) => ({
        kind: 'restyle',
        requestId,
        image: warped,
        style,
      })).then(asRestyled),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const id of [...pending.keys()]) {
        settle(id, (entry) =>
          entry.reject(new Error('The document scanner was closed')),
        );
      }
      worker.terminate();
    },
  };
}
