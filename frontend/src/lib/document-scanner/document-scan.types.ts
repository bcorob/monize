/**
 * The shapes the document scanner passes between the main thread and its
 * worker. Plain data only: everything here has to survive `postMessage`, so
 * there are no class instances, no functions and no OpenCV types.
 *
 * See `docs/specs/document-scanner.md`.
 */

/** One corner of a detected document, in source-image pixels. */
export interface Point {
  x: number;
  y: number;
}

/**
 * A document's four corners, always ordered top-left, top-right,
 * bottom-right, bottom-left. The ordering is what makes a warp reproducible,
 * so it is established once (`orderCorners`) and relied on everywhere after.
 */
export type Quad = readonly [Point, Point, Point, Point];

/** A decoded image, as the worker receives it. */
export interface RawImage {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel, length `width * height * 4`. */
  data: Uint8ClampedArray;
}

/**
 * How a warped document is finished.
 *
 * The finish is separate from the crop on purpose: none of it depends on the
 * corners, so changing it re-runs only this step (`restyle`) rather than
 * warping the photo again.
 *
 * - `colour` -- the full enhancement: illumination, local contrast, sharpening.
 * - `grayscale` -- the same, desaturated. Smaller, and free of the colour cast
 *   a phone gives paper under artificial light.
 * - `blackAndWhite` -- adaptive thresholding straight from the warp. The one
 *   that does not build on `colour`: an unsharp mask puts halos around glyphs,
 *   which a threshold turns into speckle.
 * - `none` -- the deskewed crop, untouched. For anything the enhancement fights:
 *   a photograph, a coloured logo, a chart.
 */
export type ScanStyle = 'colour' | 'grayscale' | 'blackAndWhite' | 'none';

/** Every style, in the order they are offered. */
export const SCAN_STYLES: readonly ScanStyle[] = [
  'colour',
  'grayscale',
  'blackAndWhite',
  'none',
] as const;

/** The style a fresh scan is produced in. */
export const DEFAULT_SCAN_STYLE: ScanStyle = 'colour';

/**
 * Something about the capture that the user may want to fix by retaking the
 * photo. Always a warning and never a refusal: information the user meant to
 * keep is worse lost than imperfect (`I5`).
 */
export type QualityWarning = 'blurry' | 'edgesOutsideFrame' | 'lowResolution';

/** What the pipeline found and produced for one photo. */
export interface ScanResult {
  /** Whether a document-shaped quadrilateral was actually detected. */
  documentFound: boolean;
  /** The corners used for the warp -- the detection, or the full frame. */
  quad: Quad;
  /**
   * The deskewed crop, before any finish is applied.
   *
   * Carried back so a change of style costs one pass over this rather than a
   * second warp of the whole photo. It is already size-limited, so it is also
   * the exact input a `restyle` will be given.
   */
  warped: RawImage;
  /** The finished document image: `warped` with `style` applied. */
  enhanced: RawImage;
  /** Which finish `enhanced` was produced with. */
  style: ScanStyle;
  warnings: QualityWarning[];
}

/** Ask the worker to detect a document and finish it. */
export interface ScanRequest {
  kind: 'scan';
  requestId: number;
  image: RawImage;
  style: ScanStyle;
}

/**
 * Ask the worker to redo the warp and finish for corners the user moved.
 * Detection is not repeated: the user has just overruled it.
 *
 * Deliberately carries no rotation. A quarter turn changes none of this work,
 * and routing it through here made every press of Rotate re-run the whole
 * enhancement -- seconds of it (`rotate-image.ts`).
 */
export interface RewarpRequest {
  kind: 'rewarp';
  requestId: number;
  image: RawImage;
  quad: Quad;
  style: ScanStyle;
}

/**
 * Ask the worker to finish an already-warped document a different way.
 *
 * `image` is a `ScanResult.warped`, so the corners are not re-applied and the
 * photo is not touched: this is the whole of the work a style change needs.
 */
export interface RestyleRequest {
  kind: 'restyle';
  requestId: number;
  image: RawImage;
  style: ScanStyle;
}

export type ScannerRequest = ScanRequest | RewarpRequest | RestyleRequest;

/** A reply carrying a whole scan: the answer to `scan` and `rewarp`. */
export interface ScannerSuccess {
  kind: 'result';
  requestId: number;
  result: ScanResult;
}

/**
 * A reply carrying finished pixels alone: the answer to `restyle`.
 *
 * Deliberately not a `ScanResult`. A restyle is told nothing about the
 * detection or the corners, so a reply shaped like a whole scan could only
 * repeat back what it was sent, or invent it.
 */
export interface ScannerImageSuccess {
  kind: 'image';
  requestId: number;
  image: RawImage;
  style: ScanStyle;
}

export interface ScannerFailure {
  kind: 'error';
  requestId: number;
  message: string;
}

export type ScannerResponse =
  | ScannerSuccess
  | ScannerImageSuccess
  | ScannerFailure;
