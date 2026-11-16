import type { OpenCv } from './opencv-engine';
import {
  DETECT_MAX_EDGE,
  MIN_DOCUMENT_AREA_RATIO,
  OUTPUT_MAX_EDGE,
  clampToFrame,
  fitScale,
  fullFrameQuad,
  isConvexQuad,
  orderCorners,
  outputSize,
  quadArea,
  scaleQuad,
} from './document-scan-geometry';
import type {
  Point,
  Quad,
  RawImage,
  ScanStyle,
} from './document-scan.types';

/**
 * The image operations, in the order Discussion #1292 lays them out: find the
 * document, correct its perspective, even out the lighting, then sharpen.
 *
 * Every constant is named here rather than inlined, because these are the
 * numbers somebody will need to retune against real photographs, and a
 * magic `2.0` three calls deep is not tunable. The geometry the steps depend on
 * lives in `document-scan-geometry.ts`, so this file is only the pixels.
 *
 * `cv` is a parameter rather than an import: it keeps the OpenCV import in one
 * module (`I7`), and it makes each step callable from a test that supplies the
 * real engine without this file deciding when the engine loads.
 */

/** Gaussian blur kernel used to quiet sensor noise before edge detection. */
const DETECT_BLUR_KERNEL = 5;
/** Canny thresholds, as fractions of the working image's median intensity. */
const CANNY_LOW_RATIO = 0.66;
const CANNY_HIGH_RATIO = 1.33;
/** Dilation that closes the small gaps a printed border leaves in an edge map. */
const EDGE_DILATE_KERNEL = 3;
/** How closely a contour must match a quadrilateral, as a share of perimeter. */
const POLY_EPSILON_RATIO = 0.02;

/**
 * Saturation fallback, used only when the edge detector finds no quadrilateral.
 *
 * A grey page on a wooden desk has almost no brightness edge where its border
 * meets the wood, and a hand's shadow breaks whatever edge is left, so Canny
 * returns arcs that approximate to nothing. But paper is grey wherever the
 * light is even or not, and wood is not, so the page is the largest LOW-
 * SATURATION region regardless of the shadow. This is a fallback, not a
 * replacement: the edge detector still runs first, and this only decides the
 * case it would otherwise hand back as "whole frame, nothing found".
 */
const SATURATION_MAX = 65;
/** Kernel that closes the gaps text and specular glare leave in the page mask. */
const SATURATION_KERNEL = 25;
/**
 * The most of the frame the page may cover. A frame that is low-saturation edge
 * to edge -- a grey test fixture, a blank wall -- has no surround to tell the
 * page from, so a near-total cover is "no document found", not "the document
 * fills the frame". The lower bound reuses `MIN_DOCUMENT_AREA_RATIO`, the same
 * "smallest share that is a document" the edge detector applies.
 */
const SATURATION_MAX_COVER = 0.97;

/** Kernel of the morphological close that estimates the page's illumination. */
const ILLUMINATION_KERNEL = 31;
/**
 * Floor under the illumination estimate before the division.
 *
 * `255 * channel / background` amplifies noise by `255 / background`, so a dark
 * region the crop should not have contained -- a hand's shadow, the desk beside
 * a page detection missed -- turns faint sensor grain into loud speckle (bg 22
 * amplifies roughly eleven times). Real paper under a shadow does not fall this
 * far, so clamping the estimate up to this level caps the gain at about
 * `255 / 48` without touching the gradient across a genuine page. Two more
 * guards sit beside it in `enhance`: the denoise runs BEFORE the division, so
 * what is amplified is already clean, and the divisor is a single luminance
 * estimate shared by all three channels, so amplified noise stays neutral
 * instead of splitting into colour speckle.
 */
const ILLUMINATION_MIN_BACKGROUND = 48;
/** CLAHE parameters for local contrast, applied to lightness only. */
const CLAHE_CLIP_LIMIT = 2.0;
const CLAHE_TILE = 8;
/** Bilateral filter: smooths paper grain while keeping glyph edges crisp. */
const DENOISE_DIAMETER = 5;
const DENOISE_SIGMA_COLOR = 50;
const DENOISE_SIGMA_SPACE = 50;
/** Unsharp mask strength. */
const SHARPEN_SIGMA = 1;
const SHARPEN_AMOUNT = 0.6;

