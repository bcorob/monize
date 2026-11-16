'use client';

import { MutableRefObject, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { useForm, useWatch } from 'react-hook-form';
import '@/lib/zodConfig';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Select } from '@/components/ui/Select';
import { DateInput } from '@/components/ui/DateInput';
import { FormActions } from '@/components/ui/FormActions';
import { useFormSubmitRef } from '@/hooks/useFormSubmitRef';
import { useFormDirtyNotify } from '@/hooks/useFormDirtyNotify';
import { isCalendarDate } from '@/lib/calendar-month';
import { textOrNull } from '@/lib/form-text';
import {
  WARRANTY_CLAIM_CLOSED_STATUSES,
  WARRANTY_CLAIM_STATUSES,
  WARRANTY_CLAIM_TEXT_MAX_LENGTH,
  type CreateWarrantyClaimData,
  type WarrantyClaim,
  type WarrantyClaimStatus,
} from '@/types/warranty';

const TEXTAREA_CLASS =
  'block w-full rounded-md border-gray-300 shadow-sm focus:outline-none focus-visible:border-blue-500 focus-visible:ring-2 focus-visible:ring-blue-500 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 dark:focus-visible:border-blue-400 dark:focus-visible:ring-blue-400';

/** Whether a claim in this status may carry a closing date (the DTO's `resolvedOnStatus`). */
export function claimStatusCloses(status: WarrantyClaimStatus): boolean {
  return WARRANTY_CLAIM_CLOSED_STATUSES.includes(status);
}

const buildClaimSchema = (t: (key: string) => string) =>
  z
    .object({
      claimDate: z.string().refine((value) => isCalendarDate(value), t('claims.validation.claimDateRequired')),
      status: z.enum(WARRANTY_CLAIM_STATUSES as [WarrantyClaimStatus, ...WarrantyClaimStatus[]]),
      description: z.string().max(WARRANTY_CLAIM_TEXT_MAX_LENGTH, t('claims.validation.textTooLong')),
      resolution: z.string().max(WARRANTY_CLAIM_TEXT_MAX_LENGTH, t('claims.validation.textTooLong')),
      resolvedOn: z.string(),
    })
    .superRefine((data, ctx) => {
      // The DTO's "resolvedOn must be on or after claimDate", said at the
      // field. Both are YYYY-MM-DD, whose string order is calendar order.
      if (
        claimStatusCloses(data.status) &&
        isCalendarDate(data.resolvedOn) &&
        isCalendarDate(data.claimDate) &&
        data.resolvedOn < data.claimDate
      ) {
        ctx.addIssue({ code: 'custom', path: ['resolvedOn'], message: t('claims.validation.resolvedOnBeforeClaim') });
      }
    });

export type WarrantyClaimFormData = z.infer<ReturnType<typeof buildClaimSchema>>;

/**
 * The request body for the form's values. Every field is sent, so an edit can
 * clear one; `resolvedOn` is `null` unless the status closes the claim, which
 * is also what reopening a closed claim must send (the server refuses an open
 * claim that keeps its stored closing date).
 */
export function toClaimPayload(values: WarrantyClaimFormData): CreateWarrantyClaimData {
  const resolvedOn =
    claimStatusCloses(values.status) && isCalendarDate(values.resolvedOn) ? values.resolvedOn : null;
  return {
    claimDate: values.claimDate,
    status: values.status,
    description: textOrNull(values.description),
    resolution: textOrNull(values.resolution),
    resolvedOn,
  };
}

interface WarrantyClaimFormProps {
  /** The claim being edited; absent for a new one. */
  claim?: WarrantyClaim;
  /** The reader's own date (`Warranty.today`), the claim date a new claim starts on. */
  today: string;
  onSubmit: (data: CreateWarrantyClaimData) => Promise<void>;
  onCancel: () => void;
  onDirtyChange?: (isDirty: boolean) => void;
  submitRef?: MutableRefObject<(() => void) | null>;
}

