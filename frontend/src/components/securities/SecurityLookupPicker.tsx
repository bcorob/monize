'use client';

import { useTranslations } from 'next-intl';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { TABLE_CLASS, Th } from '@/components/ui/Table';

export interface LookupCandidate {
  symbol: string;
  name: string;
  exchange: string | null;
  securityType: string | null;
  currencyCode: string | null;
  provider?: 'yahoo' | 'msn' | 'lse' | 'deutsche_boerse';
  msnInstrumentId?: string | null;
}

interface SecurityLookupPickerProps {
  isOpen: boolean;
  query: string;
  candidates: LookupCandidate[];
  onPick: (candidate: LookupCandidate) => void;
  onCancel: () => void;
}

const PROVIDER_BADGE_LABELS: Record<string, string> = {
  yahoo: 'Yahoo',
  msn: 'MSN',
  lse: 'LSE',
  deutsche_boerse: 'Deutsche Börse',
};

const PROVIDER_BADGE_CLASSES: Record<string, string> = {
  yahoo: 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300',
  msn: 'bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300',
  lse: 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300',
  deutsche_boerse:
    'bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300',
};

function providerBadge(
  provider: 'yahoo' | 'msn' | 'lse' | 'deutsche_boerse' | undefined,
) {
  if (!provider) return null;
  const label = PROVIDER_BADGE_LABELS[provider] ?? provider;
  const cls =
    PROVIDER_BADGE_CLASSES[provider] ??
    'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300';
  return (
    <span className={`inline-flex items-center rounded text-xs font-medium px-2 py-0.5 ${cls}`}>
      {label}
    </span>
  );
}

export function SecurityLookupPicker({
  isOpen,
  query,
  candidates,
  onPick,
  onCancel,
}: SecurityLookupPickerProps) {
  const t = useTranslations('securities');
  const tc = useTranslations('common');
  return (
    <Modal
      isOpen={isOpen}
      onClose={onCancel}
      maxWidth="6xl"
      padding="md"
      title={t('lookupPicker.title', { query })}
      description={t('lookupPicker.subtitle')}
      footer={
        <Button type="button" variant="outline" onClick={onCancel}>
          {tc('cancel')}
        </Button>
      }
    >
      <div className="max-h-[60vh] overflow-y-auto">
        <table className={TABLE_CLASS}>
          <thead className="bg-gray-50 dark:bg-gray-800 sticky top-0">
            <tr>
              <Th>{t('lookupPicker.columns.symbol')}</Th>
              <Th>{t('lookupPicker.columns.name')}</Th>
              <Th>{t('lookupPicker.columns.exchange')}</Th>
              <Th>{t('lookupPicker.columns.currency')}</Th>
              <Th>{t('lookupPicker.columns.type')}</Th>
              <Th>{t('lookupPicker.columns.source')}</Th>
              <Th>
                <span className="sr-only">{t('lookupPicker.selectButton')}</span>
              </Th>
            </tr>
          </thead>
          <tbody className="bg-white dark:bg-gray-900 divide-y divide-gray-200 dark:divide-gray-700">
            {candidates.map((c, i) => (
              <tr
                key={`${c.symbol}-${c.exchange || ''}-${c.msnInstrumentId || ''}-${i}`}
                className="hover:bg-gray-50 dark:hover:bg-gray-800 cursor-pointer"
                onClick={() => onPick(c)}
              >
                <td className="px-4 py-2 whitespace-nowrap text-sm font-medium text-gray-900 dark:text-gray-100">
                  {c.symbol}
                </td>
                <td className="px-4 py-2 text-sm text-gray-700 dark:text-gray-300">
                  {c.name}
                </td>
                <td className="px-4 py-2 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">
                  {c.exchange || '-'}
                </td>
                <td className="px-4 py-2 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">
                  {c.currencyCode || '-'}
                </td>
                <td className="px-4 py-2 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">
                  {c.securityType || '-'}
                </td>
                <td className="px-4 py-2 whitespace-nowrap">
                  {providerBadge(c.provider)}
                </td>
                <td className="px-4 py-2 text-right">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      onPick(c);
                    }}
                  >
                    {t('lookupPicker.selectButton')}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Modal>
  );
}
