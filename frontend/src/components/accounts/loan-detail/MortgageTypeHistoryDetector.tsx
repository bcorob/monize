'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { TABLE_BODY_CLASS, TABLE_CLASS, Td, Th } from '@/components/ui/Table';
import { MortgageTypeSuggestion } from '@/components/accounts/MortgageTypeSuggestion';
import { accountsApi } from '@/lib/accounts';
import { createLogger } from '@/lib/logger';
import { mortgageTypeOf } from '@/lib/mortgage-type';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import type { Account, MortgageType, MortgageTypeHistoryDetection } from '@/types/account';

const logger = createLogger('MortgageTypeHistoryDetector');

interface MortgageTypeHistoryDetectorProps {
  account: Account;
  /**
   * Opens the account edit form with the confirmed type preselected. Nothing
   * is saved here: the person reviews and saves the form.
   */
  onUseMortgageType: (type: MortgageType) => void;
}

/**
 * "Detect mortgage type from history": asks the server to read the
 * mortgage's latest posted installments at one rate and suggest a type
 * (docs/specs/mortgage-types.md, section 10), then shows the suggestion, the
 * reason and the installments it was read from. Accepting it hands the type
 * to the edit form; neither step changes the account.
 */
export function MortgageTypeHistoryDetector({
  account,
  onUseMortgageType,
}: MortgageTypeHistoryDetectorProps) {
  const t = useTranslations('accounts');
  const { formatDate } = useDateFormat();
  const { formatCurrency, formatPercentTrimmed } = useNumberFormat();
  // The answer is kept with the account it was read for, so a page that
  // switches accounts never shows one mortgage's history under another.
  const [answer, setAnswer] = useState<{
    accountId: string;
    detection: MortgageTypeHistoryDetection;
  } | null>(null);
  const [isDetecting, setIsDetecting] = useState(false);

  const detection = answer?.accountId === account.id ? answer.detection : null;
  const currentType = mortgageTypeOf(account);
  const money = (amount: number) => formatCurrency(amount, account.currencyCode);

  const detect = async () => {
    setIsDetecting(true);
    try {
      const result = await accountsApi.detectMortgageTypeFromHistory(account.id);
      setAnswer({ accountId: account.id, detection: result });
    } catch (error) {
      logger.error('Failed to detect the mortgage type from history:', error);
      toast.error(t('mortgageFields.detect.history.failed'));
    } finally {
      setIsDetecting(false);
    }
  };

  const close = () => setAnswer(null);

  const accept = (type: MortgageType) => {
    setAnswer(null);
    onUseMortgageType(type);
  };

  const suggestedType = detection?.type ?? null;
  const offersChange = suggestedType !== null && suggestedType !== currentType;

  return (
    <>
      <Button variant="outline" size="sm" onClick={detect} isLoading={isDetecting}>
        {t('mortgageFields.detect.history.action')}
      </Button>

      <Modal
        isOpen={detection !== null}
        onClose={close}
        maxWidth="lg"
        padding="md"
        title={t('mortgageFields.detect.history.title')}
        description={t('mortgageFields.detect.history.intro')}
      >
        {detection && (
          <div className="space-y-4">
            <p className="text-sm text-gray-700 dark:text-gray-300">
              {t('mortgageFields.detect.history.current', {
                type: t(`mortgageFields.type.${currentType}`),
              })}
            </p>

            <MortgageTypeSuggestion detection={detection} />
            {suggestedType !== null && !offersChange && (
              <p className="text-sm text-gray-600 dark:text-gray-300">
                {t('mortgageFields.detect.history.alreadySet')}
              </p>
            )}

            <p className="text-xs text-gray-500 dark:text-gray-400">
              {detection.quotedAnnualRate != null
                ? t('mortgageFields.detect.history.rate', {
                    rate: formatPercentTrimmed(detection.quotedAnnualRate),
                  })
                : t('mortgageFields.detect.history.noRate')}
            </p>

            {detection.samples.length === 0 ? (
              <p className="text-sm text-gray-500 dark:text-gray-400">
                {t('mortgageFields.detect.history.noSamples')}
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className={TABLE_CLASS}>
                  <thead>
                    <tr>
                      <Th className="px-2">{t('mortgageFields.detect.history.colDate')}</Th>
                      <Th align="right" className="px-2">
                        {t('mortgageFields.detect.history.colPrincipal')}
                      </Th>
                      <Th align="right" className="px-2">
                        {t('mortgageFields.detect.history.colInterest')}
                      </Th>
                      <Th align="right" className="px-2">
                        {t('mortgageFields.detect.history.colBalance')}
                      </Th>
                    </tr>
                  </thead>
                  <tbody className={TABLE_BODY_CLASS}>
                    {detection.samples.map((sample) => (
                      <tr key={sample.date}>
                        <Td className="px-2 whitespace-nowrap">{formatDate(sample.date)}</Td>
                        <Td align="right" className="px-2 whitespace-nowrap">
                          {money(sample.principal)}
                        </Td>
                        <Td align="right" className="px-2 whitespace-nowrap">
                          {money(sample.interest)}
                        </Td>
                        <Td align="right" className="px-2 whitespace-nowrap">
                          {sample.balanceBefore != null
                            ? money(sample.balanceBefore)
                            : t('mortgageFields.detect.history.balanceUnknown')}
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="outline" onClick={close}>
                {t('mortgageFields.detect.history.cancel')}
              </Button>
              {offersChange && (
                <Button onClick={() => accept(suggestedType)}>
                  {t('mortgageFields.detect.history.use')}
                </Button>
              )}
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}
