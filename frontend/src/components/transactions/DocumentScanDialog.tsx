'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/Button';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Modal } from '@/components/ui/Modal';
import { Select } from '@/components/ui/Select';
import { useDocumentScanner } from '@/hooks/useDocumentScanner';
import { useImageZoom } from '@/hooks/useImageZoom';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import {
  encodeScan,
  scanFilename,
  toCanvas,
} from '@/lib/document-scanner/decode-image';
import type { WorkerFactory } from '@/lib/document-scanner/document-scan-client';
import {
  ADJUSTMENT_RANGE,
  NEUTRAL_ADJUSTMENTS,
  adjustImage,
  isNeutral,
  type ImageAdjustments,
} from '@/lib/document-scanner/adjust-image';
import {
  SCAN_STYLES,
  type Quad,
  type QualityWarning,
  type RawImage,
  type ScanStyle,
} from '@/lib/document-scanner/document-scan.types';
import {
  rotateImage,
  type QuarterTurns,
} from '@/lib/document-scanner/rotate-image';
import { useScanSettingsStore } from '@/store/scanSettingsStore';
import { MAX_ATTACHMENT_BYTES } from '@/types/attachment';
import { DocumentCornerHandles } from './DocumentCornerHandles';
import { SEGMENTED_GROUP_CLASS, segmentClass } from '@/components/ui/segmented-control';

/**
 * The scan review step: what the pipeline made of the photo, and what the user
 * wants done with it.
 *
 * Two things it is careful about. Nothing here refuses a capture -- every
 * warning sits beside a way to continue, because a receipt somebody cannot
 * photograph again is worth keeping imperfect (`I5`). And the blob it hands
 * back is the one it displayed, never a re-render, so the file that gets stored
 * is the file that was approved (`I3`).
 */

/** The longest edge the preview is drawn at. */
const PREVIEW_MAX_EDGE = 460;

/** What the user chose to keep. */
export interface ScanOutcome {
  /** The attachment that will be shown: the enhanced scan, or the photo. */
  file: File;
  /** The untouched photo, when it is being kept beside the scan. */
  original?: File;
}

export interface DocumentScanDialogProps {
  isOpen: boolean;
  /** The photo the user picked or captured. */
  file: File | null;
  onCancel: () => void;
  onRetake: () => void;
  onAccept: (outcome: ScanOutcome) => void;
  /** Test seam: supplies a worker double. */
  createWorker?: WorkerFactory;
}

type PreviewMode = 'enhanced' | 'original';

/** The two repairs offered, in the order they are drawn. */
const ADJUSTMENT_FIELDS = ['brightness', 'contrast'] as const;

/** Fit a photo into the preview box, keeping its aspect ratio. */
function previewSize(image: RawImage): { width: number; height: number } {
  const longest = Math.max(image.width, image.height);
  const scale = longest > PREVIEW_MAX_EDGE ? PREVIEW_MAX_EDGE / longest : 1;
  return {
    width: Math.max(1, Math.round(image.width * scale)),
    height: Math.max(1, Math.round(image.height * scale)),
  };
}

/**
 * Draw pixels into a canvas element that React owns.
 *
 * A callback ref keyed on the image rather than a ref written during render:
 * changing the image gives React a new callback, so it detaches and reattaches
 * the ref and the new pixels are painted -- which is exactly the repaint that
 * is wanted, without writing to a ref while rendering.
 */
function useCanvasPainter(
  image: RawImage | null,
): (node: HTMLCanvasElement | null) => void {
  return useCallback(
    (node: HTMLCanvasElement | null) => {
      if (!node || !image) return;
      const painted = toCanvas(image);
      node.width = painted.width;
      node.height = painted.height;
      node.getContext('2d')?.drawImage(painted, 0, 0);
    },
    [image],
  );
}

