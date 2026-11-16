'use client';

import { useCallback, useEffect, useState } from 'react';
import { payeeLookupApi } from '@/lib/payee-lookup';
import type { PayeeLookupStatus } from '@/types/payee-lookup';

export interface ContactLookupAvailability {
  /**
   * True only when the server said a lookup can actually run -- Google Places
   * within its cap, or an AI provider. A request still in flight, or one that
   * failed, leaves it false: "we could not ask" is not "a source exists", and
   * a surface that offered a paid lookup on a guess would fail at the click.
   */
  available: boolean;
  /** False until the status request settles, whether it answered or failed. */
  resolved: boolean;
  /**
   * The status request settled by failing.
   *
   * `available: false` is three states at once -- still asking, could not ask,
   * and asked and nothing can answer -- and the surfaces that merely withhold
   * a button are right to treat all three alike. A surface that EXPLAINS the
   * state is not: telling a user to switch a source on, when the sources are
   * on and it was the status read that failed, sends them to fix something
   * that is not broken. Same distinction `useExchangeRates` draws between
   * `ratesUnavailable` and `ratesFailed`.
   */
  failed: boolean;
  /** Which source would answer, for copy that names it. Null when none can. */
  source: PayeeLookupStatus['source'];
  /**
   * Whether an AI provider exists. The Payee Lookup settings section reads it
   * to decide whether the AI row is worth drawing at all: with no provider
   * there is nothing to switch on or to order.
   */
  aiConfigured: boolean;
  /**
   * Ask again.
   *
   * Only the settings card needs this, and it needs it because it is the one
   * surface that CHANGES the answer: switching a source off makes a lookup
   * impossible, and the mounted hook would otherwise hold the value it read on
   * mount for the rest of the session. Re-reading keeps the server the single
   * authority on "can a lookup run" -- the alternative, re-deriving that from
   * the settings row on the client, is a second copy of a decision that
   * already accounts for the spent cap and an unreadable key.
   */
  refresh: () => Promise<void>;
}

/**
 * Whether this user can look a payee's contact details up at all.
 *
 * Every surface offering a lookup asks here rather than asking whether an AI
 * provider exists: since Google Places can answer instead, `useAiConfigured`
 * would hide the button from a user who configured Places and no AI -- exactly
 * the configuration this feature exists to support. `useAiConfigured` remains
 * correct for the assistant and its own toggle, which genuinely need a model.
 *
 * The read is cached and deduped in `payeeLookupApi.getStatus`, so mounting
 * this on the payee form, the detail card and the transaction page costs one
 * request; a settings save or an AI provider change drops that cache.
 */
type Availability = Omit<ContactLookupAvailability, 'refresh'>;

/**
 * The mapping, written once so the mount read and the refresh cannot answer
 * differently for one status payload.
 */
const fromStatus = (status: PayeeLookupStatus): Availability => ({
  available: status.available,
  resolved: true,
  failed: false,
  source: status.source,
  aiConfigured: status.aiConfigured,
});

/**
 * What a failed read means. Nothing to tell the user here: the surfaces
 * reading this simply do not offer the lookup, and one that runs anyway still
 * reports the server's own reason.
 */
const UNAVAILABLE: Availability = {
  available: false,
  resolved: true,
  failed: true,
  source: null,
  aiConfigured: false,
};

export function useContactLookupAvailable(): ContactLookupAvailability {
  const [state, setState] = useState<Availability>({
    ...UNAVAILABLE,
    resolved: false,
    // Not yet asked is not "asked and failed": only a settled request may
    // claim either.
    failed: false,
  });

  useEffect(() => {
    let active = true;
    payeeLookupApi
      .getStatus()
      .then((status) => {
        if (active) setState(fromStatus(status));
      })
      .catch(() => {
        if (active) setState(UNAVAILABLE);
      });
    return () => {
      active = false;
    };
  }, []);

  const refresh = useCallback(
    () =>
      payeeLookupApi
        .getStatus()
        .then((status) => {
          setState(fromStatus(status));
        })
        .catch(() => {
          setState(UNAVAILABLE);
        }),
    [],
  );

  return { ...state, refresh };
}