/**
 * Adaptive threshold for the black-and-white finish.
 *
 * The block is the neighbourhood each pixel's threshold is computed over, so it
 * has to be comfortably larger than a glyph and smaller than the lighting
 * gradient across the page -- which is what makes the threshold correct the
 * illumination by itself, with no separate normalisation step. `C` is
 * subtracted from that local mean: a positive value biases towards white, which
 * keeps paper grain from surviving as speckle.
 */
const THRESHOLD_BLOCK = 25;
const THRESHOLD_C = 10;

/** Everything allocated inside one step, released even when a step throws. */
class Scope {
  private readonly items: { delete(): void }[] = [];

  add<T extends { delete(): void }>(item: T): T {
    this.items.push(item);
    return item;
  }

  release(): void {
    // Reverse order, so a Mat built from another is freed first.
    for (const item of this.items.reverse()) {
      try {
        item.delete();
      } catch {
        // A double delete is not worth failing a scan over; the runtime's heap
        // is discarded with the worker anyway.
      }
    }
    this.items.length = 0;
  }
}

/** Wrap OpenCV work so its Mats are freed on every path. */
function withScope<T>(fn: (scope: Scope) => T): T {
  const scope = new Scope();
  try {
    return fn(scope);
  } finally {
    scope.release();
  }
}

/** Build a Mat from a decoded image. */
function toMat(cv: OpenCv, image: RawImage): InstanceType<OpenCv['Mat']> {
  const mat = new cv.Mat(image.height, image.width, cv.CV_8UC4);
  mat.data.set(image.data);
  return mat;
}

/** Copy a Mat back out as plain transferable data. */
function toRawImage(mat: {
  rows: number;
  cols: number;
  data: Uint8Array;
}): RawImage {
  return {
    width: mat.cols,
    height: mat.rows,
    data: new Uint8ClampedArray(mat.data),
  };
}

/** The median intensity of a single-channel Mat, for adaptive Canny bounds. */
function medianIntensity(gray: { data: Uint8Array }): number {
  const histogram = new Uint32Array(256);
  for (const value of gray.data) histogram[value]++;
  const half = gray.data.length / 2;
  let seen = 0;
  for (let value = 0; value < 256; value++) {
    seen += histogram[value];
    if (seen >= half) return value;
  }
  return 128;
}

/**
 * Find the document's corners, or report that there is no document-shaped
 * quadrilateral in the frame.
 *
 * Runs on a reduced copy: edge detection is dominated by noise at full
 * resolution and a 12-megapixel photo costs seconds for a result that is no
 * better. The corners come back in FULL-image coordinates, so callers never
 * have to know a working copy existed.
 */
