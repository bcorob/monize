'use client';

import { useCallback, useState } from 'react';
import { useTranslations } from 'next-intl';
import toast from 'react-hot-toast';
import {
  defaultDeviceName,
  enablePushOnThisDevice,
  isInstalledIosWebApp,
  pushPermissionMessageKey,
  PushPermissionError,
  PushServiceError,
} from '@/lib/push';
import { getErrorMessage } from '@/lib/errors';
import { notifyPushDevicesChanged } from '@/lib/pushDevicesSignal';

/**
 * Registering THIS browser's endpoint for push, as one action every surface
 * that offers it shares.
 *
 * It exists because the flow is two things at once -- a permission request and a
 * subscription -- and both halves have rules a second copy would get wrong:
 *
 *   * `enable` is deliberately NOT async. The permission prompt only appears
 *     while the click's transient activation lasts, and iOS spends that on the
 *     first suspension -- so `enablePushOnThisDevice` is called synchronously,
 *     before any state update, and only the reporting happens after an await.
 *     Written as `async () => { setIsEnabling(true); await enable(...) }` this
 *     asks for a permission the user is then told they did not grant, with no
 *     prompt ever shown.
 *   * A refusal has three shapes with three different repairs (the browser's
 *     permission, Brave's push-service switch, anything else), and one rule maps
 *     each to its message (`pushPermissionMessageKey`).
 *
 * A successful registration announces itself through `notifyPushDevicesChanged`
 * rather than through a per-caller callback. Both surfaces that offer this
 * button also LIST devices, and every listing surface already subscribes, so a
 * callback would reload the caller a second time and still leave the other one
 * stale -- one mechanism, reaching everybody.
 */
export function usePushEnable(
  publicKey: string | null | undefined,
): { isEnabling: boolean; enable: () => void } {
  const t = useTranslations('settings.notifications.push');
  const [isEnabling, setIsEnabling] = useState(false);

  const enable = useCallback(() => {
    if (!publicKey) return;
    const enabling = enablePushOnThisDevice(publicKey, defaultDeviceName());
    setIsEnabling(true);
    void (async () => {
      try {
        await enabling;
        // Every surface reading the device list, not only the one that owns
        // this button: the panel and the matrix hold separate copies, so
        // refreshing only the caller left the other offering to enable a
        // device that had just been registered.
        notifyPushDevicesChanged();
        toast.success(t('toasts.enabled'));
      } catch (error) {
        if (error instanceof PushPermissionError) {
          toast.error(
            t(`toasts.${pushPermissionMessageKey(error, isInstalledIosWebApp())}`),
          );
        } else if (error instanceof PushServiceError) {
          // Permission granted, worker active, and the push service still said
          // no. On Brave that is one privacy switch away; say which.
          toast.error(
            error.brave
              ? t('toasts.pushServiceRefusedBrave')
              : t('toasts.pushServiceRefused'),
          );
        } else {
          toast.error(getErrorMessage(error, t('toasts.enableFailed')));
        }
      } finally {
        setIsEnabling(false);
      }
    })();
  }, [publicKey, t]);

  return { isEnabling, enable };
}
