import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Recharts marks every chart <svg> (`.recharts-surface`) focusable
 * (`tabIndex=0`, `role="application"`) for its keyboard accessibility layer. On
 * a touch tap or a mouse click that focuses the surface, and the browser paints
 * its focus outline around the whole chart -- an oversized rectangle framing the
 * point the reader just selected, on top of the intended tooltip, active dot and
 * cursor.
 *
 * The fix is a CSS rule, not a per-chart prop: the outline belongs to keyboard
 * focus only. This guard pins that rule in `globals.css` so a later edit cannot
 * quietly drop the pointer-focus suppression (the rectangle comes back) or the
 * `:focus-visible` ring (keyboard users lose their focus indicator). Both halves
 * are required -- removing either regresses the behaviour issue #UI-03 fixed.
 */
describe('recharts focus outline (globals.css)', () => {
  const css = readFileSync(
    join(__dirname, '..', 'app', 'globals.css'),
    'utf8',
  );

  // Strip comments so the prose describing the rule cannot satisfy the scan.
  const code = css.replace(/\/\*[\s\S]*?\*\//g, '');

  it('drops the focus outline on the chart surface for pointer focus', () => {
    expect(code).toMatch(
      /\.recharts-surface:focus:not\(:focus-visible\)\s*\{[^}]*outline:\s*none/,
    );
  });

  it('keeps a visible outline for keyboard focus (:focus-visible)', () => {
    expect(code).toMatch(
      /\.recharts-surface:focus-visible\s*\{[^}]*outline:/,
    );
  });
});
