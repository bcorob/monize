import { beforeAll, describe, expect, it } from 'vitest';

import { loadEngine, type OpenCv } from './opencv-engine';
import {
  applyStyle,
  desaturate,
  detectByLowSaturation,
  detectDocument,
  enhance,
  limitSize,
  warpToQuad,
} from './document-scan-pipeline';
import { assessCapture, blurVariance } from './document-scan-quality';
import { OUTPUT_MAX_EDGE, outputSize } from './document-scan-geometry';
import {
  DEFAULT_QUAD,
  blankFrame,
  syntheticDocument,
} from './synthetic-document';
import { SCAN_STYLES, type Quad, type RawImage } from './document-scan.types';

/**
 * The pipeline against the REAL OpenCV build, on pictures whose answer is known
 * because we drew them.
 *
 * A double for `cv` here would prove only that the steps were called in order,
 * which is the one thing that was never in doubt: what can be wrong is the
 * corners it finds, the direction it flattens them in, and whether the
 * enhancement makes a shadowed page readable or merely different. That needs
 * real pixels.
 *
 * The engine is loaded once for the file -- it initialises in well under a
 * second, but not per test.
 */
let cv: OpenCv;

beforeAll(async () => {
  cv = await loadEngine();
}, 60_000);

/** How far a detected corner may sit from the planted one, in pixels. */
const CORNER_TOLERANCE = 12;

/**
 * An upright rectangular page, for the saturation detector. Axis-aligned on
 * purpose: its minimal enclosing rectangle is itself, so the detected corners
 * can be checked against the planted ones directly.
 */
const SATURATION_PAGE_QUAD: Quad = [
  { x: 120, y: 100 },
  { x: 600, y: 100 },
  { x: 600, y: 620 },
  { x: 120, y: 620 },
];

function expectNearQuad(found: Quad, expected: Quad): void {
  for (let i = 0; i < 4; i++) {
    expect(Math.abs(found[i].x - expected[i].x)).toBeLessThanOrEqual(
      CORNER_TOLERANCE,
    );
    expect(Math.abs(found[i].y - expected[i].y)).toBeLessThanOrEqual(
      CORNER_TOLERANCE,
    );
  }
}

/** A flat rectangle of one colour, for asking what a finish does to it. */
function solidColour(
  width: number,
  height: number,
  [r, g, b]: [number, number, number],
): RawImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = 255;
  }
  return { width, height, data };
}

/** Mean intensity of a rectangular region, for comparing lighting. */
function meanIntensity(
  image: RawImage,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): number {
  let total = 0;
  let count = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      total += image.data[(y * image.width + x) * 4];
      count++;
    }
  }
  return total / count;
}

/**
 * Mean per-pixel colour spread (max channel minus min), over the whole image.
 *
 * A grey document has almost none; the illumination division, applied to each
 * channel on its own, is what turns neutral sensor grain in a dark region into
 * coloured speckle, so this is the number that catches the speckle returning.
 */
function meanChroma(image: RawImage): number {
  let total = 0;
  let count = 0;
  for (let i = 0; i < image.data.length; i += 4) {
    const r = image.data[i];
    const g = image.data[i + 1];
    const b = image.data[i + 2];
    total += Math.max(r, g, b) - Math.min(r, g, b);
    count++;
  }
  return total / count;
}

