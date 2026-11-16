'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  createScannerClient,
  type ScannerClient,
  type WorkerFactory,
} from '@/lib/document-scanner/document-scan-client';
import { decodeImageFile } from '@/lib/document-scanner/decode-image';
import {
  DEFAULT_SCAN_STYLE,
  type Quad,
  type RawImage,
  type ScanResult,
  type ScanStyle,
} from '@/lib/document-scanner/document-scan.types';

/**
 * Owns the scanner worker for as long as a dialog is open, and makes sure the
 * result on screen belongs to the photo currently on screen.
 *
 * The client already drops replies to requests it has forgotten; this adds the
 * half only the UI knows about -- which request is the CURRENT one. A user who
 * retakes a photo while the first scan is still running has two in flight, and
 * the first one's answer, arriving second, would otherwise replace the second
 * one's preview with the wrong document (`I6`).
 */

export type ScannerStatus = 'idle' | 'loading' | 'ready' | 'failed';

export interface DocumentScannerState {
  status: ScannerStatus;
  /** The decoded photo the current result was produced from. */
  source: RawImage | null;
  result: ScanResult | null;
  error: string | null;
  /**
   * A re-warp is running over the result currently on screen.
   *
   * Distinct from `status: 'loading'`, which means there is nothing to show
   * yet: here the previous scan is still valid and displayed, and only the
   * corners have moved.
   */
  recomputing: boolean;
}

/**
 * What the user has asked the scanner for: which corners, and which finish.
 *
 * One value rather than two calls, because the two decide TOGETHER how much
 * work a change costs. A style change over unmoved corners needs only the
 * finish re-run; a corner move needs the warp as well. A caller that asked for
 * them separately would have to know that -- and would have to keep them
 * ordered, since a restyle uses the crop the last warp produced.
 */
export interface ScanRecipe {
  quad: Quad;
  style: ScanStyle;
}

export interface UseDocumentScanner extends DocumentScannerState {
  /** Decode a picked file and scan it, in the given finish (default `colour`). */
  scan(file: File, style?: ScanStyle): Promise<void>;
  /** Produce the document again for corners or a finish the user changed. */
  refine(recipe: ScanRecipe): Promise<void>;
  /** Forget the current photo and result, leaving the worker alive. */
  reset(): void;
}

/** Whether two quads name the same crop, so a re-warp would be wasted. */
function sameQuad(a: Quad, b: Quad): boolean {
  return a.every((corner, index) => {
    const other = b[index];
    return corner.x === other.x && corner.y === other.y;
  });
}

