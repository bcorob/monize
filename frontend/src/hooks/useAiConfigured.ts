'use client';

import { useEffect, useState } from 'react';
import { aiApi } from '@/lib/ai';

export interface AiConfiguredState {
  /**
   * True only when the server said this user has an AI provider that can
   * answer. A request still in flight, or one that failed, leaves it false:
   * "we could not ask" is not "there is a provider", and a surface that offered
   * a paid lookup on a guess would fail at the point the user clicked it.
   */
  configured: boolean;
  /** False until the status request settles, whether it answered or failed. */
  resolved: boolean;
}

/**
 * Whether an AI provider is configured for this user.
 *
 * Every surface that can only work through a provider asks here rather than
 * showing a control whose one possible outcome is "configure a provider
 * first": the payee lookup surfaces (the payee form's button, the detail
 * card's button, the transaction page's quick-create) and their settings
 * toggle, plus the floating chat bubble and its toggle -- the opt-in
 * preference outlives the provider that justified it, so the bubble asks here
 * too rather than putting a launcher on every page after the last provider is
 * deleted.
 *
 * The read is cached and deduped in `aiApi.getStatus`, so mounting this in
 * several places costs one request, and a provider added or removed in
 * Settings drops that cache.
 */
export function useAiConfigured(): AiConfiguredState {
  const [state, setState] = useState<AiConfiguredState>({
    configured: false,
    resolved: false,
  });

  useEffect(() => {
    let active = true;
    aiApi
      .getStatus()
      .then((status) => {
        if (active) setState({ configured: status.configured, resolved: true });
      })
      .catch(() => {
        // Nothing to tell the user here: the surfaces that read this simply do
        // not offer the lookup, and one that runs anyway still reports the
        // server's own `no_provider` reason.
        if (active) setState({ configured: false, resolved: true });
      });
    return () => {
      active = false;
    };
  }, []);

  return state;
}
