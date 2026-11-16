'use client';

import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { KeyValueList } from '@/components/ui/KeyValueList';
import { TABLE_BODY_CLASS } from '@/components/ui/Table';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import type { AdminPushConfig } from '@/lib/admin-notifications';
import { useDateFormat } from '@/hooks/useDateFormat';

/**
 * One row per delivery channel this deployment could offer, with the state the
 * server reports rather than a guess.
 *
 * `available` is deliberately three-valued through its own copy: a channel can
 * be on, off by an administrator's decision, or unavailable because the
 * deployment never configured it. Collapsing the last two into "off" would send
 * an operator to flip a switch that is not the problem.
 *
 * `unknown` is that same argument one state further out: while the status has not
 * arrived -- the first render, or a read that failed -- the answer is not known,
 * and drawing "Unavailable" there sends an operator to configure something that
 * may already be configured. The note beside the pill says which read failed.
 */
export type ChannelState = 'on' | 'off' | 'unconfigured' | 'unknown';

export interface ChannelRow {
  id: string;
  name: string;
  description: string;
  state: ChannelState;
  /** Why it is unavailable, when it is; rendered instead of the state pill. */
  unavailableNote?: string;
  toggle?: {
    label: string;
    checked: boolean;
    onChange: () => void;
    disabled?: boolean;
  };
}

interface PushChannelsPanelProps {
  channels: ChannelRow[];
}

const STATE_CLASS: Record<ChannelState, string> = {
  on: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
  off: 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300',
  unconfigured:
    'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300',
  // Neither green nor amber: an unread status is not a verdict either way.
  unknown:
    'bg-gray-100 text-gray-500 dark:bg-gray-700/60 dark:text-gray-400',
};

export function PushChannelsPanel({ channels }: PushChannelsPanelProps) {
  const t = useTranslations('admin.notificationsPage');

  return (
    <div className={TABLE_BODY_CLASS}>
      {channels.map((channel) => (
        <div
          key={channel.id}
          className="flex flex-wrap items-start justify-between gap-3 px-4 py-4 sm:px-6"
        >
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
                {channel.name}
              </p>
              <span
                className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium ${STATE_CLASS[channel.state]}`}
              >
                {t(`channelState.${channel.state}`)}
              </span>
            </div>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              {channel.description}
            </p>
            {channel.unavailableNote && (
              <p className="mt-1 text-sm text-amber-700 dark:text-amber-400">
                {channel.unavailableNote}
              </p>
            )}
          </div>

          {channel.toggle && (
            // The project's one switch. Hand-rolled here it came out 44px wide
            // against ToggleSwitch's 36 -- visibly a different control from every
            // other switch in Settings, with its own focus-ring offset colour.
            <ToggleSwitch
              checked={channel.toggle.checked}
              onChange={() => channel.toggle?.onChange()}
              disabled={channel.toggle.disabled}
              label={channel.toggle.label}
            />
          )}
        </div>
      ))}
    </div>
  );
}

interface VapidIdentityPanelProps {
  config: AdminPushConfig;
  isRotating: boolean;
  onRotate: () => void;
}

/**
 * This instance's push identity.
 *
 * The fingerprint, not the raw key, is what an operator compares between two
 * deployments -- and it is all that is needed to answer "are these the same
 * instance". The private half has no field on any shape the API returns.
 */
export function VapidIdentityPanel({
  config,
  isRotating,
  onRotate,
}: VapidIdentityPanelProps) {
  const t = useTranslations('admin.notificationsPage');
  const { formatDateTime } = useDateFormat();

  if (!config.configured) {
    return (
      <div className="px-4 py-4 sm:px-6">
        <p className="text-sm text-amber-700 dark:text-amber-400">
          {t('identity.missingEncryptionKey')}
        </p>
      </div>
    );
  }

  return (
    <div className="px-4 py-4 sm:px-6">
      <KeyValueList
        variant="pairs"
        rows={[
          {
            key: 'fingerprint',
            label: t('identity.fingerprintLabel'),
            value: <span className="font-mono break-all">{config.publicKeyFingerprint}</span>,
          },
          {
            key: 'generated',
            label: t('identity.generatedLabel'),
            value: config.generatedAt ? formatDateTime(config.generatedAt) : '-',
          },
          {
            key: 'devices',
            label: t('identity.devicesLabel'),
            value: t('identity.deviceCounts', {
              live: config.liveSubscriptionCount,
              disabled: config.disabledSubscriptionCount,
            }),
          },
        ]}
      />

      {config.keyUnreadable && (
        <p className="mt-4 text-sm text-amber-700 dark:text-amber-400">
          {/* Which repair depends on WHY the key cannot be read: rotating fixes a
              key that changed under a live database, and is refused outright
              when the server has no ENCRYPTION_KEY -- so the rotate message was
              an instruction guaranteed to fail in one of the two states. */}
          {config.encryptionAvailable === false
            ? t('identity.serverKeyMissing')
            : t('identity.keyUnreadable')}
        </p>
      )}

      <p className="mt-4 text-sm text-gray-500 dark:text-gray-400">
        {t('identity.rotateDescription')}
      </p>
      <Button
        variant="outline"
        size="sm"
        className="mt-2"
        disabled={isRotating}
        onClick={onRotate}
      >
        {isRotating ? t('identity.rotatingButton') : t('identity.rotateButton')}
      </Button>
    </div>
  );
}
