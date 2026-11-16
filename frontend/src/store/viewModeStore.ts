import { useCallback } from 'react';
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

/**
 * Which view a screen is showing, and which of the calendar's layers are on.
 *
 * Browser-local rather than a `user_preferences` column, for the reason the
 * density store is: how a screen is laid out is a fact about the screen in
 * front of the reader, so a laptop and a desktop signed into the same account
 * need not agree about whether the register is a table or a month grid. It is
 * not a URL parameter either -- a shared link should open the page, not impose
 * the sender's reading habit on the recipient.
 */
export const VIEW_MODE_STORAGE_KEY = 'monize-view-mode';

/**
 * A screen that offers the Table / Calendar switch. Bills & Deposits calls its
 * table "the list", but it is the same choice and the same toggle.
 */
export type ViewModeSurface = 'transactions' | 'investments' | 'bills';

export type ViewMode = 'table' | 'calendar';

/**
 * A calendar layer: one independently switchable body of figures drawn over
 * the month grid.
 */
export type CalendarLayer = 'transactions' | 'balances' | 'values' | 'dailyChange';

/**
 * The layers each surface offers, in the order its toolbar lists them.
 *
 * `as const satisfies` rather than an annotation: the annotation this used to
 * carry widened both entries to the flat `CalendarLayer[]`, so the per-surface
 * union below could not be derived and every wrong layer type-checked again.
 */
export const SURFACE_LAYERS = {
  transactions: ['transactions', 'balances'],
  investments: ['transactions', 'values', 'dailyChange'],
  // The bills calendar draws one body of figures, its scheduled occurrences,
  // and offers no layer switch: the entry exists so the surface's state has
  // the same shape as the others' and a stored foreign layer is discarded.
  bills: ['transactions'],
} as const satisfies Readonly<Record<ViewModeSurface, readonly CalendarLayer[]>>;

/**
 * The layers one surface offers, as a union the compiler refuses to widen.
 *
 * This is the mechanism, not the intention: `toggleLayer` and `isLayerOn` take
 * `LayerOf<S>`, so asking the investments calendar for a `balances` layer is a
 * type error at the call site. `CalendarLayer` stays the storage-level union,
 * because a hand-edited localStorage entry can name any of them and
 * `readSurface` has to recognise the ones that do not belong.
 */
export type LayerOf<S extends ViewModeSurface> = (typeof SURFACE_LAYERS)[S][number];

export const VIEW_MODE_SURFACES: readonly ViewModeSurface[] = ['transactions', 'investments', 'bills'];

const VIEW_MODES: readonly ViewMode[] = ['table', 'calendar'];

export interface SurfaceViewState {
  view: ViewMode;
  layers: CalendarLayer[];
}

/**
 * Table, with the Transactions layer ready for the first switch to Calendar.
 *
 * Defaulting to `table` is what makes every calendar task inert on deploy: a
 * user who never touches the toggle sees exactly the register they saw before.
 */
function defaultSurfaceState(): SurfaceViewState {
  return { view: 'table', layers: ['transactions'] };
}

function defaultSurfaces(): Record<ViewModeSurface, SurfaceViewState> {
  return {
    transactions: defaultSurfaceState(),
    investments: defaultSurfaceState(),
    bills: defaultSurfaceState(),
  };
}

function isViewMode(value: unknown): value is ViewMode {
  return typeof value === 'string' && (VIEW_MODES as readonly string[]).includes(value);
}

/**
 * A stored surface, or the default when the stored one cannot be trusted.
 *
 * A hand-edited entry, a layer belonging to the other surface, or a surface
 * left with no layer at all is discarded rather than rendered: the toolbar's
 * one rule is that a calendar always draws something.
 */
function readSurface(surface: ViewModeSurface, stored: unknown): SurfaceViewState {
  const candidate = stored as { view?: unknown; layers?: unknown } | undefined;
  if (!candidate || typeof candidate !== 'object') return defaultSurfaceState();

  const view = isViewMode(candidate.view) ? candidate.view : 'table';
  const storedLayers: unknown[] = Array.isArray(candidate.layers) ? candidate.layers : [];
  // Walking the surface's own list rather than the stored one is what discards
  // a layer belonging to the other surface: anything not named here cannot
  // survive, whatever storage claims.
  const available: readonly CalendarLayer[] = SURFACE_LAYERS[surface];
  const layers = available.filter((layer) => storedLayers.includes(layer));

  return { view, layers: layers.length > 0 ? [...layers] : defaultSurfaceState().layers };
}

interface ViewModeState {
  surfaces: Record<ViewModeSurface, SurfaceViewState>;
  setView: (surface: ViewModeSurface, view: ViewMode) => void;
  toggleLayer: <S extends ViewModeSurface>(surface: S, layer: LayerOf<S>) => void;
}

export const useViewModeStore = create<ViewModeState>()(
  persist(
    (set) => ({
      surfaces: defaultSurfaces(),

      setView: (surface, view) =>
        set((state) => ({
          surfaces: { ...state.surfaces, [surface]: { ...state.surfaces[surface], view } },
        })),

      /**
       * Switch a layer on, or off unless it is the last one standing.
       *
       * At least one layer is always on (design section 1): a calendar with
       * every layer off is a month of empty boxes, which reads as a page that
       * failed to load rather than as a choice the reader made.
       */
      toggleLayer: (surface, layer) =>
        set((state) => {
          const current = state.surfaces[surface];
          const isOn = current.layers.includes(layer);
          if (isOn && current.layers.length === 1) return state;

          const available: readonly CalendarLayer[] = SURFACE_LAYERS[surface];
          const layers = available.filter((candidate) =>
            candidate === layer ? !isOn : current.layers.includes(candidate),
          );

          return { surfaces: { ...state.surfaces, [surface]: { ...current, layers: [...layers] } } };
        }),
    }),
    {
      name: VIEW_MODE_STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      // The actions are recreated on load; only the choices are worth storing.
      partialize: (state) => ({ surfaces: state.surfaces }),
      merge: (persisted, current) => {
        const stored = (persisted as { surfaces?: Record<string, unknown> } | undefined)?.surfaces;
        const surfaces = defaultSurfaces();

        if (stored && typeof stored === 'object') {
          for (const surface of VIEW_MODE_SURFACES) {
            surfaces[surface] = readSurface(surface, stored[surface]);
          }
        }

        return { ...current, surfaces };
      },
    },
  ),
);

/**
 * The one way a surface reads and changes its own view and layers.
 *
 * Selectors are subscribed per surface so the Transactions page does not
 * re-render when the Investments page's toggle moves, and the actions are
 * bound to the surface so a caller cannot write to the other one by forgetting
 * an argument.
 */
export function useViewMode<S extends ViewModeSurface>(surface: S) {
  const view = useViewModeStore((state) => state.surfaces[surface].view);
  const layers = useViewModeStore((state) => state.surfaces[surface].layers);
  const setForSurface = useViewModeStore((state) => state.setView);
  const toggleForSurface = useViewModeStore((state) => state.toggleLayer);

  const setView = useCallback(
    (next: ViewMode) => setForSurface(surface, next),
    [setForSurface, surface],
  );
  const toggleLayer = useCallback(
    (layer: LayerOf<S>) => toggleForSurface(surface, layer),
    [toggleForSurface, surface],
  );
  const isLayerOn = useCallback((layer: LayerOf<S>) => layers.includes(layer), [layers]);

  return { view, setView, layers, toggleLayer, isLayerOn };
}