export function detectDocument(
  cv: OpenCv,
  image: RawImage,
): { quad: Quad; found: boolean } {
  return withScope((scope) => {
    const source = scope.add(toMat(cv, image));
    const scale = fitScale(image.width, image.height, DETECT_MAX_EDGE);

    const working = scope.add(new cv.Mat());
    if (scale < 1) {
      cv.resize(
        source,
        working,
        new cv.Size(
          Math.max(1, Math.round(image.width * scale)),
          Math.max(1, Math.round(image.height * scale)),
        ),
        0,
        0,
        cv.INTER_AREA,
      );
    } else {
      source.copyTo(working);
    }

    const gray = scope.add(new cv.Mat());
    cv.cvtColor(working, gray, cv.COLOR_RGBA2GRAY);
    const blurred = scope.add(new cv.Mat());
    cv.GaussianBlur(
      gray,
      blurred,
      new cv.Size(DETECT_BLUR_KERNEL, DETECT_BLUR_KERNEL),
      0,
      0,
      cv.BORDER_DEFAULT,
    );

    const median = medianIntensity(blurred as unknown as { data: Uint8Array });
    const edges = scope.add(new cv.Mat());
    cv.Canny(
      blurred,
      edges,
      Math.max(0, CANNY_LOW_RATIO * median),
      Math.min(255, CANNY_HIGH_RATIO * median),
    );
    // Close the hairline breaks a dashed border or a fold leaves behind, which
    // otherwise split the page outline into arcs that approximate to nothing.
    const dilateKernel = scope.add(
      cv.getStructuringElement(
        cv.MORPH_RECT,
        new cv.Size(EDGE_DILATE_KERNEL, EDGE_DILATE_KERNEL),
      ),
    );
    cv.dilate(edges, edges, dilateKernel);

    const contours = scope.add(new cv.MatVector());
    const hierarchy = scope.add(new cv.Mat());
    cv.findContours(
      edges,
      contours,
      hierarchy,
      cv.RETR_LIST,
      cv.CHAIN_APPROX_SIMPLE,
    );

    const frameArea = working.cols * working.rows;
    let best: { quad: Quad; area: number } | null = null;

    for (let i = 0; i < contours.size(); i++) {
      const contour = contours.get(i);
      const approx = new cv.Mat();
      try {
        const perimeter = cv.arcLength(contour, true);
        cv.approxPolyDP(contour, approx, POLY_EPSILON_RATIO * perimeter, true);
        if (approx.rows !== 4) continue;

        const points: Point[] = [];
        for (let p = 0; p < 4; p++) {
          points.push({
            x: approx.intAt(p, 0),
            y: approx.intAt(p, 1),
          });
        }
        const quad = orderCorners(points);
        if (!isConvexQuad(quad)) continue;

        const area = quadArea(quad);
        if (area < frameArea * MIN_DOCUMENT_AREA_RATIO) continue;
        if (!best || area > best.area) best = { quad, area };
      } finally {
        approx.delete();
        contour.delete();
      }
    }

    if (!best) {
      // Nothing edge-shaped. Before falling back to the whole frame, try the
      // saturation route: a grey page on wood has no reliable brightness edge
      // but is the largest low-saturation region, shadow or no shadow.
      const bySaturation = detectByLowSaturation(cv, image);
      if (bySaturation) return { quad: bySaturation, found: true };
      // Still nothing: the rest of the pipeline runs on the whole frame, so the
      // user gets a lighting-corrected photo and a quad they can drag.
      return { quad: fullFrameQuad(image.width, image.height), found: false };
    }
    return { quad: scaleQuad(best.quad, 1 / scale), found: true };
  });
}

/**
 * Find the page as the largest low-saturation region.
 *
 * The fallback `detectDocument` reaches for when no quadrilateral edge survives.
 * Paper is grey -- low saturation -- under a shadow as much as in full light,
 * and a wooden desk, a coloured folder or a patterned cloth is not, so the page
 * is the largest low-saturation blob even where its border carries no brightness
 * edge for Canny to find.
 *
 * Returns `null` -- "still no document" -- when the low-saturation region is too
 * small to be a page, or so large it fills the frame: a frame that is grey edge
 * to edge (a blank wall, a grey test fixture) has no surround to tell the page
 * from. Corners come back in FULL-image coordinates, like every detector here.
 */
