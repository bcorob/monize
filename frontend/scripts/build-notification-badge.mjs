/**
 * Rasterizes the Monize glyph into the monochrome mask Chrome needs for a
 * notification badge.
 *
 * Chrome on Android draws `badge` as a MASK: it keeps the alpha channel, throws
 * the colours away and tints what is left. So the alpha channel has to BE the
 * glyph. Every icon this project already ships is either a full-colour square
 * (`icon-192x192.png`) or a maskable icon, which is opaque edge to edge by
 * definition of the maskable purpose -- feed either to `badge` and the status
 * bar shows a filled square, which is exactly what it was asked to draw.
 *
 * Run: node scripts/build-notification-badge.mjs
 *
 * `buildBadgePng` is exported so src/test/notification-badge.test.ts can rebuild
 * the asset and compare: a committed PNG that no longer matches the logo it
 * claims to be derived from fails there rather than shipping.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE_SVG = resolve(here, '../public/icons/monize-logo-transparent.svg');
const OUTPUT_PNG = resolve(here, '../public/icons/badge-monochrome.png');

// A notification badge is drawn at 24dp; 96px is that at xxxhdpi, the largest
// density Chrome asks for, so one asset covers every screen.
const SIZE = 96;
// The status bar crops nothing, but a glyph flush against the edge reads as a
// block at this size. 6% on each side is the smallest margin that still lets
// the two peaks resolve.
const MARGIN = 0.06;
const SUBSAMPLES = 4;
const CURVE_STEPS = 24;

/**
 * Every command letter, not only the four this parser implements.
 *
 * Matching `[MmLlCcZz]` alone did not reject an `H` or a `V` -- it did not SEE
 * one. The letter fell out of the token stream and its coordinates were eaten
 * by whatever command was still active, so `M10,10 H90 V90` parsed as
 * `M10,10 L90,90` and the `default: throw` below could never fire. SVGO and
 * most design tools emit those commands, so a re-exported logo would have
 * produced a silently wrong glyph -- and the badge test, which rebuilds from
 * this same generator, would have compared wrong to wrong and passed.
 *
 * The number alternative comes first so an exponent (`1e-5`) is consumed as one
 * number rather than a number, a letter and another number.
 */
const PATH_TOKEN = /-?\d*\.?\d+(?:e[-+]?\d+)?|[A-Za-z]/gi;
const COMMAND_LETTER = /^[A-Za-z]$/;

function parsePath(d) {
  const tokens = d.match(PATH_TOKEN) ?? [];
  const subpaths = [];
  let current = [];
  let cursor = [0, 0];
  let start = [0, 0];
  let command = '';
  let i = 0;

  const number = () => Number(tokens[i++]);
  const flush = () => {
    if (current.length > 1) subpaths.push(current);
    current = [];
  };

  while (i < tokens.length) {
    const startedAt = i;
    if (COMMAND_LETTER.test(tokens[i])) command = tokens[i++];
    switch (command) {
      case 'M':
      case 'm': {
        const x = number();
        const y = number();
        flush();
        cursor = command === 'M' ? [x, y] : [cursor[0] + x, cursor[1] + y];
        start = cursor;
        current = [cursor];
        // A repeated coordinate pair after a moveto is an implicit lineto.
        command = command === 'M' ? 'L' : 'l';
        break;
      }
      case 'L':
      case 'l': {
        const x = number();
        const y = number();
        cursor = command === 'L' ? [x, y] : [cursor[0] + x, cursor[1] + y];
        current.push(cursor);
        break;
      }
      case 'C':
      case 'c': {
        const rel = command === 'c';
        const base = rel ? cursor : [0, 0];
        const p1 = [base[0] + number(), base[1] + number()];
        const p2 = [base[0] + number(), base[1] + number()];
        const p3 = [base[0] + number(), base[1] + number()];
        const p0 = cursor;
        for (let step = 1; step <= CURVE_STEPS; step += 1) {
          const t = step / CURVE_STEPS;
          const u = 1 - t;
          current.push([
            u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
            u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
          ]);
        }
        cursor = p3;
        break;
      }
      case 'Z':
      case 'z': {
        current.push(start);
        flush();
        cursor = start;
        break;
      }
      default:
        throw new Error(`Unsupported path command: ${command}`);
    }
    // `Z` consumes no operand, so a number after one leaves the loop with the
    // same command and the same index -- it used to hang rather than fail. Any
    // iteration that reads nothing is a malformed path, whichever case it was.
    if (i === startedAt) {
      throw new Error(
        `Malformed path: token ${JSON.stringify(tokens[i])} at ${i} follows command '${command}', which takes no operand`,
      );
    }
  }
  flush();
  return subpaths;
}

