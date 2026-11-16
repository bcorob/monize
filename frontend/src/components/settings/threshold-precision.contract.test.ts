import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A threshold control renders as many decimals as its column can hold.
 *
 * `NumericInput` formats with `toFixed(decimalPlaces)` and, on blur, re-emits
 * whatever it is showing whenever rounding moved the value -- so a control
 * narrower than its column DISPLAYS a stored 0.1250 as 0.13 and then commits
 * that on the next blur, changing a threshold on a save the user made about
 * another field. Wider is the same defect from the other side: the form would
 * offer a precision the column silently rounds away.
 *
 * Both surfaces got this wrong in the same way and were found one at a time,
 * which is what makes it a scan rather than two tests: the price-alert control
 * shipped at 2 over a column with no declared scale at all, and its sibling had
 * been at 2 over NUMERIC(9,4) since it was written. The schema is the authority
 * because it is the thing that actually truncates.
 *
 * Modelled on `demo-credentials.contract.test.ts`: a per-file read is correct
 * on its own and wrong against its sibling, so the check has to span them.
 */
const repoRoot = join(__dirname, '..', '..', '..', '..');
const schemaSql = readFileSync(
  join(repoRoot, 'database', 'schema.sql'),
  'utf8',
);

/** The threshold controls, each with the column it edits. */
const THRESHOLD_CONTROLS = [
  {
    component: 'PortfolioAlertControl.tsx',
    path: join(__dirname, 'PortfolioAlertControl.tsx'),
    column: 'move_alert_percent',
  },
  {
    component: 'SecurityForm.tsx',
    path: join(__dirname, '..', 'securities', 'SecurityForm.tsx'),
    column: 'price_alert_percent',
  },
] as const;

/**
 * The scale declared for a column in `schema.sql`. Anchored on the column name
 * at the start of a line so a CHECK constraint mentioning the same column does
 * not answer for the declaration.
 */
function declaredScale(column: string): number | null {
  const match = new RegExp(
    `^\\s*${column}\\s+NUMERIC\\s*\\(\\s*\\d+\\s*,\\s*(\\d+)\\s*\\)`,
    'im',
  ).exec(schemaSql);
  return match ? Number(match[1]) : null;
}

function decimalPlacesIn(source: string): number[] {
  return [...source.matchAll(/decimalPlaces=\{(\d+)\}/g)].map((m) =>
    Number(m[1]),
  );
}

describe('a threshold control matches its column scale', () => {
  it.each(THRESHOLD_CONTROLS)(
    '$component renders $column at its declared scale',
    ({ path, column }) => {
      const scale = declaredScale(column);
      // A column that stopped being NUMERIC would make every assertion below
      // vacuous, so prove the schema still declares one.
      expect(scale).not.toBeNull();

      const places = decimalPlacesIn(readFileSync(path, 'utf8'));
      // One control per file today; if a second appears, this fails rather
      // than checking whichever happened to be first.
      expect(places).toEqual([scale]);
    },
  );

  it('reads a scale the schema really carries', () => {
    // The regex is the whole check, so pin it in both directions: a column
    // that exists, and one that does not.
    expect(declaredScale('move_alert_percent')).toBe(4);
    expect(declaredScale('no_such_threshold_column')).toBeNull();
  });
});