export function detectByLowSaturation(cv: OpenCv, image: RawImage): Quad | null {
  return withScope((scope) => {
    const source = scope.add(toMat(cv, image));
    const scale = fitScale(image.width, image.height, DETECT_MAX_EDGE);
    const working = scope.add(new cv.Mat());
    if (scale < 1) {
      cv.resize(
        source,
        working,
        new cv.Size(
          Math.max(1, Math.round(image.width * scale)),
          Math.max(1, Math.round(image.height * scale)),
        ),
        0,
        0,
        cv.INTER_AREA,
      );
    } else {
      source.copyTo(working);
    }

    const rgb = scope.add(new cv.Mat());
    cv.cvtColor(working, rgb, cv.COLOR_RGBA2RGB);
    const hsv = scope.add(new cv.Mat());
    cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
    const channels = scope.add(new cv.MatVector());
    cv.split(hsv, channels);
    const saturation = scope.add(channels.get(1));

    const mask = scope.add(new cv.Mat());
    // Below the threshold is "grey enough to be paper".
    cv.threshold(saturation, mask, SATURATION_MAX, 255, cv.THRESH_BINARY_INV);
    const kernel = scope.add(
      cv.getStructuringElement(
        cv.MORPH_RECT,
        new cv.Size(SATURATION_KERNEL, SATURATION_KERNEL),
      ),
    );
    // Close first to bridge the text and glare inside the page, then open to
    // drop the stray low-saturation flecks the surround leaves behind.
    cv.morphologyEx(mask, mask, cv.MORPH_CLOSE, kernel);
    cv.morphologyEx(mask, mask, cv.MORPH_OPEN, kernel);

    const contours = scope.add(new cv.MatVector());
    const hierarchy = scope.add(new cv.Mat());
    cv.findContours(
      mask,
      contours,
      hierarchy,
      cv.RETR_EXTERNAL,
      cv.CHAIN_APPROX_SIMPLE,
    );

    const frameArea = working.cols * working.rows;
    let best: { index: number; area: number } | null = null;
    for (let i = 0; i < contours.size(); i++) {
      const area = cv.contourArea(contours.get(i));
      if (!best || area > best.area) best = { index: i, area };
    }
    if (!best) return null;
    const cover = best.area / frameArea;
    if (cover < MIN_DOCUMENT_AREA_RATIO || cover > SATURATION_MAX_COVER) {
      return null;
    }

    // The page is rarely a clean quadrilateral in the mask -- glare and the
    // shadow bite into it -- so its minimal enclosing rectangle is a steadier
    // read of the four corners than an `approxPolyDP` of the ragged contour.
    const rect = cv.minAreaRect(contours.get(best.index));
    const box = cv.RotatedRect.points(rect) as Point[];
    const corners = box.map((p) =>
      clampToFrame({ x: p.x / scale, y: p.y / scale }, image.width, image.height),
    );
    const quad = orderCorners(corners);
    return isConvexQuad(quad) ? quad : null;
  });
}

/**
 * Flatten the document to a rectangle.
 *
 * The perspective transform corrects skew as well as tilt -- a rotated page maps
 * onto the output rectangle by the same matrix -- so there is no separate
 * deskew step.
 *
 * The user's own quarter turns are NOT applied here. They depend on none of
 * this work, and applying them here meant re-warping and re-enhancing the
 * whole photo for each one; they are a permutation of the finished pixels
 * instead (`rotate-image.ts`).
 */
export function warpToQuad(cv: OpenCv, image: RawImage, quad: Quad): RawImage {
  return withScope((scope) => {
    const source = scope.add(toMat(cv, image));
    const size = outputSize(quad);

    const from = scope.add(
      cv.matFromArray(
        4,
        1,
        cv.CV_32FC2,
        quad.flatMap((p) => [p.x, p.y]),
      ),
    );
    const to = scope.add(
      cv.matFromArray(4, 1, cv.CV_32FC2, [
        0,
        0,
        size.width,
        0,
        size.width,
        size.height,
        0,
        size.height,
      ]),
    );
    const transform = scope.add(cv.getPerspectiveTransform(from, to));
    const warped = scope.add(new cv.Mat());
    cv.warpPerspective(
      source,
      warped,
      transform,
      new cv.Size(size.width, size.height),
      cv.INTER_LINEAR,
      cv.BORDER_CONSTANT,
      new cv.Scalar(255, 255, 255, 255),
    );

    return toRawImage(
      warped as unknown as { rows: number; cols: number; data: Uint8Array },
    );
  });
}

/**
 * Denoise, even out the lighting, lift local contrast, then sharpen.
 *
 * The illumination estimate is a large morphological close, which keeps only
 * what varies slowly across the page -- the shadow of the hand holding the
 * phone, the falloff of a desk lamp. Dividing it out removes the gradient
 * without touching the glyphs, which is what makes the result read as a scan
 * rather than a brightened photo.
 *
 * Two things keep that division from amplifying sensor noise into colour
 * speckle where the crop caught something darker than paper: the denoise runs
 * first, so the pixels it multiplies are already clean, and the estimate is
 * floored (`ILLUMINATION_MIN_BACKGROUND`), so no region can drive the gain
 * arbitrarily high.
 */