/** Coverage per pixel in [0,1], nonzero winding, sampled SUBSAMPLES^2 per pixel. */
function rasterize(subpaths, size, subsamples) {
  const edges = [];
  for (const points of subpaths) {
    for (let k = 0; k + 1 < points.length; k += 1) {
      const [x0, y0] = points[k];
      const [x1, y1] = points[k + 1];
      if (y0 !== y1) edges.push({ x0, y0, x1, y1 });
    }
  }

  const rows = size * subsamples;
  const coverage = new Float64Array(size * size);
  const crossings = [];

  for (let row = 0; row < rows; row += 1) {
    const y = (row + 0.5) / subsamples;
    crossings.length = 0;
    for (const e of edges) {
      const top = Math.min(e.y0, e.y1);
      const bottom = Math.max(e.y0, e.y1);
      if (y < top || y >= bottom) continue;
      const t = (y - e.y0) / (e.y1 - e.y0);
      crossings.push({ x: e.x0 + t * (e.x1 - e.x0), dir: e.y1 > e.y0 ? 1 : -1 });
    }
    if (crossings.length === 0) continue;
    crossings.sort((a, b) => a.x - b.x);

    let winding = 0;
    const pixelRow = Math.floor(row / subsamples) * size;
    for (let c = 0; c + 1 <= crossings.length - 1; c += 1) {
      winding += crossings[c].dir;
      if (winding === 0) continue;
      const spanStart = crossings[c].x;
      const spanEnd = crossings[c + 1].x;
      const first = Math.max(0, Math.ceil(spanStart * subsamples - 0.5));
      const last = Math.min(size * subsamples - 1, Math.floor(spanEnd * subsamples - 0.5));
      for (let col = first; col <= last; col += 1) {
        coverage[pixelRow + Math.floor(col / subsamples)] += 1;
      }
    }
  }

  const perPixel = subsamples * subsamples;
  for (let k = 0; k < coverage.length; k += 1) {
    coverage[k] = Math.min(1, coverage[k] / perPixel);
  }
  return coverage;
}

function encodePng(size, coverage) {
  const stride = size * 4;
  const raw = Buffer.alloc(size * (stride + 1));
  for (let y = 0; y < size; y += 1) {
    const base = y * (stride + 1);
    raw[base] = 0; // filter: none
    for (let x = 0; x < size; x += 1) {
      const alpha = Math.round(coverage[y * size + x] * 255);
      const px = base + 1 + x * 4;
      // White everywhere, including under transparent pixels: a tint multiplies
      // the colour, and a black-under-transparent edge fringes dark when it does.
      raw[px] = 255;
      raw[px + 1] = 255;
      raw[px + 2] = 255;
      raw[px + 3] = alpha;
    }
  }

  const chunk = (type, data) => {
    const out = Buffer.alloc(data.length + 12);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'ascii');
    data.copy(out, 8);
    out.writeInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) | 0;
}

export function buildBadgePng() {
  const svg = readFileSync(SOURCE_SVG, 'utf8');
  const pathData = svg.match(/\sd="([^"]+)"/)?.[1];
  if (!pathData) throw new Error(`No path found in ${SOURCE_SVG}`);

  const subpaths = parsePath(pathData);

  // Fit the glyph's own bounding box, not the viewBox: the source art is padded
  // for a square app icon and a badge has no room to spare.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const points of subpaths) {
    for (const [x, y] of points) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }

  const inner = SIZE * (1 - 2 * MARGIN);
  const scale = inner / Math.max(maxX - minX, maxY - minY);
  const offsetX = (SIZE - (maxX - minX) * scale) / 2 - minX * scale;
  const offsetY = (SIZE - (maxY - minY) * scale) / 2 - minY * scale;
  const placed = subpaths.map((points) =>
    points.map(([x, y]) => [x * scale + offsetX, y * scale + offsetY]),
  );

  return encodePng(SIZE, rasterize(placed, SIZE, SUBSAMPLES));
}

export { parsePath };
export const BADGE_OUTPUT_PATH = OUTPUT_PNG;
export const BADGE_SIZE = SIZE;

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  writeFileSync(OUTPUT_PNG, buildBadgePng());
  process.stdout.write(`Wrote ${OUTPUT_PNG} (${SIZE}x${SIZE})\n`);
}
