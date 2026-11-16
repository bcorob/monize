'use client';

import { useEffect, useRef } from 'react';
import { useAuthStore } from '@/store/authStore';
import {
  pushApi,
  readRegisteredEndpoint,
  resumePushAfterSignIn,
} from '@/lib/push';
import { notifyPushDevicesChanged } from '@/lib/pushDevicesSignal';
import { createLogger } from '@/lib/logger';

const logger = createLogger('PushResume');

/**
 * Resume push on this browser when the account that signed out of it (and had
 * its device held, `holdPushForSignOut`) signs in here again.
 *
 * Mounted once, in the authenticated shell, which is where every sign-in path
 * (password, 2FA, OIDC, passkey) lands. It reads the local marker first and
 * makes no request unless the marker is held and names the reader, so an
 * ordinary page load costs nothing. At most one attempt per sign-in.
 *
 * Nothing here asks for a permission: a resume needs one already granted, and
 * `resumePushAfterSignIn` releases instead when it is not.
 */
export function usePushResumeOnSignIn(): void {
  const userId = useAuthStore((state) =>
    state.isAuthenticated ? (state.user?.id ?? null) : null,
  );
  const attemptedFor = useRef<string | null>(null);

  useEffect(() => {
    // A sign-out ends the attempt: the shell stays mounted across sign-out and
    // sign-in (client-side navigation), and the next sign-in by the same
    // account has a freshly held row to resume.
    if (userId === null) {
      attemptedFor.current = null;
      return;
    }
    if (attemptedFor.current === userId) return;
    const marker = readRegisteredEndpoint();
    if (marker === null || !marker.held || marker.userId !== userId) return;
    attemptedFor.current = userId;

    void (async () => {
      try {
        const config = await pushApi.getConfig();
        if (!config.enabled || !config.publicKey) return;
        if (await resumePushAfterSignIn(config.publicKey)) {
          // The banner waits on a held marker, and the settings surfaces list
          // the row whose hold just cleared.
          notifyPushDevicesChanged();
        }
      } catch (error) {
        // Silent: nothing was asked of the reader, and a held row delivers
        // nothing, so the failure leaves no wrong state behind.
        logger.debug('Could not resume push after sign-in', error);
      }
    })();
  }, [userId]);
}
