/**
 * Fitting a Cash Flow Sankey node's label into the gutter it is drawn in.
 *
 * A label beside the outermost columns sits in the chart's side margin, and
 * SVG text does not wrap or clip to anything but the chart's own edge, so a
 * long category name ran off the card. Each label is cut to the gutter's width
 * with an ellipsis instead; the node's tooltip still names it in full.
 */

const ELLIPSIS = '…';

/**
 * A generous average glyph width as a share of the font size, for where no
 * canvas can measure text (the server, the test DOM). Erring wide cuts a label
 * a character early rather than letting it run past the edge.
 */
const FALLBACK_GLYPH_WIDTH = 0.62;

export type TextMeasure = (text: string, fontSize: number) => number;

/** Width of `text` at `fontSize`, estimated from its length. */
export const estimateTextWidth: TextMeasure = (text, fontSize) =>
  Array.from(text).length * fontSize * FALLBACK_GLYPH_WIDTH;

let canvasContext: OffscreenCanvasRenderingContext2D | null | undefined;

/**
 * Width of `text` at `fontSize` in the page's own font, measured on an
 * offscreen canvas where the browser has one, estimated otherwise.
 */
export const measureTextWidth: TextMeasure = (text, fontSize) => {
  if (canvasContext === undefined) {
    canvasContext =
      typeof OffscreenCanvas === 'undefined' ? null : new OffscreenCanvas(1, 1).getContext('2d');
  }
  if (!canvasContext || typeof document === 'undefined') return estimateTextWidth(text, fontSize);
  const family = getComputedStyle(document.body).fontFamily || 'sans-serif';
  canvasContext.font = `${fontSize}px ${family}`;
  return canvasContext.measureText(text).width;
};

/**
 * `text` as it fits in `maxWidth` pixels at `fontSize`: whole when it fits,
 * otherwise the longest prefix that fits with an ellipsis after it, and an
 * empty string where not even the ellipsis does.
 */
export function fitSankeyLabel(
  text: string,
  maxWidth: number,
  fontSize: number,
  measure: TextMeasure = measureTextWidth,
): string {
  if (measure(text, fontSize) <= maxWidth) return text;
  if (measure(ELLIPSIS, fontSize) > maxWidth) return '';
  const chars = Array.from(text);
  // The longest prefix that fits, by bisection over its length.
  let low = 0;
  let high = chars.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const candidate = `${chars.slice(0, mid).join('').trimEnd()}${ELLIPSIS}`;
    if (measure(candidate, fontSize) <= maxWidth) low = mid;
    else high = mid - 1;
  }
  return `${chars.slice(0, low).join('').trimEnd()}${ELLIPSIS}`;
}