export function enhance(cv: OpenCv, image: RawImage): RawImage {
  return withScope((scope) => {
    const source = scope.add(toMat(cv, image));
    const rgb = scope.add(new cv.Mat());
    cv.cvtColor(source, rgb, cv.COLOR_RGBA2RGB);

    // 1. Denoise FIRST, keeping edges. The illumination division below
    // multiplies whatever reaches it, so it has to reach it clean: denoising
    // afterwards can only smooth noise the division has already amplified.
    const denoised = scope.add(new cv.Mat());
    cv.bilateralFilter(
      rgb,
      denoised,
      DENOISE_DIAMETER,
      DENOISE_SIGMA_COLOR,
      DENOISE_SIGMA_SPACE,
      cv.BORDER_DEFAULT,
    );

    // 2. Illumination normalisation from a SINGLE luminance estimate.
    //
    // The background is estimated on grayscale and the one estimate divides all
    // three channels, so the gain is neutral: a dark region -- a shadow on the
    // page, the desk a failed detection left in frame -- is lifted or left in
    // its own colour, never split into per-channel speckle. Dividing each
    // channel by its OWN background is what turned neutral sensor grain into the
    // rainbow noise; one shared divisor cannot.
    const gray = scope.add(new cv.Mat());
    cv.cvtColor(denoised, gray, cv.COLOR_RGB2GRAY);
    const kernel = scope.add(
      cv.getStructuringElement(
        cv.MORPH_RECT,
        new cv.Size(ILLUMINATION_KERNEL, ILLUMINATION_KERNEL),
      ),
    );
    const background = scope.add(new cv.Mat());
    cv.morphologyEx(gray, background, cv.MORPH_CLOSE, kernel);
    // Clamp the estimate up to a floor so a genuinely dark region cannot drive
    // the gain sky-high. `cv.max` needs a Mat, not a scalar, in this build.
    const floor = scope.add(
      new cv.Mat(
        background.rows,
        background.cols,
        background.type(),
        new cv.Scalar(ILLUMINATION_MIN_BACKGROUND),
      ),
    );
    cv.max(background, floor, background);
    // Replicate the single estimate to three channels so one gain lands on R,
    // G and B alike.
    const backgroundChannels = scope.add(new cv.MatVector());
    backgroundChannels.push_back(background);
    backgroundChannels.push_back(background);
    backgroundChannels.push_back(background);
    const background3 = scope.add(new cv.Mat());
    cv.merge(backgroundChannels, background3);
    const normalised = scope.add(new cv.Mat());
    // 255 * channel / background: where the background is dark the pixel is
    // lifted by the same factor, so a shadowed corner ends up as bright as the
    // rest of the page instead of merely less dark -- but only down to the
    // floor, past which the region is not paper and lifting it only amplifies.
    cv.divide(denoised, background3, normalised, 255, cv.CV_8U);

    // 3. Local contrast on lightness only, so colours are not pushed around.
    const lab = scope.add(new cv.Mat());
    cv.cvtColor(normalised, lab, cv.COLOR_RGB2Lab);
    const channels = scope.add(new cv.MatVector());
    cv.split(lab, channels);
    const lightness = scope.add(channels.get(0));
    const clahe = scope.add(
      new cv.CLAHE(CLAHE_CLIP_LIMIT, new cv.Size(CLAHE_TILE, CLAHE_TILE)),
    );
    clahe.apply(lightness, lightness);
    channels.set(0, lightness);
    const merged = scope.add(new cv.Mat());
    cv.merge(channels, merged);
    const contrasted = scope.add(new cv.Mat());
    cv.cvtColor(merged, contrasted, cv.COLOR_Lab2RGB);

    // 4. Unsharp mask: the image plus its own high frequencies.
    const blurred = scope.add(new cv.Mat());
    cv.GaussianBlur(
      contrasted,
      blurred,
      new cv.Size(0, 0),
      SHARPEN_SIGMA,
      SHARPEN_SIGMA,
      cv.BORDER_DEFAULT,
    );
    const sharpened = scope.add(new cv.Mat());
    cv.addWeighted(
      contrasted,
      1 + SHARPEN_AMOUNT,
      blurred,
      -SHARPEN_AMOUNT,
      0,
      sharpened,
    );

    const rgba = scope.add(new cv.Mat());
    cv.cvtColor(sharpened, rgba, cv.COLOR_RGB2RGBA);
    return toRawImage(
      rgba as unknown as { rows: number; cols: number; data: Uint8Array },
    );
  });
}

