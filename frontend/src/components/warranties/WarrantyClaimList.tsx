'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { useTranslations } from 'next-intl';
import toast from 'react-hot-toast';
import { PlusIcon } from '@heroicons/react/24/outline';
import { Badge, type BadgeVariant } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { LinkifiedText } from '@/components/ui/LinkifiedText';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Modal } from '@/components/ui/Modal';
import { TABLE_BODY_CLASS } from '@/components/ui/Table';
import { UnsavedChangesDialog } from '@/components/ui/UnsavedChangesDialog';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useFormModal } from '@/hooks/useFormModal';
import { getErrorMessage } from '@/lib/errors';
import { createLogger } from '@/lib/logger';
import { warrantiesApi } from '@/lib/warranties';
import type { CreateWarrantyClaimData, WarrantyClaim, WarrantyClaimStatus } from '@/types/warranty';

const WarrantyClaimForm = dynamic(
  () => import('@/components/warranties/WarrantyClaimForm').then((m) => m.WarrantyClaimForm),
  { ssr: false },
);

const logger = createLogger('WarrantyClaimList');

const CLAIM_STATUS_VARIANT: Record<WarrantyClaimStatus, BadgeVariant> = {
  open: 'blue',
  approved: 'green',
  denied: 'red',
  resolved: 'gray',
};

interface WarrantyClaimListProps {
  warrantyId: string;
  /** The reader's own date (`Warranty.today`), which a new claim starts on. */
  today: string;
  /** Called after a claim is added, changed or deleted, so the page can refresh its counts. */
  onChanged?: () => void;
  /** List only: no Add, Edit or Delete (an acting delegate reads claims, never writes them). */
  readOnly?: boolean;
}

/**
 * The Claims section of a warranty's detail page (design decision 8): the
 * claims made against it, with Add, Edit and Delete. A claim never changes
 * the warranty's status. A list that failed to load says so and offers a
 * retry; it is never drawn as "no claims".
 */
