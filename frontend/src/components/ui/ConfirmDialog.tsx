'use client';

import { useTranslations } from 'next-intl';
import {
  ExclamationCircleIcon,
  ExclamationTriangleIcon,
  InformationCircleIcon,
} from '@heroicons/react/24/outline';
import { Button } from './Button';
import { Modal } from './Modal';

interface ConfirmDialogProps {
  isOpen: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'danger' | 'warning' | 'info';
  onConfirm: () => void;
  onCancel: () => void;
  /** When true, integrates with browser history so the back button cancels. */
  pushHistory?: boolean;
}

export function ConfirmDialog({
  isOpen,
  title,
  message,
  confirmLabel,
  cancelLabel,
  variant = 'danger',
  onConfirm,
  onCancel,
  pushHistory = false,
}: ConfirmDialogProps) {
  const t = useTranslations('common');
  const resolvedConfirmLabel = confirmLabel ?? t('confirmDialog.confirm');
  const resolvedCancelLabel = cancelLabel ?? t('cancel');
  // A confirmation is its own dialog kind (screens-and-dialogs.md): a coloured
  // icon, a smaller title and the question as a paragraph, but its buttons are
  // the shared `Button` variants -- danger for a destructive confirm, primary
  // otherwise.
  const iconColors = {
    danger: 'text-red-600 dark:text-red-400 bg-red-100 dark:bg-red-900',
    warning: 'text-amber-600 dark:text-amber-400 bg-amber-100 dark:bg-amber-900',
    info: 'text-blue-600 dark:text-blue-400 bg-blue-100 dark:bg-blue-900',
  };
  const icons = {
    danger: ExclamationTriangleIcon,
    warning: ExclamationCircleIcon,
    info: InformationCircleIcon,
  };
  const Icon = icons[variant];

  return (
    <Modal
      isOpen={isOpen}
      onClose={onCancel}
      maxWidth="md"
      className="p-6"
      pushHistory={pushHistory}
    >
      <div className="flex items-start">
        <div
          className={`flex-shrink-0 flex items-center justify-center h-10 w-10 rounded-full ${iconColors[variant]}`}
        >
          <Icon className="h-6 w-6" aria-hidden="true" />
        </div>
        {/* min-w-0 lets the column shrink inside the flex row and break-words
            wraps an unbreakable word (a long file name) instead of widening
            the dialog into a horizontal scroll. */}
        <div className="ml-4 min-w-0 flex-1 break-words" data-testid="confirm-dialog-text">
          <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">{title}</h3>
          <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">{message}</p>
        </div>
      </div>
      <div className="mt-6 flex justify-end gap-3">
        <Button variant="outline" onClick={onCancel}>
          {resolvedCancelLabel}
        </Button>
        <Button variant={variant === 'danger' ? 'danger' : 'primary'} onClick={onConfirm}>
          {resolvedConfirmLabel}
        </Button>
      </div>
    </Modal>
  );
}
