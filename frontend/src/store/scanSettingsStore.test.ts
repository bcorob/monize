import { describe, it, expect, beforeEach } from 'vitest';

import {
  useScanSettingsStore,
  SCAN_SETTINGS_STORAGE_KEY,
} from './scanSettingsStore';
import {
  ADJUSTMENT_RANGE,
  NEUTRAL_ADJUSTMENTS,
} from '@/lib/document-scanner/adjust-image';
import { DEFAULT_SCAN_STYLE } from '@/lib/document-scanner/document-scan.types';

describe('scanSettingsStore', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useScanSettingsStore.setState({
      style: DEFAULT_SCAN_STYLE,
      adjustments: NEUTRAL_ADJUSTMENTS,
    });
  });

  it('starts at the default finish with neutral sliders', () => {
    const { style, adjustments } = useScanSettingsStore.getState();
    expect(style).toBe(DEFAULT_SCAN_STYLE);
    expect(adjustments).toEqual({ brightness: 0, contrast: 0 });
  });

  it('remembers the finish and writes it to localStorage', () => {
    useScanSettingsStore.getState().setStyle('blackAndWhite');

    expect(useScanSettingsStore.getState().style).toBe('blackAndWhite');
    const stored = window.localStorage.getItem(SCAN_SETTINGS_STORAGE_KEY);
    expect(JSON.parse(stored!).state.style).toBe('blackAndWhite');
  });

  it('remembers the slider offsets and writes them to localStorage', () => {
    useScanSettingsStore.getState().setAdjustments({ brightness: 30, contrast: -20 });

    expect(useScanSettingsStore.getState().adjustments).toEqual({
      brightness: 30,
      contrast: -20,
    });
    const stored = window.localStorage.getItem(SCAN_SETTINGS_STORAGE_KEY);
    expect(JSON.parse(stored!).state.adjustments).toEqual({
      brightness: 30,
      contrast: -20,
    });
  });

  describe('merge rejects what a hand-edited entry could carry', () => {
    const merge = useScanSettingsStore.persist.getOptions().merge!;
    const current = useScanSettingsStore.getState();

    it('falls back to the default finish for a style that does not exist', () => {
      const merged = merge({ style: 'sepia' }, current) as typeof current;
      expect(merged.style).toBe(DEFAULT_SCAN_STYLE);
    });

    it('keeps a valid finish', () => {
      const merged = merge({ style: 'grayscale' }, current) as typeof current;
      expect(merged.style).toBe('grayscale');
    });

    it('clamps a slider past the end of its travel', () => {
      const merged = merge(
        { adjustments: { brightness: 9999, contrast: -9999 } },
        current,
      ) as typeof current;
      expect(merged.adjustments).toEqual({
        brightness: ADJUSTMENT_RANGE,
        contrast: -ADJUSTMENT_RANGE,
      });
    });

    it('treats a non-numeric offset as neutral', () => {
      const merged = merge(
        { adjustments: { brightness: 'lots', contrast: null } },
        current,
      ) as typeof current;
      expect(merged.adjustments).toEqual({ brightness: 0, contrast: 0 });
    });

    it('falls back to neutral when the offsets are missing entirely', () => {
      const merged = merge({ style: 'none' }, current) as typeof current;
      expect(merged.adjustments).toEqual({ brightness: 0, contrast: 0 });
    });
  });
});