export function WarrantyClaimList({ warrantyId, today, onChanged, readOnly = false }: WarrantyClaimListProps) {
  const t = useTranslations('warranties');
  const tc = useTranslations('common');
  const { formatDate } = useDateFormat();

  // The claims are held with the warranty they were read for, so a list
  // answering a warranty the page has left is never drawn under this one.
  const [loaded, setLoaded] = useState<{ warrantyId: string; claims: WarrantyClaim[] } | null>(null);
  const [failedFor, setFailedFor] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const latestRequest = useRef(0);

  useEffect(() => {
    const request = ++latestRequest.current;
    warrantiesApi
      .listClaims(warrantyId)
      .then((claims) => {
        if (latestRequest.current !== request) return;
        setLoaded({ warrantyId, claims });
        setFailedFor(null);
      })
      .catch((error) => {
        if (latestRequest.current !== request) return;
        logger.error(error);
        setFailedFor(warrantyId);
      });
  }, [warrantyId, reloadToken]);

  const reload = useCallback(() => setReloadToken((n) => n + 1), []);

  const {
    showForm,
    editingItem,
    openCreate,
    openEdit,
    close,
    isEditing,
    modalProps,
    setFormDirty,
    unsavedChangesDialog,
    formSubmitRef,
  } = useFormModal<WarrantyClaim>();
  const [deleteTarget, setDeleteTarget] = useState<WarrantyClaim | null>(null);

  const afterChange = () => {
    reload();
    onChanged?.();
  };

  const handleSubmit = async (data: CreateWarrantyClaimData) => {
    try {
      if (editingItem) {
        await warrantiesApi.updateClaim(warrantyId, editingItem.id, data);
        toast.success(t('claims.toasts.updated'));
      } else {
        await warrantiesApi.createClaim(warrantyId, data);
        toast.success(t('claims.toasts.created'));
      }
      close();
      afterChange();
    } catch (error) {
      // The form stays open with what was typed, so the reader can fix it.
      toast.error(getErrorMessage(error, editingItem ? t('claims.toasts.updateFailed') : t('claims.toasts.createFailed')));
    }
  };

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    try {
      await warrantiesApi.deleteClaim(warrantyId, deleteTarget.id);
      toast.success(t('claims.toasts.deleted'));
      afterChange();
    } catch (error) {
      toast.error(getErrorMessage(error, t('claims.toasts.deleteFailed')));
    } finally {
      setDeleteTarget(null);
    }
  };

  const claims = loaded !== null && loaded.warrantyId === warrantyId ? loaded.claims : null;
  const failed = failedFor === warrantyId;

  let body;
  if (failed) {
    body = (
      <div role="alert" className="py-4 text-center space-y-3">
        <p className="text-sm text-red-700 dark:text-red-300">{t('claims.loadFailed')}</p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setFailedFor(null);
            reload();
          }}
        >
          {t('claims.retry')}
        </Button>
      </div>
    );
  } else if (claims === null) {
    body = <LoadingSpinner text={t('claims.loading')} />;
  } else if (claims.length === 0) {
    body = <EmptyState title={t('claims.empty')} className="py-6" />;
  } else {
    body = (
      <ul className={TABLE_BODY_CLASS}>
        {claims.map((claim) => (
          <li key={claim.id} data-testid={`claim-${claim.id}`} className="py-3 first:pt-0 last:pb-0">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2 min-w-0">
                <Badge variant={CLAIM_STATUS_VARIANT[claim.status]}>{t(`claims.statuses.${claim.status}`)}</Badge>
                <span className="text-sm text-gray-700 dark:text-gray-300">
                  {t('claims.claimedOn', { date: formatDate(claim.claimDate) })}
                </span>
                {claim.resolvedOn !== null && (
                  <span className="text-sm text-gray-500 dark:text-gray-400">
                    {t('claims.resolvedOnLine', { date: formatDate(claim.resolvedOn) })}
                  </span>
                )}
              </div>
              {!readOnly && (
                <div className="flex items-center gap-1">
                  <Button variant="ghost" size="sm" onClick={() => openEdit(claim)}>
                    {tc('actions.edit')}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-red-600 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300"
                    onClick={() => setDeleteTarget(claim)}
                  >
                    {tc('actions.delete')}
                  </Button>
                </div>
              )}
            </div>
            {claim.description !== null && (
              <p className="mt-1 text-sm text-gray-900 dark:text-gray-100 whitespace-pre-wrap break-words">
                <LinkifiedText text={claim.description} />
              </p>
            )}
            {claim.resolution !== null && (
              <p className="mt-1 text-sm text-gray-600 dark:text-gray-400 whitespace-pre-wrap break-words">
                {t('claims.resolutionLine', { text: claim.resolution })}
              </p>
            )}
          </li>
        ))}
      </ul>
    );
  }

  return (
    <Card as="section" padding="md" aria-label={t('claims.title')}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{t('claims.title')}</h2>
        {!readOnly && (
          <Button variant="outline" size="sm" onClick={openCreate} className="gap-1">
            <PlusIcon className="h-4 w-4" aria-hidden="true" />
            {t('claims.add')}
          </Button>
        )}
      </div>
      {body}

      <Modal
        isOpen={showForm}
        onClose={close}
        {...modalProps}
        maxWidth="lg"
        padding="md"
        title={isEditing ? t('claims.modal.editTitle') : t('claims.modal.newTitle')}
      >
        <WarrantyClaimForm
          key={editingItem?.id ?? 'new'}
          claim={editingItem}
          today={today}
          onSubmit={handleSubmit}
          onCancel={close}
          onDirtyChange={setFormDirty}
          submitRef={formSubmitRef}
        />
      </Modal>
      <UnsavedChangesDialog {...unsavedChangesDialog} />

      <ConfirmDialog
        isOpen={deleteTarget !== null}
        title={t('claims.delete.title')}
        message={t('claims.delete.message', { date: deleteTarget ? formatDate(deleteTarget.claimDate) : '' })}
        confirmLabel={tc('actions.delete')}
        variant="danger"
        onConfirm={handleConfirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </Card>
  );
}
