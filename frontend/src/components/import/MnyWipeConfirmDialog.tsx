'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { PasswordInput } from '@/components/ui/PasswordInput';

/** The word a user types to confirm, matching the Settings danger zone. */
export const WIPE_CONFIRM_WORD = 'DELETE';

interface MnyWipeConfirmDialogProps {
  isOpen: boolean;
  /** OIDC accounts re-authenticate with their provider instead of a password. */
  isOidc: boolean;
  isLoading: boolean;
  /** Password is empty for an OIDC account, whose confirmation is the re-auth. */
  onConfirm: (password: string) => void;
  onCancel: () => void;
}

/**
 * Confirms the optional "start fresh" wipe before a Money import.
 *
 * The wipe is not part of the importer: it calls the same delete-my-data
 * operation as Settings, and this dialog names it as such, lists exactly what
 * that operation removes, and demands both the typed keyword and the account
 * password. PR #192's migration script deleted everything unconditionally with
 * no prompt at all, which is the reason the default here is to delete nothing.
 */
export function MnyWipeConfirmDialog({
  isOpen,
  isOidc,
  isLoading,
  onConfirm,
  onCancel,
}: MnyWipeConfirmDialogProps) {
  const t = useTranslations('import');
  const tc = useTranslations('common');
  const [confirmText, setConfirmText] = useState('');
  const [password, setPassword] = useState('');

  const canConfirm =
    confirmText === WIPE_CONFIRM_WORD && (isOidc || password.length > 0);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onCancel}
      maxWidth="md"
      pushHistory
      title={t('mnyWipe.heading')}
      className="p-6"
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (canConfirm) {
            onConfirm(password);
          }
        }}
      >
        {/* A one-time warning about an irreversible delete, not help text, so
            it stays a paragraph rather than an InfoTooltip. */}
        <p className="text-sm text-muted-foreground">
          {t('mnyWipe.body')}
        </p>

        <ul className="mt-3 list-disc ml-5 space-y-1 text-sm text-foreground">
          <li>{t('mnyWipe.removes.transactions')}</li>
          <li>{t('mnyWipe.removes.scheduled')}</li>
          <li>{t('mnyWipe.removes.investments')}</li>
          <li>{t('mnyWipe.removes.accounts')}</li>
          <li>{t('mnyWipe.removes.budgets')}</li>
        </ul>

        <p className="mt-3 text-sm text-muted-foreground">
          {t('mnyWipe.irreversible')}
        </p>

        <label
          htmlFor="mny-wipe-confirm"
          className="mt-4 block text-sm font-medium text-foreground"
        >
          {t('mnyWipe.typeToConfirm', { word: WIPE_CONFIRM_WORD })}
        </label>
        <Input
          id="mny-wipe-confirm"
          value={confirmText}
          onChange={(e) => setConfirmText(e.target.value)}
          placeholder={WIPE_CONFIRM_WORD}
          autoComplete="off"
          className="mt-1"
        />

        {!isOidc && (
          <>
            <label
              htmlFor="mny-wipe-password"
              className="mt-4 block text-sm font-medium text-foreground"
            >
              {t('mnyWipe.passwordLabel')}
            </label>
            <PasswordInput
              id="mny-wipe-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
            />
          </>
        )}
        {isOidc && (
          <p className="mt-4 text-sm text-muted-foreground">
            {t('mnyWipe.oidcNote')}
          </p>
        )}

        <div className="mt-6 flex justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={onCancel}
            disabled={isLoading}
          >
            {tc('cancel')}
          </Button>
          <Button
            type="submit"
            variant="danger"
            isLoading={isLoading}
            disabled={!canConfirm}
          >
            {t('mnyWipe.confirm')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
