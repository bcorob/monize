'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { getPushSupport, pushApi, type PushConfig, type PushSupport } from '@/lib/push';
import { usePushEnable } from '@/hooks/usePushEnable';
import { useRereadOnVisible } from '@/hooks/useRereadOnVisible';
import { createLogger } from '@/lib/logger';

const logger = createLogger('EnableThisEndpoint');

interface EnableThisEndpointButtonProps {
  /**
   * Whether the server already holds a live row for the endpoint this browser
   * is holding. The caller knows it -- it is the one reading the device list --
   * and a second copy of that read here would be a second answer to the same
   * question.
   */
  registeredHere: boolean;
  /**
   * A sentence rendered beside the button saying what enabling would get the
   * reader. It belongs to the button rather than to the caller because the two
   * disappear together: a hint the caller rendered on its own would be left
   * standing, telling a browser that cannot receive push to press a button that
   * is not there.
   */
  hint?: string;
}

/**
 * "Enable on this device", wherever the reader happens to be looking.
 *
 * The push channel is registered per ENDPOINT -- the subscription this browser
 * holds -- so a reader whose phone is registered still has nothing on the
 * machine in front of them, and a channel toggle cannot grant the permission
 * that would fix it (spec section 14.5). This is the action that does, offered
 * beside the choice it unblocks rather than as a pointer to somewhere else on
 * the page.
 *
 * It renders nothing at all when it could not help: the instance does not offer
 * push, this browser cannot receive it, or the endpoint is already registered.
 * A button that can only fail is worse than no button.
 */
export function EnableThisEndpointButton({
  registeredHere,
  hint,
}: EnableThisEndpointButtonProps) {
  const t = useTranslations('settings.notifications.push');
  const [config, setConfig] = useState<PushConfig | null>(null);
  const [support, setSupport] = useState<PushSupport | null>(null);

  useEffect(() => {
    let cancelled = false;
    pushApi
      .getConfig()
      .then((value) => {
        if (cancelled) return;
        setConfig(value);
        setSupport(getPushSupport());
      })
      .catch((error) => {
        // A failed read is not "push is off here", and this control's whole
        // contract is to disappear when it cannot help -- so it disappears.
        logger.debug('Could not load push configuration', error);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // The permission and, on iOS, whether this window is the installed app are
  // both changed ELSEWHERE and returned to, so re-read on the way back rather
  // than trusting the mount read.
  useRereadOnVisible(
    useCallback(() => {
      if (config) setSupport(getPushSupport());
    }, [config]),
  );

  const { isEnabling, enable } = usePushEnable(config?.publicKey);

  if (!config?.enabled || !config.publicKey) return null;
  if (support === null || !support.supported) return null;
  if (registeredHere) return null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {hint && <span>{hint}</span>}
      <Button variant="outline" size="sm" disabled={isEnabling} onClick={enable}>
        {isEnabling ? t('enablingButton') : t('enableButton')}
      </Button>
    </div>
  );
}
