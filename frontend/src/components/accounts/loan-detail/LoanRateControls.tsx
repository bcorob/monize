'use client';

import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { NumericInput } from '@/components/ui/NumericInput';
import { CurrencyInput } from '@/components/ui/CurrencyInput';
import { DateInput } from '@/components/ui/DateInput';
import { Modal } from '@/components/ui/Modal';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { useDateFormat } from '@/hooks/useDateFormat';
import { LoanRateEditing } from './useLoanRateEditing';

interface LoanRateControlsProps {
  editing: LoanRateEditing;
}

/**
 * The Loan Schedule's rate-timeline controls: a header button to add a future
 * rate change manually, plus the add/edit modal, the delete confirmation, and
 * the scheduled-payment permission prompt. Historical rates are derived from
 * the interest actually charged, so there is no "detect" step. All behaviour
 * lives in `useLoanRateEditing`; this component only renders it.
 */
export function LoanRateControls({ editing }: LoanRateControlsProps) {
  const t = useTranslations('accounts');
  const { formatDate } = useDateFormat();
  const { form, setForm, formModal, isMortgage, currencySymbol } = editing;

  return (
    <div className="flex items-center gap-2">
      <Button size="sm" onClick={editing.openAdd}>
        {t('loanDetail.rateHistory.add')}
      </Button>

      <Modal
        isOpen={formModal !== null}
        onClose={editing.closeForm}
        maxWidth="md"
        className="p-6"
        title={
          formModal?.mode === 'edit'
            ? t('loanDetail.rateHistory.editTitle')
            : t('loanDetail.rateHistory.addTitle')
        }
      >
        <div>
          <div className="space-y-4">
            <DateInput
              label={t('loanDetail.rateHistory.effectiveDateLabel')}
              value={form.effectiveDate}
              onDateChange={(date) =>
                setForm((f) => ({ ...f, effectiveDate: date }))
              }
            />
            <NumericInput
              decimalPlaces={2}
              min={0}
              max={100}
              suffix="%"
              label={t('loanDetail.rateHistory.rateLabel')}
              value={form.annualRate}
              onChange={(value) =>
                setForm((f) => ({ ...f, annualRate: value }))
              }
            />

            <fieldset>
              <legend className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                {t('loanDetail.rateHistory.paymentModeLabel')}
              </legend>
              <div className="space-y-1.5">
                <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                  <input
                    type="radio"
                    name="paymentMode"
                    checked={form.paymentMode === 'keep'}
                    onChange={() => setForm((f) => ({ ...f, paymentMode: 'keep' }))}
                  />
                  {t('loanDetail.rateHistory.paymentModeKeep')}
                </label>
                <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                  <input
                    type="radio"
                    name="paymentMode"
                    checked={form.paymentMode === 'set'}
                    onChange={() => setForm((f) => ({ ...f, paymentMode: 'set' }))}
                  />
                  {t('loanDetail.rateHistory.paymentModeSet')}
                </label>
                {isMortgage && formModal?.mode === 'add' && (
                  <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                    <input
                      type="radio"
                      name="paymentMode"
                      checked={form.paymentMode === 'recalculate'}
                      onChange={() =>
                        setForm((f) => ({ ...f, paymentMode: 'recalculate' }))
                      }
                    />
                    {t('loanDetail.rateHistory.paymentModeRecalculate')}
                  </label>
                )}
              </div>
            </fieldset>

            {form.paymentMode === 'set' && (
              <CurrencyInput
                label={t('loanDetail.rateHistory.newPaymentLabel')}
                prefix={currencySymbol}
                allowNegative={false}
                value={form.newPaymentAmount}
                onChange={(value) =>
                  setForm((f) => ({ ...f, newPaymentAmount: value }))
                }
              />
            )}

            <Input
              label={t('loanDetail.rateHistory.noteLabel')}
              value={form.note}
              maxLength={500}
              onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
            />
          </div>

          <div className="mt-6 flex justify-end gap-2">
            <Button variant="outline" onClick={editing.closeForm}>
              {t('loanDetail.rateHistory.cancel')}
            </Button>
            <Button
              onClick={editing.submitForm}
              disabled={!editing.isFormValid}
              isLoading={editing.isSubmitting}
            >
              {t('loanDetail.rateHistory.save')}
            </Button>
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        isOpen={editing.changeToDelete !== null}
        title={t('loanDetail.rateHistory.deleteTitle')}
        message={t('loanDetail.rateHistory.deleteMessage', {
          date: editing.changeToDelete
            ? formatDate(editing.changeToDelete.effectiveDate)
            : '',
        })}
        confirmLabel={t('loanDetail.rateHistory.delete')}
        cancelLabel={t('loanDetail.rateHistory.cancel')}
        variant="danger"
        onConfirm={editing.confirmDelete}
        onCancel={editing.cancelDelete}
      />

      <ConfirmDialog
        isOpen={editing.scheduledPreview !== null}
        variant="info"
        title={t('loanDetail.rateHistory.scheduledUpdateTitle')}
        message={editing.scheduledUpdateMessage}
        confirmLabel={t('loanDetail.rateHistory.scheduledUpdateConfirm')}
        cancelLabel={t('loanDetail.rateHistory.scheduledUpdateSkip')}
        onConfirm={editing.applyScheduledPayment}
        onCancel={editing.skipScheduledPayment}
      />
    </div>
  );
}
