'use client';

import { useCallback, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { useTranslations } from 'next-intl';
import { payeesApi } from '@/lib/payees';
import { getErrorMessage } from '@/lib/errors';
import type {
  ContactLookupField,
  Payee,
  PayeeContactSuggestion,
} from '@/types/payee';

interface UsePayeeContactLookupOptions {
  /** Called with the saved payee after the user's confirmation was written. */
  onApplied?: (payee: Payee) => void | Promise<void>;
}

export interface PayeeContactLookupController {
  /** The payee the open candidates belong to, or null when none are open. */
  target: Payee | null;
  candidates: PayeeContactSuggestion[];
  lookingUp: boolean;
  saving: boolean;
  /**
   * Ask for the payee's contact details. `announce` says whether a lookup that
   * found nothing, or could not run, is worth a message: true where the user
   * pressed a button and is owed an answer, false where the lookup followed
   * from something else they did (creating a payee) and silence is not a
   * claim. An answer always opens the dialogue, either way.
   */
  lookUp: (payee: Payee, options?: { announce?: boolean }) => Promise<void>;
  /** Write the fields the user ticked, as their own edit. */
  apply: (values: Partial<Record<ContactLookupField, string>>) => Promise<void>;
  dismiss: () => void;
}

/**
 * The one way a surface offers a payee contact lookup to the user.
 *
 * The lookup itself writes nothing (INV-PAYEE-001): it returns candidates, the
 * user confirms which fields to take, and that confirmation goes through the
 * ordinary payee update -- their own edit, which is what makes replacing a
 * stored value legitimate here when the lookup may not.
 *
 * The candidates belong to the payee they were fetched for: a second lookup
 * supersedes the first, and a late answer whose request is no longer the
 * current one is dropped rather than shown against the wrong payee.
 */
export function usePayeeContactLookup(
  { onApplied }: UsePayeeContactLookupOptions = {},
): PayeeContactLookupController {
  const t = useTranslations('payeeDetail');
  const [target, setTarget] = useState<Payee | null>(null);
  const [candidates, setCandidates] = useState<PayeeContactSuggestion[]>([]);
  const [lookingUp, setLookingUp] = useState(false);
  const [saving, setSaving] = useState(false);
  const requestRef = useRef<symbol | null>(null);

  const lookUp = useCallback(
    async (payee: Payee, { announce = true }: { announce?: boolean } = {}) => {
      const request = Symbol('payee-contact-lookup');
      requestRef.current = request;
      setLookingUp(true);
      try {
        const result = await payeesApi.lookupContactForPayee(payee.id);
        if (requestRef.current !== request) return;
        if (result.reason === 'ok' && result.suggestions.length > 0) {
          setTarget(payee);
          setCandidates(result.suggestions);
          return;
        }
        if (!announce) return;
        // Each reason gets its own message: "could not look" must never read
        // as "nothing found".
        if (result.reason === 'ok' || result.reason === 'none') {
          toast(t('contactLookup.nothingNew'));
        } else if (result.reason === 'no_provider') {
          toast.error(t('contactLookup.noProvider'));
        } else if (result.reason === 'quota_exceeded') {
          // Distinct from no_provider: the user's own Google Places limit is
          // spent, and there is no AI provider behind it to take over.
          toast.error(t('contactLookup.quotaExceeded'));
        } else {
          toast.error(result.detail ?? t('contactLookup.failed'));
        }
      } catch (error) {
        if (requestRef.current !== request) return;
        if (announce) {
          toast.error(getErrorMessage(error, t('contactLookup.failed')));
        }
      } finally {
        if (requestRef.current === request) setLookingUp(false);
      }
    },
    [t],
  );

  const dismiss = useCallback(() => {
    requestRef.current = null;
    setTarget(null);
    setCandidates([]);
  }, []);

  const apply = useCallback(
    async (values: Partial<Record<ContactLookupField, string>>) => {
      if (!target || saving) return;
      setSaving(true);
      try {
        const saved = await payeesApi.update(target.id, values);
        setTarget(null);
        setCandidates([]);
        toast.success(
          t('contactLookup.applied', { count: Object.keys(values).length }),
        );
        await onApplied?.(saved);
      } catch (error) {
        toast.error(getErrorMessage(error, t('contactLookup.applyFailed')));
      } finally {
        setSaving(false);
      }
    },
    [onApplied, saving, t, target],
  );

  return { target, candidates, lookingUp, saving, lookUp, apply, dismiss };
}