/**
 * Drop the colour, keeping the enhancement.
 *
 * A phone photographing paper under artificial light gives it a cast the eye
 * ignores and a JPEG does not; a receipt has no colour worth the bytes anyway.
 * The conversion is OpenCV's luminance-weighted one, not an average of the
 * channels, so red ink does not come out the same grey as the paper.
 */
export function desaturate(cv: OpenCv, image: RawImage): RawImage {
  return withScope((scope) => {
    const source = scope.add(toMat(cv, image));
    const gray = scope.add(new cv.Mat());
    cv.cvtColor(source, gray, cv.COLOR_RGBA2GRAY);
    const rgba = scope.add(new cv.Mat());
    cv.cvtColor(gray, rgba, cv.COLOR_GRAY2RGBA);
    return toRawImage(
      rgba as unknown as { rows: number; cols: number; data: Uint8Array },
    );
  });
}

/**
 * Reduce the page to ink and paper.
 *
 * Deliberately taken from the WARPED image rather than from the enhanced one:
 * the enhancement ends in an unsharp mask, which puts a bright halo around
 * every glyph, and a threshold turns those halos into a broken outline. The
 * adaptive threshold does its own illumination correction -- each pixel is
 * compared against the mean of its own neighbourhood -- so the normalisation
 * step it would inherit is not merely unnecessary, it is applied twice.
 */
function threshold(cv: OpenCv, image: RawImage): RawImage {
  return withScope((scope) => {
    const source = scope.add(toMat(cv, image));
    const gray = scope.add(new cv.Mat());
    cv.cvtColor(source, gray, cv.COLOR_RGBA2GRAY);
    const mono = scope.add(new cv.Mat());
    cv.adaptiveThreshold(
      gray,
      mono,
      255,
      cv.ADAPTIVE_THRESH_GAUSSIAN_C,
      cv.THRESH_BINARY,
      THRESHOLD_BLOCK,
      THRESHOLD_C,
    );
    const rgba = scope.add(new cv.Mat());
    cv.cvtColor(mono, rgba, cv.COLOR_GRAY2RGBA);
    return toRawImage(
      rgba as unknown as { rows: number; cols: number; data: Uint8Array },
    );
  });
}

/**
 * Finish a warped document the way the user asked for.
 *
 * The one place a style becomes pixels, so a scan and a later restyle cannot
 * disagree about what a style means -- the same rule as "a preview computes
 * what the commit will do, through the same code", one level down.
 */
export function applyStyle(
  cv: OpenCv,
  warped: RawImage,
  style: ScanStyle,
): RawImage {
  switch (style) {
    case 'none':
      // The crop, deskewed and otherwise untouched. Not a no-op by accident:
      // it is the answer whenever the enhancement fights the subject.
      return warped;
    case 'grayscale':
      return desaturate(cv, enhance(cv, warped));
    case 'blackAndWhite':
      return threshold(cv, warped);
    case 'colour':
      return enhance(cv, warped);
  }
}

/**
 * Reduce an image so its longest edge fits the upload ceiling.
 *
 * A phone photo warped at full resolution can exceed the 10 MB attachment
 * limit as a JPEG, and a document does not become more readable above a couple
 * of thousand pixels on its long edge.
 *
 * Applied to the WARP, before any finish. Two reasons, and the second is the
 * one that matters: enhancing 12 megapixels and then throwing four fifths of
 * them away costs seconds for detail that never reaches the file, and the
 * finish is a fixed-pixel neighbourhood everywhere -- a 31 px illumination
 * kernel, a 25 px threshold block -- so running it before the resize would make
 * the result depend on the camera's resolution rather than the document's.
 */
export function limitSize(cv: OpenCv, image: RawImage): RawImage {
  const scale = fitScale(image.width, image.height, OUTPUT_MAX_EDGE);
  if (scale === 1) return image;
  return withScope((scope) => {
    const source = scope.add(toMat(cv, image));
    const resized = scope.add(new cv.Mat());
    cv.resize(
      source,
      resized,
      new cv.Size(
        Math.max(1, Math.round(image.width * scale)),
        Math.max(1, Math.round(image.height * scale)),
      ),
      0,
      0,
      cv.INTER_AREA,
    );
    return toRawImage(
      resized as unknown as { rows: number; cols: number; data: Uint8Array },
    );
  });
}
