import { describe, it, expect } from 'vitest';
import {
  budgetPercentColor,
  budgetProgressBarColor,
  budgetCategoryBarColor,
} from './budget-colors';

describe('budget-colors', () => {
  describe('budgetPercentColor', () => {
    it('returns red for >100', () => {
      expect(budgetPercentColor(101)).toContain('red');
    });
    it('returns amber for >80', () => {
      expect(budgetPercentColor(81)).toContain('amber');
    });
    it('returns emerald for low values', () => {
      expect(budgetPercentColor(50)).toContain('emerald');
    });
  });

  describe('budgetProgressBarColor', () => {
    it('handles all branches', () => {
      expect(budgetProgressBarColor(120)).toBe('bg-red-500');
      expect(budgetProgressBarColor(85)).toBe('bg-amber-500');
      expect(budgetProgressBarColor(50)).toBe('bg-emerald-500');
    });
  });

  describe('budgetCategoryBarColor', () => {
    it('handles all branches', () => {
      expect(budgetCategoryBarColor(120)).toBe('bg-red-400');
      expect(budgetCategoryBarColor(85)).toBe('bg-amber-400');
      expect(budgetCategoryBarColor(50)).toBe('bg-emerald-400');
    });
  });
});