describe('detectDocument', () => {
  it('finds the planted corners of a skewed page', () => {
    const image = syntheticDocument();
    const { quad, found } = detectDocument(cv, image);

    expect(found).toBe(true);
    expectNearQuad(quad, DEFAULT_QUAD);
  });

  it('reports the corners in full-image coordinates for a large photo', () => {
    // Twice the detection ceiling, so the working copy is genuinely smaller and
    // a scale-back that was forgotten would halve every coordinate.
    const scale = 3;
    const quad = DEFAULT_QUAD.map((p) => ({
      x: p.x * scale,
      y: p.y * scale,
    })) as unknown as Quad;
    const image = syntheticDocument({
      width: 720 * scale,
      height: 720 * scale,
      quad,
      text: false,
    });

    const detected = detectDocument(cv, image);

    expect(detected.found).toBe(true);
    for (let i = 0; i < 4; i++) {
      expect(Math.abs(detected.quad[i].x - quad[i].x)).toBeLessThanOrEqual(
        CORNER_TOLERANCE * scale,
      );
    }
  });

  // Not finding a document is a normal outcome, not an error: the rest of the
  // pipeline still runs on the whole frame so the user gets something to drag.
  it('falls back to the whole frame when there is no document', () => {
    const image = blankFrame(400, 400);
    const { quad, found } = detectDocument(cv, image);

    expect(found).toBe(false);
    expect(quad).toEqual([
      { x: 0, y: 0 },
      { x: 400, y: 0 },
      { x: 400, y: 400 },
      { x: 0, y: 400 },
    ]);
  });

  it('ignores a mark too small to be the document', () => {
    // A stamp covering ~4% of the frame: well under the area floor.
    const image = syntheticDocument({
      width: 500,
      height: 500,
      quad: [
        { x: 200, y: 200 },
        { x: 300, y: 200 },
        { x: 300, y: 300 },
        { x: 200, y: 300 },
      ],
      text: false,
    });

    expect(detectDocument(cv, image).found).toBe(false);
  });

  // The photo that made this necessary: a grey page whose border carries no
  // brightness edge (a shadow ate it, or the desk is nearly as bright as the
  // paper). Canny finds no quadrilateral, so detection falls through to the
  // saturation route. The surround here is a saturated colour at the SAME
  // luminance as the page, so there is no edge for Canny at all -- only hue
  // separates them.
  it('finds a page by saturation when no brightness edge exists', () => {
    const image = syntheticDocument({
      quad: SATURATION_PAGE_QUAD,
      text: false,
      paper: 200,
      backgroundColor: [255, 190, 150],
    });

    const { quad, found } = detectDocument(cv, image);

    expect(found).toBe(true);
    expectNearQuad(quad, SATURATION_PAGE_QUAD);
  });

  // The control for the case above: same geometry and same luminance, but the
  // surround is grey too, so nothing -- edge or hue -- separates the page from
  // its background and detection correctly reports nothing found. Without this
  // the test above could pass on a detector that simply always finds a page.
  it('reports nothing when neither an edge nor a hue separates the page', () => {
    const image = syntheticDocument({
      quad: SATURATION_PAGE_QUAD,
      text: false,
      paper: 200,
      background: 200,
    });

    expect(detectDocument(cv, image).found).toBe(false);
  });
});

describe('detectByLowSaturation', () => {
  it('returns the page as the low-saturation region on a colour surround', () => {
    const image = syntheticDocument({
      quad: SATURATION_PAGE_QUAD,
      text: false,
      paper: 200,
      backgroundColor: [255, 190, 150],
    });

    const quad = detectByLowSaturation(cv, image);

    expect(quad).not.toBeNull();
    expectNearQuad(quad as Quad, SATURATION_PAGE_QUAD);
  });

  // A frame that is grey edge to edge has no surround to tell a page from, so
  // the near-total low-saturation cover is rejected rather than returned as a
  // page filling the frame.
  it('returns null when the whole frame is low-saturation', () => {
    expect(detectByLowSaturation(cv, blankFrame(400, 400))).toBeNull();
  });
});

describe('warpToQuad', () => {
  it('flattens the skewed page to the size its longest edges imply', () => {
    const image = syntheticDocument();
    const warped = warpToQuad(cv, image, DEFAULT_QUAD);
    const expected = outputSize(DEFAULT_QUAD);

    expect(warped.width).toBe(expected.width);
    expect(warped.height).toBe(expected.height);
  });

  // The corner order decides which way up the result is. A mirrored or rotated
  // warp is a correct detection rendered useless, and it looks like a bad photo.
  it('puts the page the right way round', () => {
    // A page with a dark band along its TOP quarter only.
    const width = 400;
    const height = 400;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const value = y < height / 4 ? 20 : 230;
        const offset = (y * width + x) * 4;
        data[offset] = value;
        data[offset + 1] = value;
        data[offset + 2] = value;
        data[offset + 3] = 255;
      }
    }
    const image: RawImage = { width, height, data };
    const quad: Quad = [
      { x: 0, y: 0 },
      { x: width, y: 0 },
      { x: width, y: height },
      { x: 0, y: height },
    ];

    const warped = warpToQuad(cv, image, quad);

    // Dark at the top, light at the bottom: unchanged, not flipped.
    expect(meanIntensity(warped, 10, 5, warped.width - 10, 30)).toBeLessThan(
      80,
    );
    expect(
      meanIntensity(
        warped,
        10,
        warped.height - 30,
        warped.width - 10,
        warped.height - 5,
      ),
    ).toBeGreaterThan(180);
  });

  // Rotation deliberately is not a warp concern any more: it costs seconds
  // here and milliseconds on the finished pixels (`rotate-image.test.ts`).
  it('produces the same result however many times it is asked', () => {
    const image = syntheticDocument();
    const first = warpToQuad(cv, image, DEFAULT_QUAD);
    const second = warpToQuad(cv, image, DEFAULT_QUAD);

    expect(second.width).toBe(first.width);
    expect(Array.from(second.data)).toEqual(Array.from(first.data));
  });
});

