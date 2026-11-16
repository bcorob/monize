import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { inflateSync } from 'node:zlib';
import { buildBadgePng, BADGE_SIZE, parsePath } from '../../scripts/build-notification-badge.mjs';
import { buildManifest } from '../lib/pwa-manifest';

// A notification's `badge` is a MASK. Chrome on Android keeps its alpha channel,
// discards the colours and tints the remaining shape into the status bar and the
// toolbar. So an image whose alpha says "every pixel is here" is a request to
// draw a filled square -- which is exactly what shipped, because `badge` pointed
// at the maskable app icon, and a maskable icon is opaque edge to edge by
// definition of that purpose.
//
// The notification body's `icon` is the opposite: a picture, drawn in colour.
// That one was always right, which is why the logo looked correct in the drawer
// and the toolbar did not. Two roles, two assets -- these tests hold the badge
// to the mask contract and refuse to let it borrow an app icon again.

const publicDir = resolve(__dirname, '../../public');
const swSource = readFileSync(resolve(publicDir, 'sw.js'), 'utf8');

/** The asset the worker passes as `badge`, resolved through its constant. */
function badgeAssetPath(): string {
  const constant = swSource.match(/badge:\s*([A-Z_][A-Z0-9_]*)/)?.[1];
  expect(constant, 'showNotification must pass badge as a named constant').toBeTruthy();
  const value = swSource.match(
    new RegExp(`var ${constant} = '([^']+)';`),
  )?.[1];
  expect(value, `${constant} must be declared as a string literal`).toBeTruthy();
  return value as string;
}

interface DecodedPng {
  width: number;
  height: number;
  /** RGBA, one byte per channel, filters already undone. */
  pixels: Buffer;
}

function decodePng(png: Buffer): DecodedPng {
  let offset = 8;
  const idat: Buffer[] = [];
  let width = 0;
  let height = 0;
  let colourType = -1;

  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    if (type === 'IHDR') {
      width = png.readUInt32BE(offset + 8);
      height = png.readUInt32BE(offset + 12);
      colourType = png[offset + 17];
    }
    if (type === 'IDAT') idat.push(png.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  expect(colourType, 'badge must carry an alpha channel (RGBA)').toBe(6);

  const raw = inflateSync(Buffer.concat(idat));
  const bpp = 4;
  const stride = width * bpp;
  const pixels = Buffer.alloc(height * stride);
  let read = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[read];
    read += 1;
    const line = raw.subarray(read, read + stride);
    read += stride;
    for (let x = 0; x < stride; x += 1) {
      const a = x >= bpp ? pixels[y * stride + x - bpp] : 0;
      const b = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y > 0 ? pixels[(y - 1) * stride + x - bpp] : 0;
      let value = line[x];
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) {
        const pa = Math.abs(b - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + b - 2 * c);
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      pixels[y * stride + x] = value & 0xff;
    }
  }
  return { width, height, pixels };
}

function alphaChannel({ pixels }: DecodedPng): number[] {
  const alpha: number[] = [];
  for (let i = 3; i < pixels.length; i += 4) alpha.push(pixels[i]);
  return alpha;
}

const badgePath = badgeAssetPath();
const badgePng = decodePng(readFileSync(resolve(publicDir, badgePath.replace(/^\//, ''))));

describe('push notification badge', () => {
  it('is not one of the app icons -- those are opaque, so they mask to a square', () => {
    const appIcons = (buildManifest(null).icons ?? []).map((icon) => icon.src);
    expect(appIcons).not.toContain(badgePath);
    expect(swSource).not.toMatch(/badge:\s*['"]/);
  });

  it('carries a real alpha mask rather than a fully opaque rectangle', () => {
    const alpha = alphaChannel(badgePng);
    const opaque = alpha.filter((value) => value === 255).length;
    const transparent = alpha.filter((value) => value === 0).length;

    // The defect, stated as an assertion: a badge every pixel of which is
    // present is a badge shaped like its own bounding box.
    expect(opaque).toBeLessThan(alpha.length);
    // And a mask that is mostly present is a square with the corners nibbled.
    // The Monize mark leaves well over a third of the frame empty.
    expect(transparent / alpha.length).toBeGreaterThan(0.3);
    expect(opaque).toBeGreaterThan(0);
  });

  it('is white under every pixel, so a tint cannot fringe the edges', () => {
    const { pixels } = badgePng;
    for (let i = 0; i < pixels.length; i += 4) {
      expect([pixels[i], pixels[i + 1], pixels[i + 2]]).toEqual([255, 255, 255]);
    }
  });

  it('is 96x96 -- a 24dp badge at the densest screen Chrome asks for', () => {
    expect([badgePng.width, badgePng.height]).toEqual([BADGE_SIZE, BADGE_SIZE]);
    expect(BADGE_SIZE).toBe(96);
  });

  describe('the path parser refuses what it cannot draw', () => {
    // It used to match only `[MmLlCcZz]`, which did not reject an `H` or a `V`
    // -- it did not see one. The letter fell out of the token stream and its
    // coordinates were consumed by whatever command was still active, so a
    // re-exported logo would have rasterized to a silently wrong glyph. These
    // tests exist because the comparison above cannot catch that: it rebuilds
    // from this same generator, so it would compare wrong to wrong and pass.

    it('parses the commands the brand mark actually uses', () => {
      expect(() => parsePath('M0,0 C1,1 2,2 3,3 L4,4 z')).not.toThrow();
      expect(() => parsePath('m0,0 c1,1 2,2 3,3 l4,4 z')).not.toThrow();
    });

    it('throws on a command it does not implement, rather than dropping it', () => {
      // H and V are what SVGO and most design tools emit.
      for (const [command, path] of [
        ['H', 'M10,10 H90 V90 L10,90 Z'],
        ['V', 'M10,10 V90 L10,90 Z'],
        ['A', 'M0,0 A5,5 0 0 1 10,10'],
        ['Q', 'M0,0 Q5,5 10,10'],
        ['S', 'M0,0 C1,1 2,2 3,3 S4,4 5,5'],
        ['T', 'M0,0 T3,3'],
      ] as const) {
        expect(() => parsePath(path), path).toThrow(
          `Unsupported path command: ${command}`,
        );
      }
    });

    it('throws instead of hanging on an operand a command cannot take', () => {
      // `Z` consumes nothing, so a number after one left the loop on the same
      // index with the same command -- an infinite loop, not an error.
      expect(() => parsePath('M0,0 L10,0 z 5 5')).toThrow(/takes no operand/);
    });

    it('reads an exponent as one number, not a number and a letter', () => {
      // The token pattern has to prefer the number branch, or the `e` in
      // `1e-5` becomes an unsupported command.
      expect(() => parsePath('M1e-5,0 L1,1 z')).not.toThrow();
    });
  });

  it('still matches the logo it is generated from', () => {
    // Editing the brand mark without re-running the build script leaves a badge
    // that no longer shows the logo. Compare the mask, not the bytes: zlib's
    // output is a function of the encoder, the shape is not.
    expect(alphaChannel(decodePng(buildBadgePng()))).toEqual(alphaChannel(badgePng));
  });
});
