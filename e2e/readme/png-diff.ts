import { inflateSync } from 'node:zlib';

// Counting the pixels that differ between two screenshots, without a library.
//
// Playwright writes 8-bit, non-interlaced PNGs, so the decoder below handles
// only those (RGB and RGBA) and throws on anything else rather than guessing.
// It exists because two frames of a finished page are not always byte-identical:
// a rounded corner can anti-alias differently between two captures, and a
// byte-for-byte comparison then never settles.

interface Raster {
  width: number;
  height: number;
  channels: number;
  data: Buffer;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

export function decodePng(png: Buffer): Raster {
  if (png.readUInt32BE(0) !== 0x89504e47) throw new Error('Not a PNG');
  let offset = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Buffer[] = [];

  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    const body = png.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const bitDepth = body[8];
      const colorType = body[9];
      const interlace = body[12];
      if (bitDepth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6)) {
        throw new Error(`Unsupported PNG (depth ${bitDepth}, type ${colorType}, interlace ${interlace})`);
      }
      channels = colorType === 6 ? 4 : 3;
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const data = Buffer.alloc(stride * height);

  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? data[y * stride + x - channels] : 0;
      const up = y > 0 ? data[(y - 1) * stride + x] : 0;
      const upLeft = y > 0 && x >= channels ? data[(y - 1) * stride + x - channels] : 0;
      let value = line[x];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) value += paeth(left, up, upLeft);
      data[y * stride + x] = value & 0xff;
    }
  }
  return { width, height, channels, data };
}

/**
 * How many pixels differ by more than `channelTolerance` in any channel.
 * Frames of different sizes differ everywhere.
 */
export function differingPixels(a: Buffer, b: Buffer, channelTolerance = 6): number {
  const first = decodePng(a);
  const second = decodePng(b);
  if (first.width !== second.width || first.height !== second.height) {
    return first.width * first.height;
  }
  let count = 0;
  for (let p = 0; p < first.width * first.height; p++) {
    for (let c = 0; c < first.channels; c++) {
      const i = p * first.channels + c;
      if (Math.abs(first.data[i] - second.data[i]) > channelTolerance) {
        count++;
        break;
      }
    }
  }
  return count;
}