export function useDocumentScanner(
  createWorker?: WorkerFactory,
): UseDocumentScanner {
  const clientRef = useRef<ScannerClient | null>(null);
  /**
   * The decoded photo, inseparable from the attempt that decoded it.
   *
   * One ref rather than two, because the pair is only meaningful together: the
   * refine loop below runs across awaits, and reading the image and the attempt
   * from separate refs let it take a photo from one attempt and stamp the
   * result with another -- a warp of the discarded photo, presented as the
   * current one (`I6`, and `docs/frontend/api-and-cache.md`'s rule that asynchronous data
   * belongs to the request that produced it).
   */
  const sourceRef = useRef<{ attempt: number; image: RawImage } | null>(null);
  /**
   * Which attempt is current. Incremented by every scan and every reset, so a
   * reply captured under an older value is known to be stale without needing
   * to know why it is stale.
   */
  const attemptRef = useRef(0);
  const mountedRef = useRef(true);

  /**
   * The newest recipe waiting to be produced, and whether one is running.
   *
   * Producing the document takes seconds on a large photo, so several quick
   * adjustments would otherwise queue behind each other and the user would wait
   * for every intermediate result they had already replaced. Only the newest is
   * kept: the one in flight finishes, then the latest pending recipe runs, and
   * anything in between is dropped unrun.
   */
  const pendingRecipeRef = useRef<ScanRecipe | null>(null);
  const refineRunningRef = useRef(false);

  /** The last result that landed, so a refine knows what it is refining. */
  const resultRef = useRef<ScanResult | null>(null);

  const [state, setState] = useState<DocumentScannerState>({
    status: 'idle',
    source: null,
    result: null,
    error: null,
    recomputing: false,
  });

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clientRef.current?.dispose();
      clientRef.current = null;
    };
  }, []);

  const client = useCallback((): ScannerClient => {
    if (!clientRef.current) {
      clientRef.current = createScannerClient(createWorker);
    }
    return clientRef.current;
  }, [createWorker]);

  /** Apply an update only if the attempt that produced it is still current. */
  const commit = useCallback(
    (attempt: number, next: Partial<DocumentScannerState>): void => {
      if (!mountedRef.current || attempt !== attemptRef.current) return;
      setState((previous) => ({ ...previous, ...next }));
    },
    [],
  );

  const scan = useCallback(
    async (file: File, style: ScanStyle = DEFAULT_SCAN_STYLE): Promise<void> => {
      const attempt = ++attemptRef.current;
      // A new photo abandons any adjustment queued for the previous one.
      pendingRecipeRef.current = null;
      resultRef.current = null;
      setState({
        status: 'loading',
        source: null,
        result: null,
        error: null,
        recomputing: false,
      });
      try {
        const image = await decodeImageFile(file);
        if (attempt !== attemptRef.current) return;
        sourceRef.current = { attempt, image };
        const result = await client().scan(image, style);
        if (attempt === attemptRef.current) resultRef.current = result;
        commit(attempt, {
          status: 'ready',
          source: image,
          result,
          error: null,
        });
      } catch (error) {
        commit(attempt, {
          status: 'failed',
          error:
            error instanceof Error
              ? error.message
              : 'The document could not be scanned',
        });
      }
    },
    [client, commit],
  );

  const refine = useCallback(
    async (recipe: ScanRecipe): Promise<void> => {
      if (!sourceRef.current) return;

      pendingRecipeRef.current = recipe;
      // Someone is already draining the queue; it will pick this up.
      if (refineRunningRef.current) return;
      refineRunningRef.current = true;

      try {
        while (pendingRecipeRef.current) {
          const next = pendingRecipeRef.current;
          pendingRecipeRef.current = null;
          // Read per iteration, not once at the top: this loop can be draining
          // a recipe queued after a DIFFERENT photo was scanned, and the photo
          // it works from must be the one the result will be stamped with.
          const source = sourceRef.current;
          if (!source) break;
          // Deliberately NOT a new attempt: a refine works on the photo already
          // on screen, so a scan of a different photo landing meanwhile wins.
          const { attempt, image } = source;
          commit(attempt, { recomputing: true });
          try {
            const previous = resultRef.current;
            // Only the finish changed, over corners the current warp was made
            // from: re-finishing that warp is the whole of the work. Decided
            // here rather than by the caller, because "is this warp still the
            // right one" is a fact about what has landed, not about the click.
            const result =
              previous && sameQuad(previous.quad, next.quad)
                ? await client()
                    .restyle(previous.warped, next.style)
                    .then((restyled) => ({
                      // The warnings are carried over rather than recomputed,
                      // and that is sound rather than convenient: all three are
                      // measured on the photo, the corners or the output's
                      // size, none of which a finish moves.
                      ...previous,
                      enhanced: restyled.image,
                      // The worker's answer, not the request: what the result
                      // says it is has to be what was actually produced.
                      style: restyled.style,
                    }))
                : await client().rewarp(image, next.quad, next.style);
            if (attempt === attemptRef.current) resultRef.current = result;
            commit(attempt, { status: 'ready', result, error: null });
          } catch (error) {
            commit(attempt, {
              status: 'failed',
              error:
                error instanceof Error
                  ? error.message
                  : 'The document could not be scanned',
            });
          }
        }
      } finally {
        // Released on every path: leaving it set would strand every later
        // adjustment in the queue with nothing draining it.
        refineRunningRef.current = false;
        commit(attemptRef.current, { recomputing: false });
      }
    },
    [client, commit],
  );

  const reset = useCallback((): void => {
    attemptRef.current++;
    sourceRef.current = null;
    pendingRecipeRef.current = null;
    resultRef.current = null;
    setState({
      status: 'idle',
      source: null,
      result: null,
      error: null,
      recomputing: false,
    });
  }, []);

  return { ...state, scan, refine, reset };
}
