// Squeezes the PNGs `02`..`04` wrote, without changing a pixel.
//
//   npm run readme:optimize
//
// Uses ImageMagick (`magick`, or `convert` on older installs): strips metadata
// and recompresses at the highest zlib level. A file is replaced only when the
// result is smaller. Without ImageMagick the pictures are simply left as the
// browser wrote them.

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const IMAGES = resolve(here, '../../docs/images/readme');

function imageMagick() {
  for (const bin of ['magick', 'convert']) {
    try {
      execFileSync(bin, ['-version'], { stdio: 'ignore' });
      return bin;
    } catch {
      // try the next name
    }
  }
  return null;
}

const bin = imageMagick();
if (!bin) {
  process.stderr.write('ImageMagick is not installed: the PNGs are left as they are.\n');
  process.exit(0);
}

const work = mkdtempSync(join(tmpdir(), 'readme-png-'));
let before = 0;
let after = 0;
try {
  for (const file of readdirSync(IMAGES).filter((f) => f.endsWith('.png')).sort()) {
    const source = join(IMAGES, file);
    const out = join(work, file);
    const size = statSync(source).size;
    execFileSync(bin, [source, '-strip', '-define', 'png:compression-level=9', '-define', 'png:compression-strategy=1', out]);
    const smaller = statSync(out).size;
    before += size;
    if (smaller < size) {
      copyFileSync(out, source);
      after += smaller;
    } else {
      after += size;
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
process.stdout.write(`PNGs: ${(before / 1024).toFixed(0)} KB -> ${(after / 1024).toFixed(0)} KB\n`);
