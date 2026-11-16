import { deflateSync } from "node:zlib";

export interface ChartPrice {
  date: string;
  close: number;
}
export const CHART_WIDTH = 640;
export const CHART_HEIGHT = 280;
export const CHART_MAX_POINTS = 60;

// A small numeric font keeps rendering independent of browser/native binaries.
// The notification supplies the localized subject; axes carry ISO dates and prices.
const FONT: Record<string, string[]> = {
  "0": ["111", "101", "101", "101", "111"],
  "1": ["010", "110", "010", "010", "111"],
  "2": ["111", "001", "111", "100", "111"],
  "3": ["111", "001", "111", "001", "111"],
  "4": ["101", "101", "111", "001", "001"],
  "5": ["111", "100", "111", "001", "111"],
  "6": ["111", "100", "111", "101", "111"],
  "7": ["111", "001", "010", "010", "010"],
  "8": ["111", "101", "111", "101", "111"],
  "9": ["111", "101", "111", "001", "111"],
  "-": ["000", "000", "111", "000", "000"],
  ".": ["000", "000", "000", "000", "010"],
  ",": ["000", "000", "000", "010", "100"],
  "+": ["000", "010", "111", "010", "000"],
  e: ["000", "111", "111", "100", "111"],
  " ": ["000", "000", "000", "000", "000"],
};
function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

/** Bounded, deterministic PNG; rejects incomplete or misleading input. */
export function renderPriceChart(prices: readonly ChartPrice[]): Buffer | null {
  if (prices.length < 2 || prices.length > CHART_MAX_POINTS) return null;
  if (
    prices.some(
      (p, i) =>
        !/^\d{4}-\d{2}-\d{2}$/.test(p.date) ||
        !Number.isFinite(p.close) ||
        p.close <= 0 ||
        p.close > 1e14 ||
        !Number.isFinite(Date.parse(p.date + "T00:00:00Z")) ||
        new Date(p.date + "T00:00:00Z").toISOString().slice(0, 10) !== p.date ||
        (i > 0 && p.date <= prices[i - 1].date),
    )
  )
    return null;
  const w = CHART_WIDTH,
    h = CHART_HEIGHT;
  const rgb = Buffer.alloc(w * h * 3, 255);
  const pixel = (x: number, y: number, color: readonly number[]) => {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const at = (y * w + x) * 3;
    for (let k = 0; k < 3; k++) rgb[at + k] = color[k];
  };
  const line = (
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    color: readonly number[],
  ) => {
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
    for (let i = 0; i <= steps; i++)
      pixel(x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps, color);
  };
  const ink = [30, 41, 59],
    blue = [37, 99, 235],
    grid = [220, 225, 232];
  const text = (value: string, x: number, y: number) => {
    for (const char of value) {
      const glyph = FONT[char] ?? FONT[" "];
      glyph.forEach((row, dy) =>
        [...row].forEach((v, dx) => {
          if (v === "1")
            for (let a = 0; a < 2; a++)
              for (let b = 0; b < 2; b++)
                pixel(x + dx * 2 + a, y + dy * 2 + b, ink);
        }),
      );
      x += 8;
    }
  };
  const low = Math.min(...prices.map((p) => p.close)),
    high = Math.max(...prices.map((p) => p.close));
  // Normalize before subtraction: finite prices can still have an overflowing range.
  const scale = high;
  const min = low / scale,
    max = high / scale;
  const span = max - min || 0.1;
  const bottom = min - span * 0.1,
    top = max + span * 0.1;
  const left = 110,
    right = 616,
    yTop = 24,
    yBottom = 238;
  const valueLabel = (n: number) =>
    n >= 1e8 || n < 0.001
      ? n.toExponential(2)
      : Number(n.toPrecision(6)).toString();
  for (let i = 0; i < 3; i++) {
    const ratio = i / 2,
      y = yBottom - (yBottom - yTop) * ratio;
    line(left, y, right, y, grid);
    text(valueLabel((bottom + (top - bottom) * ratio) * scale), 8, y - 5);
  }
  const first = Date.parse(prices[0].date),
    last = Date.parse(prices[prices.length - 1].date);
  const points = prices.map((p) => ({
    x: left + ((Date.parse(p.date) - first) / (last - first)) * (right - left),
    y:
      yBottom -
      ((p.close / scale - bottom) / (top - bottom)) * (yBottom - yTop),
  }));
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1],
      b = points[i];
    for (let dy = -1; dy <= 1; dy++) line(a.x, a.y + dy, b.x, b.y + dy, blue);
  }
  text(prices[0].date, left, 258);
  text(prices[prices.length - 1].date, right - 80, 258);
  const scan = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++)
    rgb.copy(scan, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(w);
  header.writeUInt32BE(h, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(scan)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
