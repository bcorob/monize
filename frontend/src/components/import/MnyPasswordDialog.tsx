'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { PasswordInput } from '@/components/ui/PasswordInput';

interface MnyPasswordDialogProps {
  isOpen: boolean;
  /** True when a password was already tried and rejected. */
  isRetry: boolean;
  isLoading: boolean;
  onSubmit: (password: string) => void;
  onCancel: () => void;
}

/**
 * Asks for the Money file's password.
 *
 * Every `.mny` file is encrypted, but most are encrypted with a blank password
 * and open without asking. This appears only when the blank password fails, which
 * is exactly what the backend means by "password protected" -- and the retry
 * wording is separate, because "that password is wrong" and "this file needs a
 * password" are different problems for the person typing.
 */
export function MnyPasswordDialog({
  isOpen,
  isRetry,
  isLoading,
  onSubmit,
  onCancel,
}: MnyPasswordDialogProps) {
  const t = useTranslations('import');
  const tc = useTranslations('common');
  const [password, setPassword] = useState('');

  return (
    <Modal
      isOpen={isOpen}
      onClose={onCancel}
      maxWidth="sm"
      pushHistory
      title={t('mnyPassword.heading')}
      description={t('mnyPassword.body')}
      className="p-6"
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit(password);
        }}
      >
        {/* The rejection is feedback on what was just typed, not help, so it
            stays on the page rather than joining the description tooltip. */}
        {isRetry && (
          <p role="alert" className="mb-4 text-sm text-red-600 dark:text-red-400">
            {t('mnyPassword.retryBody')}
          </p>
        )}

        <label
          htmlFor="mny-password"
          className="block text-sm font-medium text-foreground"
        >
          {t('mnyPassword.label')}
        </label>
        <PasswordInput
          id="mny-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="off"
          autoFocus
          className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
        />

        <div className="mt-6 flex justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={onCancel}
            disabled={isLoading}
          >
            {tc('cancel')}
          </Button>
          <Button type="submit" isLoading={isLoading} disabled={!password}>
            {t('mnyPassword.submit')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
