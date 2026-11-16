// Turns the screen recordings made by `05-recordings.spec.ts` into GIFs.
//
//   npm run readme:gifs
//
// Needs ffmpeg on the PATH and nothing else. Each GIF is made in two passes (one
// to build a palette from the whole clip, one to dither with it), starts after
// the seconds `finishRecording` noted as not yet part of the flow, loops
// forever, and is brought under the size limit by dropping to smaller settings
// when the first ones come out too large.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const RECORDINGS = resolve(here, '../readme-recordings');
const OUTPUT = resolve(here, '../../docs/images/readme');
const MAX_BYTES = 3_000_000;

// One entry per recording, in the order they are made. The name is both the
// recording's file name and the GIF's, so nothing is matched by date or glob.
// Each job lists its settings from best to smallest.
const WIDE = [
  { width: 960, fps: 12, colors: 96 },
  { width: 960, fps: 10, colors: 96 },
  { width: 880, fps: 10, colors: 80 },
  { width: 840, fps: 10, colors: 64 },
  { width: 800, fps: 10, colors: 64 },
  { width: 720, fps: 10, colors: 64 },
  { width: 720, fps: 8, colors: 64 },
];
const PHONE = [
  { width: 360, fps: 12, colors: 96 },
  { width: 360, fps: 10, colors: 80 },
  { width: 320, fps: 10, colors: 64 },
  { width: 300, fps: 8, colors: 64 },
];
const JOBS = [
  { name: 'tour', variants: WIDE },
  { name: 'rules', variants: WIDE },
  { name: 'mobile', variants: PHONE },
];

function ffmpeg(args) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: ['ignore', 'inherit', 'inherit'] });
}

function trimSeconds(name) {
  const file = join(RECORDINGS, `${name}.json`);
  if (!existsSync(file)) return 0;
  const { trimSeconds: seconds } = JSON.parse(readFileSync(file, 'utf8'));
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
}

function encode(input, output, palette, trim, { width, fps, colors }) {
  const scale = `fps=${fps},scale=${width}:-1:flags=lanczos`;
  ffmpeg(['-ss', String(trim), '-i', input, '-vf', `${scale},palettegen=stats_mode=diff:max_colors=${colors}`, palette]);
  ffmpeg([
    '-ss', String(trim),
    '-i', input,
    '-i', palette,
    '-lavfi', `${scale}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`,
    '-loop', '0',
    output,
  ]);
}

function main() {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  } catch {
    process.stderr.write('ffmpeg is not on the PATH. Install it to make the GIFs.\n');
    process.exit(1);
  }

  const work = mkdtempSync(join(tmpdir(), 'readme-gifs-'));
  let failed = false;
  try {
    for (const job of JOBS) {
      const input = join(RECORDINGS, `${job.name}.webm`);
      if (!existsSync(input)) {
        process.stderr.write(`${job.name}: no recording at ${input}. Run npm run readme:screenshots first.\n`);
        failed = true;
        continue;
      }
      const output = join(OUTPUT, `${job.name}.gif`);
      const palette = join(work, `${job.name}.png`);
      const trim = trimSeconds(job.name);

      let made = null;
      for (const variant of job.variants) {
        encode(input, output, palette, trim, variant);
        const bytes = statSync(output).size;
        made = { ...variant, bytes };
        if (bytes <= MAX_BYTES) break;
      }
      const mb = (made.bytes / 1024 / 1024).toFixed(2);
      if (made.bytes > MAX_BYTES) {
        process.stderr.write(`${job.name}.gif is ${mb} MB at ${made.width}px, ${made.fps} fps: over the 3 MB limit.\n`);
        failed = true;
      } else {
        process.stdout.write(`${job.name}.gif  ${made.width}px  ${made.fps} fps  ${mb} MB\n`);
      }
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  if (failed) process.exit(1);
}

main();
