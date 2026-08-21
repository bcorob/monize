import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// The theme-color meta must be rendered by the persistent root layout, never
// by the viewport export. Viewport metas are removed and re-inserted on every
// soft navigation, and in the installed PWA the frames in between fall back
// to the manifest's stored theme_color -- which flashed the old manifest
// green in the header bar on every swipe between sections. A layout-rendered
// meta is hoisted into <head> once and survives navigation untouched.
const layoutSource = readFileSync(
  resolve(__dirname, '../app/layout.tsx'),
  'utf8',
);

describe('theme-color meta placement', () => {
  it('keeps themeColor out of the viewport/generateViewport export', () => {
    expect(layoutSource).not.toMatch(/themeColor\s*:/);
  });

  it('renders the theme-color meta from the layout itself', () => {
    expect(layoutSource).toContain('name="theme-color"');
  });
});