/**
 * Create or edit one claim against a warranty (design decision 8). The
 * closing date is offered only for a resolved or denied claim, and choosing an
 * open or approved status clears it.
 */
export function WarrantyClaimForm({ claim, today, onSubmit, onCancel, onDirtyChange, submitRef }: WarrantyClaimFormProps) {
  const t = useTranslations('warranties');

  const {
    register,
    control,
    handleSubmit,
    setValue,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<WarrantyClaimFormData>({
    resolver: zodResolver(buildClaimSchema(t)),
    defaultValues: {
      claimDate: claim?.claimDate ?? today,
      status: claim?.status ?? 'open',
      description: claim?.description ?? '',
      resolution: claim?.resolution ?? '',
      resolvedOn: claim?.resolvedOn ?? '',
    },
  });

  const handleValid = useCallback(
    (data: WarrantyClaimFormData) => onSubmit(toClaimPayload(data)),
    [onSubmit],
  );

  useFormDirtyNotify(isDirty, onDirtyChange);
  useFormSubmitRef(submitRef, handleSubmit, handleValid);

  const claimDate = useWatch({ control, name: 'claimDate' });
  const status = useWatch({ control, name: 'status' });
  const resolvedOn = useWatch({ control, name: 'resolvedOn' });
  const closes = claimStatusCloses(status);

  const statusField = register('status');

  const onFormSubmit = (e?: React.BaseSyntheticEvent) => {
    handleSubmit(handleValid)(e);
  };

  return (
    <form onSubmit={onFormSubmit} className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <DateInput
          label={t('claims.form.claimDateLabel')}
          value={claimDate}
          onDateChange={(date) => setValue('claimDate', date, { shouldDirty: true, shouldValidate: true })}
          error={errors.claimDate?.message}
        />
        <Select
          id="warranty-claim-status"
          label={t('claims.form.statusLabel')}
          options={WARRANTY_CLAIM_STATUSES.map((value) => ({ value, label: t(`claims.statuses.${value}`) }))}
          error={errors.status?.message}
          {...statusField}
          onChange={(event) => {
            void statusField.onChange(event);
            // An open or approved claim has not closed: drop the date rather
            // than submit one the server would refuse.
            if (!claimStatusCloses(event.target.value as WarrantyClaimStatus)) {
              setValue('resolvedOn', '', { shouldDirty: true });
            }
          }}
        />
      </div>

      <div>
        <label htmlFor="warranty-claim-description" className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
          {t('claims.form.descriptionLabel')}
        </label>
        <textarea
          id="warranty-claim-description"
          rows={3}
          maxLength={WARRANTY_CLAIM_TEXT_MAX_LENGTH}
          className={TEXTAREA_CLASS}
          {...register('description')}
        />
        {errors.description && (
          <p className="mt-1 text-sm text-red-600 dark:text-red-400">{errors.description.message}</p>
        )}
      </div>

      <div>
        <label htmlFor="warranty-claim-resolution" className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
          {t('claims.form.resolutionLabel')}
        </label>
        <textarea
          id="warranty-claim-resolution"
          rows={2}
          maxLength={WARRANTY_CLAIM_TEXT_MAX_LENGTH}
          className={TEXTAREA_CLASS}
          {...register('resolution')}
        />
        {errors.resolution && (
          <p className="mt-1 text-sm text-red-600 dark:text-red-400">{errors.resolution.message}</p>
        )}
      </div>

      <div className="md:max-w-[50%] md:pr-2">
        <DateInput
          label={t('claims.form.resolvedOnLabel')}
          value={closes ? resolvedOn : ''}
          disabled={!closes}
          onDateChange={(date) => setValue('resolvedOn', date, { shouldDirty: true, shouldValidate: true })}
          error={errors.resolvedOn?.message}
        />
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{t('claims.form.resolvedOnHint')}</p>
      </div>

      <FormActions
        onCancel={onCancel}
        submitLabel={claim ? t('claims.form.submitUpdate') : t('claims.form.submitCreate')}
        isSubmitting={isSubmitting}
      />
    </form>
  );
}
