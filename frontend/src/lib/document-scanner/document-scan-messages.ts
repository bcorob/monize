import { loadEngine } from './opencv-engine';
import {
  applyStyle,
  detectDocument,
  limitSize,
  warpToQuad,
} from './document-scan-pipeline';
import { assessCapture } from './document-scan-quality';
import type {
  ScannerRequest,
  ScannerResponse,
  ScanResult,
} from './document-scan.types';

/**
 * The buffers a reply may hand over rather than copy.
 *
 * Every image in a reply, and the deduplication is not tidiness: `applyStyle`
 * returns its input unchanged for the `none` finish, so `warped` and `enhanced`
 * are then the SAME buffer, and `postMessage` throws `DataCloneError` on a
 * transfer list naming one twice -- which would break that finish outright.
 *
 * It lives here rather than in the worker entry point because that file is the
 * one thing no test environment can run, so a decision made there is a decision
 * nothing checks. Getting it wrong is silent either way: a buffer left out is
 * copied instead of moved, which is only ever visible as a phone stalling.
 */
export function transferablesFor(response: ScannerResponse): ArrayBuffer[] {
  const images =
    response.kind === 'result'
      ? [response.result.enhanced, response.result.warped]
      : response.kind === 'image'
        ? [response.image]
        : [];
  const buffers = new Set<ArrayBuffer>();
  for (const image of images) buffers.add(image.data.buffer as ArrayBuffer);
  return [...buffers];
}

/**
 * The worker's dispatcher, as an ordinary function.
 *
 * The worker file itself is three lines of `postMessage` plumbing that no test
 * environment can run, so everything it decides lives here instead: which
 * pipeline steps a request runs, what a failure turns into, and how the request
 * id is carried back. The split is what makes the worker's behaviour testable
 * without a worker.
 */
export async function handleScanMessage(
  request: ScannerRequest,
): Promise<ScannerResponse> {
  try {
    const cv = await loadEngine();

    // A restyle is told nothing about the photo or the corners: it is handed a
    // warp that has already been made and asked to finish it differently. That
    // is the whole point -- a style change costs one pass over the crop rather
    // than warping several megapixels again.
    if (request.kind === 'restyle') {
      return {
        kind: 'image',
        requestId: request.requestId,
        image: applyStyle(cv, request.image, request.style),
        style: request.style,
      };
    }

    // A re-warp follows the user overruling the detection, so it does not
    // detect again -- and it reports `documentFound: true` because the corners
    // are now the user's own, not a guess that might have failed.
    const detected =
      request.kind === 'scan'
        ? detectDocument(cv, request.image)
        : { quad: request.quad, found: true };

    const warped = limitSize(cv, warpToQuad(cv, request.image, detected.quad));
    const enhanced = applyStyle(cv, warped, request.style);
    const result: ScanResult = {
      documentFound: detected.found,
      quad: detected.quad,
      warped,
      enhanced,
      style: request.style,
      warnings: assessCapture(
        cv,
        request.image,
        detected.quad,
        detected.found,
        enhanced,
      ),
    };
    return { kind: 'result', requestId: request.requestId, result };
  } catch (error) {
    // The id travels even on failure: the caller matches replies to requests,
    // and an error with no id is a reply it can only drop (`I6`).
    return {
      kind: 'error',
      requestId: request.requestId,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
