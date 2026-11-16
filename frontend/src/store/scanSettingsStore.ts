import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

import {
  ADJUSTMENT_RANGE,
  NEUTRAL_ADJUSTMENTS,
  type ImageAdjustments,
} from '@/lib/document-scanner/adjust-image';
import {
  DEFAULT_SCAN_STYLE,
  SCAN_STYLES,
  type ScanStyle,
} from '@/lib/document-scanner/document-scan.types';

/**
 * The scan finish and the brightness/contrast a person last chose, kept so the
 * next document opens the way they left the last one.
 *
 * Browser-local rather than a row in `user_preferences`: which finish reads
 * best and how far the two sliders sit is a property of the camera and the
 * documents in front of this device, so a phone that photographs receipts and a
 * laptop that uploads scans should not have to agree. It also survives logout
 * deliberately, being a capture habit rather than account data.
 *
 * Only these three values persist. The corners, the rotation and which page is
 * on screen belong to one photo and are never carried to the next.
 */
export const SCAN_SETTINGS_STORAGE_KEY = 'monize-scan-settings';

interface ScanSettingsState {
  style: ScanStyle;
  adjustments: ImageAdjustments;
  setStyle: (style: ScanStyle) => void;
  setAdjustments: (adjustments: ImageAdjustments) => void;
}

function isScanStyle(value: unknown): value is ScanStyle {
  return (
    typeof value === 'string' && (SCAN_STYLES as readonly string[]).includes(value)
  );
}

/** One slider offset, clamped to the range the control offers. */
function clampAdjustment(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(-ADJUSTMENT_RANGE, Math.min(ADJUSTMENT_RANGE, Math.round(value)));
}

export const useScanSettingsStore = create<ScanSettingsState>()(
  persist(
    (set) => ({
      style: DEFAULT_SCAN_STYLE,
      adjustments: NEUTRAL_ADJUSTMENTS,
      setStyle: (style) => set({ style }),
      setAdjustments: (adjustments) => set({ adjustments }),
    }),
    {
      name: SCAN_SETTINGS_STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      // The actions are rebuilt on load; only the chosen values are stored.
      partialize: (state) => ({
        style: state.style,
        adjustments: state.adjustments,
      }),
      // A hand-edited or truncated entry is not a reason to open the scanner in
      // a finish that does not exist or with a slider off its scale: validate
      // each value and fall back to the neutral default rather than trust it.
      merge: (persisted, current) => {
        const stored = persisted as
          | { style?: unknown; adjustments?: unknown }
          | undefined;
        const style = isScanStyle(stored?.style) ? stored.style : current.style;
        const raw = stored?.adjustments as
          | { brightness?: unknown; contrast?: unknown }
          | undefined;
        const adjustments: ImageAdjustments =
          raw && typeof raw === 'object'
            ? {
                brightness: clampAdjustment(raw.brightness),
                contrast: clampAdjustment(raw.contrast),
              }
            : current.adjustments;
        return { ...current, style, adjustments };
      },
    },
  ),
);