describe('enhance', () => {
  it('evens out a shadow across the page', () => {
    // A page lit from the right: the left side is markedly darker.
    const image = syntheticDocument({
      quad: [
        { x: 20, y: 20 },
        { x: 700, y: 20 },
        { x: 700, y: 700 },
        { x: 20, y: 700 },
      ],
      text: false,
      shadow: 0.55,
    });

    const before = {
      left: meanIntensity(image, 40, 100, 200, 600),
      right: meanIntensity(image, 520, 100, 680, 600),
    };
    const after = enhance(cv, image);
    const afterGap = Math.abs(
      meanIntensity(after, 40, 100, 200, 600) -
        meanIntensity(after, 520, 100, 680, 600),
    );

    // The gradient was real to begin with, and is materially reduced.
    expect(Math.abs(before.left - before.right)).toBeGreaterThan(40);
    expect(afterGap).toBeLessThan(Math.abs(before.left - before.right) / 2);
  });

  it('keeps the image the same size', () => {
    const image = syntheticDocument({ width: 300, height: 260, text: false });
    const result = enhance(cv, image);
    expect(result.width).toBe(300);
    expect(result.height).toBe(260);
  });

  // The failure the screenshots showed: detection defaulted to the whole frame,
  // so the warp caught the desk and the hand's shadow, and the illumination
  // division amplified their sensor grain -- per channel, so grey noise came out
  // as loud colour speckle. Denoising before the division and flooring the
  // background estimate keeps a dark region quiet. With neither guard this dark
  // noisy field enhances to a mean chroma near 49; both together hold it near
  // 12, so the bound is deliberately well below the broken value and above the
  // fixed one. A noise-free fixture cannot see this regression, which is why one
  // that carries real per-channel grain has to.
  it('does not amplify dark-region sensor noise into colour speckle', () => {
    const noisyDarkField = syntheticDocument({
      width: 320,
      height: 260,
      text: false,
      paper: 25,
      background: 25,
      noise: 6,
    });

    const result = enhance(cv, noisyDarkField);

    expect(meanChroma(result)).toBeLessThan(25);
  });

  // The preview the user approves is the file that gets stored, so the same
  // input has to produce the same bytes every time (I3).
  it('is deterministic', () => {
    const image = syntheticDocument({ width: 240, height: 240 });
    const first = enhance(cv, image);
    const second = enhance(cv, image);
    expect(Array.from(second.data)).toEqual(Array.from(first.data));
  });
});

