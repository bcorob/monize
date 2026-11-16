'use client';

import { useEffect, useState } from 'react';
import { investmentsApi } from '@/lib/investments';
import type { BondRefreshProgress } from '@/types/bond';

export const BOND_REFRESH_POLL_MS = 1500;
/** Clock skew tolerated between the server's `startedAt` and this browser. */
export const BOND_REFRESH_SKEW_MS = 5000;

/**
 * Polls a bond program's refresh progress while `active`.
 *
 * A payload whose `startedAt` predates this poll (less the skew) belongs to an
 * earlier refresh and is ignored, as is one with no `startedAt`; a failed poll
 * keeps the last state, since progress is decoration beside the refresh and its
 * own outcome is reported elsewhere. Returns null until a current payload lands.
 */
export function useBondRefreshProgress(
  programId: string | null,
  active: boolean,
): BondRefreshProgress | null {
  const [progress, setProgress] = useState<BondRefreshProgress | null>(null);
  const [prevPolling, setPrevPolling] = useState(false);
  const polling = active && !!programId;

  // A new run starts from "nothing received", never from the last run's figures.
  if (polling !== prevPolling) {
    setPrevPolling(polling);
    if (polling) setProgress(null);
  }

  useEffect(() => {
    if (!polling || !programId) return;
    const startedPollingAt = Date.now();
    let cancelled = false;
    let inFlight = false;

    const poll = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const next = await investmentsApi.getBondRefreshProgress(programId);
        if (cancelled || !next?.startedAt) return;
        const startedAt = Date.parse(next.startedAt);
        if (Number.isNaN(startedAt)) return;
        if (startedAt < startedPollingAt - BOND_REFRESH_SKEW_MS) return;
        setProgress(next);
      } catch {
        // Keep the last state; the refresh reports its own failure.
      } finally {
        inFlight = false;
      }
    };

    const timer = setInterval(() => void poll(), BOND_REFRESH_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [polling, programId]);

  return progress;
}
