import { describe, it, expect } from 'vitest';
import { BOND_SCENARIO_PRESETS, percentToFraction } from './SecurityBondScenarioPanel';

describe('percentToFraction', () => {
  it.each([
    [3.25, '0.0325'],
    [0, '0.0000'],
    [8, '0.0800'],
    [-2.5, '-0.0250'],
    [100, '1.0000'],
    [-50, '-0.5000'],
    [-0.004, '0.0000'],
  ])('%p percent is the fraction %s', (percent, fraction) => {
    expect(percentToFraction(percent)).toBe(fraction);
  });

  it('keeps the presets inside the 6-value limit the server enforces', () => {
    expect(BOND_SCENARIO_PRESETS.length + 1).toBeLessThanOrEqual(6);
  });
});