describe('applyStyle', () => {
  /** A warped page with text on it, which is what a finish is applied to. */
  const page = () => syntheticDocument({ width: 320, height: 260 });

  it('leaves the crop untouched when no enhancement was asked for', () => {
    const image = page();
    // The same object, not merely equal pixels: this branch exists to do
    // nothing, and copying fourteen megabytes to do nothing is worth avoiding.
    expect(applyStyle(cv, image, 'none')).toBe(image);
  });

  it('is the enhancement itself in colour', () => {
    const image = page();
    expect(Array.from(applyStyle(cv, image, 'colour').data)).toEqual(
      Array.from(enhance(cv, image).data),
    );
  });

  it('keeps the size whatever the finish', () => {
    const image = page();
    for (const style of SCAN_STYLES) {
      const result = applyStyle(cv, image, style);
      expect([result.width, result.height]).toEqual([image.width, image.height]);
    }
  });

  // Every finish is a pure function of its input (I3): the file that is stored
  // is the preview that was approved, and a second run has to agree with it.
  it('is deterministic for every finish', () => {
    const image = page();
    for (const style of SCAN_STYLES) {
      expect(Array.from(applyStyle(cv, image, style).data)).toEqual(
        Array.from(applyStyle(cv, image, style).data),
      );
    }
  });

  describe('greyscale', () => {
    it('leaves no channel disagreeing with another', () => {
      const result = applyStyle(cv, page(), 'grayscale');
      for (let i = 0; i < result.data.length; i += 4) {
        expect(result.data[i]).toBe(result.data[i + 1]);
        expect(result.data[i + 1]).toBe(result.data[i + 2]);
      }
    });

    // Luminance-weighted, not an average of the channels -- otherwise red ink
    // comes out the same grey as the blue stamp beside it.
    //
    // Asked of `desaturate` rather than of the finish, deliberately: the finish
    // enhances first, and illumination normalisation divides a flat colour by
    // its own background, so any solid patch reaches the desaturation as white.
    // Put through `applyStyle` this case would pass or fail on the enhancement
    // and say nothing about the weighting.
    it('separates two colours a channel average would collapse', () => {
      const [greyRed] = desaturate(cv, solidColour(60, 40, [220, 30, 30])).data;
      const [greyBlue] = desaturate(cv, solidColour(60, 40, [30, 30, 220])).data;

      // An unweighted mean gives both exactly the same value.
      expect((220 + 30 + 30) / 3).toBe((30 + 30 + 220) / 3);
      expect(Math.abs(greyRed - greyBlue)).toBeGreaterThan(20);
    });
  });

  describe('black and white', () => {
    it('leaves only ink and paper', () => {
      const result = applyStyle(cv, page(), 'blackAndWhite');
      const values = new Set<number>();
      for (let i = 0; i < result.data.length; i += 4) values.add(result.data[i]);
      expect([...values].sort((a, b) => a - b)).toEqual([0, 255]);
    });

    // It reads the crop, not the enhanced image: the enhancement ends in an
    // unsharp mask, whose halos a threshold turns into a broken outline.
    it('does not build on the colour finish', () => {
      const image = page();
      expect(Array.from(applyStyle(cv, image, 'blackAndWhite').data)).not.toEqual(
        Array.from(applyStyle(cv, enhance(cv, image), 'blackAndWhite').data),
      );
    });

    // The threshold is local, so a page lit from one side comes out evenly --
    // which is why it needs no illumination step of its own.
    it('survives a shadow across the page', () => {
      const shadowed = syntheticDocument({
        quad: [
          { x: 20, y: 20 },
          { x: 700, y: 20 },
          { x: 700, y: 700 },
          { x: 20, y: 700 },
        ],
        text: false,
        shadow: 0.55,
      });
      const result = applyStyle(cv, shadowed, 'blackAndWhite');

      const gap = Math.abs(
        meanIntensity(result, 40, 100, 200, 600) -
          meanIntensity(result, 520, 100, 680, 600),
      );
      expect(gap).toBeLessThan(40);
    });
  });
});

describe('limitSize', () => {
  it('reduces an oversized image to the upload ceiling', () => {
    const image = blankFrame(OUTPUT_MAX_EDGE + 900, 400);
    const limited = limitSize(cv, image);
    expect(Math.max(limited.width, limited.height)).toBe(OUTPUT_MAX_EDGE);
  });

  it('leaves an image that already fits untouched', () => {
    const image = blankFrame(300, 200);
    expect(limitSize(cv, image)).toBe(image);
  });
});

describe('blurVariance', () => {
  it('separates a sharp capture from a blurred one', () => {
    const sharp = syntheticDocument();
    const blurred = syntheticDocument({ blurRadius: 6 });

    expect(blurVariance(cv, blurred)).toBeLessThan(blurVariance(cv, sharp));
  });
});

describe('assessCapture', () => {
  const output = { width: 900, height: 1200 };

  it('reports nothing for a sharp, fully framed page', () => {
    const image = syntheticDocument();
    const { quad } = detectDocument(cv, image);
    expect(assessCapture(cv, image, quad, true, output)).toEqual([]);
  });

  it('flags a blurred capture', () => {
    const image = syntheticDocument({ blurRadius: 8 });
    expect(assessCapture(cv, image, DEFAULT_QUAD, true, output)).toContain(
      'blurry',
    );
  });

  it('flags a document running off the edge of the frame', () => {
    const image = syntheticDocument({ text: false });
    const offEdge: Quad = [
      { x: 0, y: 0 },
      { x: 700, y: 40 },
      { x: 690, y: 700 },
      { x: 10, y: 690 },
    ];
    expect(assessCapture(cv, image, offEdge, true, output)).toContain(
      'edgesOutsideFrame',
    );
  });

  it('flags a capture where no document was found at all', () => {
    const image = syntheticDocument();
    expect(assessCapture(cv, image, DEFAULT_QUAD, false, output)).toContain(
      'edgesOutsideFrame',
    );
  });

  it('flags an output too small to read', () => {
    const image = syntheticDocument();
    expect(
      assessCapture(cv, image, DEFAULT_QUAD, true, { width: 400, height: 300 }),
    ).toContain('lowResolution');
  });
});
