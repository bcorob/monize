'use client';

import { useState } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useTranslations } from 'next-intl';
import '@/lib/zodConfig';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { NumericInput } from '@/components/ui/NumericInput';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { GOOGLE_PLACES_CAP } from '@/lib/google-places-cap';
import type { PayeeLookupSettings, UpdatePayeeLookupSettings } from '@/types/payee-lookup';

/**
 * Built from `t` so the messages are localized, the same shape
 * `buildProviderConfigSchema` uses on the AI provider form.
 *
 * The cap is held as a string because a blank field has to be distinguishable
 * from zero, and the key carries no format rule at all: what a valid Google
 * key looks like is Google's business, and the only honest test of one is the
 * Test button.
 */
function buildSchema(
  t: (key: string, values?: Record<string, string | number>) => string,
) {
  return z.object({
    apiKey: z.string().max(2000),
    capEnabled: z.boolean(),
    monthlyCap: z
      .string()
      .refine(
        (value) => {
          const parsed = Number(value);
          return (
            value.trim() !== '' &&
            Number.isInteger(parsed) &&
            parsed >= GOOGLE_PLACES_CAP.min &&
            parsed <= GOOGLE_PLACES_CAP.max
          );
        },
        {
          message: t('capRange', {
            min: GOOGLE_PLACES_CAP.min,
            max: GOOGLE_PLACES_CAP.max,
          }),
        },
      ),
  });
}

type FormData = z.infer<ReturnType<typeof buildSchema>>;
type TestStatus = 'idle' | 'testing' | 'success' | 'error';

interface GooglePlacesConfigModalProps {
  isOpen: boolean;
  settings: PayeeLookupSettings;
  onClose: () => void;
  onSave: (data: UpdatePayeeLookupSettings) => Promise<void>;
  onTest: (apiKey?: string) => Promise<{ available: boolean; error?: string }>;
}

export function GooglePlacesConfigModal({
  isOpen,
  settings,
  onClose,
  onSave,
  onTest,
}: GooglePlacesConfigModalProps) {
  const t = useTranslations('settings.payeeLookup.googlePlaces');
  const [testStatus, setTestStatus] = useState<TestStatus>('idle');
  const [testError, setTestError] = useState<string | null>(null);

  const {
    register,
    control,
    handleSubmit,
    getValues,
    formState: { errors, isSubmitting },
  } = useForm<FormData>({
    resolver: zodResolver(buildSchema(t)),
    defaultValues: {
      apiKey: '',
      capEnabled: settings.capEnabled,
      monthlyCap: String(settings.monthlyCap),
    },
  });

  // useWatch rather than the form's own watch(): the latter returns a function
  // React Compiler cannot memoize safely, which the lint rule flags.
  const capEnabled = useWatch({ control, name: 'capEnabled' });

  const submit = handleSubmit(async (data) => {
    const update: UpdatePayeeLookupSettings = {
      capEnabled: data.capEnabled,
      monthlyCap: Number(data.monthlyCap),
    };
    // An untouched key field means "keep the stored one". Sending an empty
    // string here would clear a key the user never intended to remove -- they
    // cannot see it to retype it.
    if (data.apiKey) update.apiKey = data.apiKey;
    await onSave(update);
  });

  const handleTest = async () => {
    setTestStatus('testing');
    setTestError(null);
    try {
      const result = await onTest(getValues('apiKey') || undefined);
      setTestStatus(result.available ? 'success' : 'error');
      setTestError(result.available ? null : (result.error ?? null));
    } catch {
      setTestStatus('error');
      setTestError(null);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={t('modalTitle')}
      description={t('modalSubtitle')}
      padding="md"
      maxWidth="lg"
      pushHistory
    >
      <form onSubmit={submit} className="space-y-4">
        <div>
          <Input
            label={t('apiKeyLabel')}
            type="password"
            // Not a credential of this site: a password manager filling the
            // account password here would be saved as the Google key.
            autoComplete="off"
            {...register('apiKey')}
            error={errors.apiKey?.message}
            placeholder={settings.apiKeyMasked ?? t('apiKeyPlaceholder')}
          />
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            {t('apiKeyHelp')}
          </p>
        </div>

        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
              {t('capToggleLabel')}
            </p>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {t('capHelp', { free: GOOGLE_PLACES_CAP.default })}
            </p>
          </div>
          <Controller
            name="capEnabled"
            control={control}
            render={({ field }) => (
              <ToggleSwitch
                checked={field.value}
                onChange={field.onChange}
                label={t('capToggleLabel')}
              />
            )}
          />
        </div>

        {capEnabled && (
          <Controller
            name="monthlyCap"
            control={control}
            render={({ field }) => (
              <NumericInput
                label={t('capLabel')}
                name={field.name}
                value={field.value === '' ? undefined : Number(field.value)}
                onChange={(value) =>
                  field.onChange(value === undefined ? '' : String(value))
                }
                onBlur={field.onBlur}
                decimalPlaces={0}
                max={GOOGLE_PLACES_CAP.max}
                error={errors.monthlyCap?.message}
              />
            )}
          />
        )}

        {testStatus === 'error' && testError && (
          <p className="text-sm text-red-600 dark:text-red-400">{testError}</p>
        )}
        {testStatus === 'success' && (
          <p className="text-sm text-green-600 dark:text-green-400">
            {t('testSuccess')}
          </p>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="outline" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={handleTest}
            disabled={testStatus === 'testing' || isSubmitting}
            className={
              testStatus === 'success'
                ? 'border-green-500 text-green-600 dark:border-green-400 dark:text-green-400'
                : testStatus === 'error'
                  ? 'border-red-500 text-red-600 dark:border-red-400 dark:text-red-400'
                  : ''
            }
          >
            {testStatus === 'testing' ? t('testing') : t('test')}
          </Button>
          <Button type="submit" disabled={isSubmitting}>
            {t('save')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