export function DocumentScanDialog({
  isOpen,
  file,
  onCancel,
  onRetake,
  onAccept,
  createWorker,
}: DocumentScanDialogProps) {
  const t = useTranslations('attachments');
  const { formatNumber, formatBytes } = useNumberFormat();
  const scanner = useDocumentScanner(createWorker);
  const { scan, refine, reset } = scanner;

  // The finish and the two slider offsets are remembered across scans, so a new
  // document opens the way the last one was left (INV note: the corners and the
  // rotation are per photo and deliberately are not).
  const rememberStyle = useScanSettingsStore((s) => s.setStyle);
  const rememberAdjustments = useScanSettingsStore((s) => s.setAdjustments);

  const [mode, setMode] = useState<PreviewMode>('enhanced');
  const [rotation, setRotation] = useState<QuarterTurns>(0);
  const [quad, setQuad] = useState<Quad | null>(null);
  const [style, setStyle] = useState<ScanStyle>(
    () => useScanSettingsStore.getState().style,
  );
  const [adjustments, setAdjustments] = useState<ImageAdjustments>(
    () => useScanSettingsStore.getState().adjustments,
  );
  const [busy, setBusy] = useState(false);

  // A newly opened file starts from the remembered finish, unrotated and with
  // no corners of its own. The "info from previous render" pattern rather than
  // a setState in the effect below.
  const openFile = isOpen ? file : null;
  const [openedFor, setOpenedFor] = useState<File | null>(null);
  if (openedFor !== openFile) {
    setOpenedFor(openFile);
    if (openFile) {
      // Read the remembered values once, at open, without subscribing: a change
      // the user makes to the finish mid-session must not re-open and re-scan.
      const remembered = useScanSettingsStore.getState();
      setMode('enhanced');
      setRotation(0);
      setQuad(null);
      setStyle(remembered.style);
      setAdjustments(remembered.adjustments);
    }
  }

  // Scan whatever file the parent hands over, and forget the previous result
  // when the dialog closes so a reopen never shows the last document.
  useEffect(() => {
    if (!isOpen || !file) {
      reset();
      return;
    }
    void scan(file, useScanSettingsStore.getState().style);
  }, [isOpen, file, scan, reset]);

  // Adopt the detected corners once, so dragging starts from the detection
  // rather than from the whole frame.
  const detectedQuad = scanner.result?.quad ?? null;
  const [adoptedFor, setAdoptedFor] = useState<Quad | null>(null);
  if (detectedQuad && adoptedFor !== detectedQuad && quad === null) {
    setAdoptedFor(detectedQuad);
    setQuad(detectedQuad);
  }

  const source = scanner.source;
  /**
   * What the pipeline produced, with everything the user changed since.
   *
   * Two stages, and neither of them is the pipeline: brightness and contrast
   * are a lookup per pixel, a quarter turn is a permutation of them. Both work
   * on pixels that are already computed, so they happen here rather than by
   * re-running the scan -- which took seconds per press and queued if pressed
   * again. Memoized separately so changing one does not redo the other.
   */
  const adjusted = useMemo(() => {
    const produced = scanner.result?.enhanced ?? null;
    return produced ? adjustImage(produced, adjustments) : null;
  }, [scanner.result, adjustments]);
  const enhanced = useMemo(
    () => (adjusted ? rotateImage(adjusted, rotation) : null),
    [adjusted, rotation],
  );
  const shown = mode === 'enhanced' ? enhanced : source;
  const paint = useCanvasPainter(shown);

  const display = useMemo(
    () => (shown ? previewSize(shown) : { width: 0, height: 0 }),
    [shown],
  );

  // Taken apart here so the JSX reads plain values: the container ref is the
  // only ref among them, and only the frame's `ref` prop receives it.
  const {
    containerRef: zoomContainerRef,
    containerProps: zoomContainerProps,
    contentStyle: zoomContentStyle,
    zoomed,
    reset: resetZoom,
  } = useImageZoom(display.width, display.height);
  // Reset magnification whenever the shown image changes for a reason other than
  // a brightness or finish tweak: a new photo, the Original/Enhanced toggle, or
  // a rotation. Tracked across renders rather than in an effect (the codebase's
  // set-state-in-effect rule), and guarded so it runs only on an actual change.
  const [zoomDeps, setZoomDeps] = useState({ source, mode, rotation });
  if (
    zoomDeps.source !== source ||
    zoomDeps.mode !== mode ||
    zoomDeps.rotation !== rotation
  ) {
    setZoomDeps({ source, mode, rotation });
    resetZoom();
  }

  const originalTooLarge = !!file && file.size > MAX_ATTACHMENT_BYTES;

  const handleCornerCommit = useCallback(
    (next: Quad) => {
      setQuad(next);
      void refine({ quad: next, style });
    },
    [refine, style],
  );

  // A style change re-runs the finish over the crop that is already made; the
  // corners travel with it so the hook can tell that is all it needs to do.
  const handleStyleChange = useCallback(
    (next: ScanStyle) => {
      setStyle(next);
      rememberStyle(next);
      const corners = quad ?? scanner.result?.quad;
      if (corners) void refine({ quad: corners, style: next });
    },
    [quad, refine, rememberStyle, scanner.result],
  );

  const handleAdjustment = useCallback(
    (field: keyof ImageAdjustments, value: number) => {
      // Live update only. Persistence is deferred to the end of the gesture so
      // a slider does not serialize the store to localStorage on every tick.
      setAdjustments((current) => ({ ...current, [field]: value }));
    },
    [],
  );

  // Store the offsets once the drag or keypress settles, not per tick.
  const rememberAdjustmentsNow = useCallback(() => {
    rememberAdjustments(adjustments);
  }, [adjustments, rememberAdjustments]);

  const handleResetAdjustments = useCallback(() => {
    setAdjustments(NEUTRAL_ADJUSTMENTS);
    rememberAdjustments(NEUTRAL_ADJUSTMENTS);
  }, [rememberAdjustments]);

  // No scan, no worker, no round trip: the turn applies to pixels that already
  // exist, so the preview follows the click.
  const handleRotate = useCallback(() => {
    setRotation((current) => ((current + 1) % 4) as QuarterTurns);
  }, []);

  const handleUseEnhanced = useCallback(async () => {
    if (!enhanced || !file) return;
    setBusy(true);
    try {
      const scanFile = await encodeScan(enhanced, scanFilename(file.name));
      // The original is dropped rather than silently rejected when it is over
      // the attachment limit; the copy beside the button says so.
      onAccept(
        originalTooLarge
          ? { file: scanFile }
          : { file: scanFile, original: file },
      );
    } finally {
      setBusy(false);
    }
  }, [enhanced, file, onAccept, originalTooLarge]);

  const handleKeepOriginal = useCallback(() => {
    if (!file) return;
    onAccept({ file });
  }, [file, onAccept]);

  const warnings: QualityWarning[] = scanner.result?.warnings ?? [];
  const status = scanner.status;

  const footer = (
    <div className="flex flex-wrap justify-end gap-2">
      <Button type="button" variant="outline" onClick={onCancel}>
        {t('scan.cancel')}
      </Button>
      <Button type="button" variant="outline" onClick={onRetake}>
        {t('scan.retake')}
      </Button>
      <Button
        type="button"
        variant="outline"
        onClick={handleKeepOriginal}
        // An original over the attachment limit is one the server will refuse,
        // so offering to keep it alone is offering a 413. The notice beside the
        // preview says why; the scan itself is still acceptable.
        disabled={!file || originalTooLarge}
      >
        {t('scan.keepOriginal')}
      </Button>
      <Button
        type="button"
        variant="primary"
        onClick={handleUseEnhanced}
        isLoading={busy}
        // The preview is what gets stored (`I3`), so while a warp or a finish
        // is in flight the button would hand back the image the user just
        // changed away from.
        disabled={status !== 'ready' || !enhanced || scanner.recomputing}
      >
        {t('scan.useEnhanced')}
      </Button>
    </div>
  );

  return (
    <Modal
      isOpen={isOpen}
      onClose={onCancel}
      title={t('scan.title')}
      description={t('scan.description')}
      maxWidth="2xl"
      padding="md"
      pushHistory
      footer={footer}
    >
      <div className="space-y-4">
        {status === 'loading' && (
          <div
            className="flex flex-col items-center gap-3 py-10"
            aria-busy="true"
          >
            <LoadingSpinner />
            <p className="text-sm text-gray-600 dark:text-gray-300">
              {t('scan.analysing')}
            </p>
          </div>
        )}

        {status === 'failed' && (
          <div
            role="alert"
            className="rounded-md border border-red-300 bg-red-50 p-4 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200"
          >
            <p>{t('scan.failed')}</p>
            {scanner.error && (
              <p className="mt-1 text-xs opacity-80">{scanner.error}</p>
            )}
          </div>
        )}

        {status === 'ready' && shown && (
          <>
            <div className="flex flex-wrap items-center gap-2">
              {/* A segmented control rather than a tablist: the register's
                  Tabs component owns `role="tablist"`, and this is a preview
                  switch inside a dialog, not page navigation. Never primary
                  buttons, which would put a second primary beside Use
                  Enhanced. */}
              <div role="group" aria-label={t('preview.versionLabel')} className={SEGMENTED_GROUP_CLASS}>
                <button
                  type="button"
                  onClick={() => setMode('enhanced')}
                  aria-pressed={mode === 'enhanced'}
                  className={segmentClass(mode === 'enhanced')}
                >
                  {t('scan.viewEnhanced')}
                </button>
                <button
                  type="button"
                  onClick={() => setMode('original')}
                  aria-pressed={mode === 'original'}
                  className={segmentClass(mode === 'original')}
                >
                  {t('scan.viewOriginal')}
                </button>
              </div>
              {/* Only the scan turns. The original is stored byte-for-byte
                  as the device produced it (`I2`), so a Rotate button beside
                  it would promise something this dialog will not do. */}
              {mode === 'enhanced' && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={handleRotate}
                >
                  {t('scan.rotate')}
                </Button>
              )}
            </div>

            <div className="flex justify-center">
              <div
                ref={zoomContainerRef}
                className="relative rounded-md"
                style={{
                  width: display.width,
                  height: display.height,
                  ...zoomContainerProps.style,
                }}
                onPointerDown={zoomContainerProps.onPointerDown}
                onPointerMove={zoomContainerProps.onPointerMove}
                onPointerUp={zoomContainerProps.onPointerUp}
                onPointerCancel={zoomContainerProps.onPointerCancel}
              >
                {/* The canvas and its overlay are magnified together, so the
                    corners keep tracking the paper when the image is zoomed. */}
                <div className="absolute inset-0" style={zoomContentStyle}>
                  <canvas
                    ref={paint}
                    className="h-full w-full rounded-md bg-gray-100 object-contain dark:bg-gray-800"
                    aria-label={
                      mode === 'enhanced'
                        ? t('scan.previewEnhancedAlt')
                        : t('scan.previewOriginalAlt')
                    }
                    role="img"
                  />
                  {/* The corners belong to the photo, so they are only drawn
                      over it -- placed over the enhanced image they would point
                      at coordinates that no longer exist. While the image is
                      magnified the drag pans instead, so the handles are idle. */}
                  {mode === 'original' && quad && source && (
                    <DocumentCornerHandles
                      quad={quad}
                      imageWidth={source.width}
                      imageHeight={source.height}
                      displayWidth={display.width}
                      displayHeight={display.height}
                      onChange={setQuad}
                      onCommit={handleCornerCommit}
                      disabled={zoomed}
                    />
                  )}
                </div>
              </div>
            </div>

            {/* Quality warnings sit directly under the preview, on both views,
                so a document running off the frame is seen on the default
                Enhanced card and not buried below the finish controls. */}
            {scanner.result && !scanner.result.documentFound && (
              <p className="text-sm text-gray-600 dark:text-gray-300">
                {t('scan.noDocumentFound')}
              </p>
            )}

            {warnings.length > 0 && (
              <ul className="space-y-1 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">
                {warnings.map((warning) => (
                  <li key={warning}>{t(`scan.warnings.${warning}`)}</li>
                ))}
              </ul>
            )}

            {/* The finish and the two repairs, on the scan alone: the photo is
                stored exactly as the device produced it (`I2`), so nothing
                here is offered beside it. */}
            {mode === 'enhanced' && (
              <div className="space-y-4 rounded-md border border-gray-200 p-3 dark:border-gray-700">
                <Select
                  label={t('scan.styleLabel')}
                  value={style}
                  onChange={(event) =>
                    handleStyleChange(event.target.value as ScanStyle)
                  }
                  options={SCAN_STYLES.map((option) => ({
                    value: option,
                    label: t(`scan.styles.${option}`),
                  }))}
                />
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  {t(`scan.styleHints.${style}`)}
                </p>

                {ADJUSTMENT_FIELDS.map((field) => (
                  <div key={field}>
                    <label
                      htmlFor={`scan-${field}`}
                      className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300"
                    >
                      {t(`scan.adjustments.${field}`, {
                        value: formatNumber(adjustments[field], 0),
                      })}
                    </label>
                    <input
                      id={`scan-${field}`}
                      type="range"
                      min={-ADJUSTMENT_RANGE}
                      max={ADJUSTMENT_RANGE}
                      value={adjustments[field]}
                      onChange={(event) =>
                        handleAdjustment(field, Number(event.target.value))
                      }
                      // Persist when the drag or keypress settles, not per tick.
                      onPointerUp={rememberAdjustmentsNow}
                      onKeyUp={rememberAdjustmentsNow}
                      onBlur={rememberAdjustmentsNow}
                      className="h-2 w-full cursor-pointer appearance-none rounded-lg bg-gray-200 accent-blue-600 dark:bg-gray-600"
                    />
                  </div>
                ))}

                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={handleResetAdjustments}
                  disabled={isNeutral(adjustments)}
                >
                  {t('scan.resetAdjustments')}
                </Button>
              </div>
            )}

            {/* A re-warp keeps the previous preview on screen rather than
                blanking it, so without this the picture simply looks like it
                ignored the drag. */}
            {scanner.recomputing && (
              <p
                className="text-center text-xs text-gray-500 dark:text-gray-400"
                aria-live="polite"
              >
                {t('scan.updating')}
              </p>
            )}

            {mode === 'enhanced' && !scanner.recomputing && (
              <p className="text-center text-xs text-gray-500 dark:text-gray-400">
                {t('scan.adjustHint')}
              </p>
            )}

            {originalTooLarge && (
              <p className="text-sm text-gray-600 dark:text-gray-300">
                {t('scan.originalTooLarge', {
                  max: formatBytes(MAX_ATTACHMENT_BYTES),
                })}
              </p>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
