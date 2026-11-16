'use client';

import { useId, useRef, useState, type ChangeEvent } from 'react';
import { useTranslations } from 'next-intl';
import toast from 'react-hot-toast';
import { IMPORT_PREVIEW_CHECKBOX_CLASS } from '@/components/import-preview/ImportPreviewCheckbox';
import { Badge, type BadgeVariant } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { TABLE_BODY_CLASS, TABLE_CLASS, Td, Th } from '@/components/ui/Table';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { getErrorMessage } from '@/lib/errors';
import { warrantiesApi } from '@/lib/warranties';
import type { WarrantyImportOutcome, WarrantyImportResult, WarrantyImportRow } from '@/types/warranty';

const ACCEPT = '.csv,text/csv';

const OUTCOME_VARIANT: Record<WarrantyImportOutcome, BadgeVariant> = {
  valid: 'green',
  invalid: 'red',
  created: 'blue',
};

/** A preview belongs to the file it read, so a commit sends exactly that file. */
interface Preview {
  file: File;
  result: WarrantyImportResult;
}

interface WarrantyImportDialogProps {
  isOpen: boolean;
  onClose: () => void;
  /** After a commit the server answered; the page reloads its list and summary. */
  onImported: (result: WarrantyImportResult) => void;
}

/**
 * Import warranties from a Warracker-format CSV (design decision 12): choosing
 * a file previews it (`dryRun`), the table shows what each row would become,
 * and Import commits the same file through the same server code path.
 */
export function WarrantyImportDialog({ isOpen, onClose, onImported }: WarrantyImportDialogProps) {
  const t = useTranslations('warranties');
  const tc = useTranslations('common');
  const { formatNumber } = useNumberFormat();
  const { formatDate } = useDateFormat();
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const latestRequest = useRef(0);

  const [fileName, setFileName] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [skipInvalid, setSkipInvalid] = useState(false);

  const reset = () => {
    // An answer still in flight belongs to a dialog that has gone.
    latestRequest.current += 1;
    setFileName(null);
    setPreview(null);
    setPreviewError(null);
    setPreviewing(false);
    setSkipInvalid(false);
  };

  const handleClose = () => {
    if (committing) return;
    reset();
    onClose();
  };

  const handleFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const chosen = event.target.files?.[0] ?? null;
    // Cleared so choosing the same file again (after fixing it) previews again.
    event.target.value = '';
    if (chosen === null) return;
    const request = ++latestRequest.current;
    setFileName(chosen.name);
    setPreview(null);
    setPreviewError(null);
    setSkipInvalid(false);
    setPreviewing(true);
    try {
      const result = await warrantiesApi.import(chosen, { dryRun: true });
      if (latestRequest.current !== request) return;
      setPreview({ file: chosen, result });
    } catch (error) {
      if (latestRequest.current !== request) return;
      setPreviewError(getErrorMessage(error, t('import.previewFailed')));
    } finally {
      if (latestRequest.current === request) setPreviewing(false);
    }
  };

  const rows = preview?.result.rows ?? [];
  const invalidCount = rows.filter((row) => row.outcome === 'invalid').length;
  const validCount = rows.length - invalidCount;
  const canImport =
    preview !== null && !previewing && validCount > 0 && (invalidCount === 0 || skipInvalid);

  const handleImport = async () => {
    if (preview === null || !canImport) return;
    setCommitting(true);
    try {
      const result = await warrantiesApi.import(preview.file, {
        dryRun: false,
        skipInvalid: invalidCount > 0,
      });
      toast.success(
        t('import.toasts.imported', { count: result.created, shown: formatNumber(result.created, 0) }),
      );
      reset();
      onImported(result);
    } catch (error) {
      toast.error(getErrorMessage(error, t('import.toasts.failed')));
    } finally {
      setCommitting(false);
    }
  };

  const expiryText = (row: WarrantyImportRow) => {
    if (row.warranty?.isLifetime === true) return t('import.lifetime');
    return row.expiresOn === null ? t('import.noExpiry') : formatDate(row.expiresOn);
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={committing ? undefined : handleClose}
      title={t('import.title')}
      description={t('import.description')}
      maxWidth="3xl"
      padding="md"
      footer={
        <>
          <Button variant="outline" disabled={committing} onClick={handleClose}>
            {tc('cancel')}
          </Button>
          <Button
            variant="primary"
            isLoading={committing}
            disabled={!canImport}
            onClick={() => void handleImport()}
          >
            {canImport
              ? t('import.submitCount', { count: validCount, shown: formatNumber(validCount, 0) })
              : t('import.submit')}
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-sm text-gray-700 dark:text-gray-300">
        <div className="space-y-2">
          <label htmlFor={inputId} className="block font-medium text-gray-700 dark:text-gray-300">
            {t('import.fileLabel')}
          </label>
          {/* The native control's button and "no file" text are the browser's,
              in the browser's language: it is hidden and labelled here instead. */}
          <input
            id={inputId}
            ref={inputRef}
            type="file"
            accept={ACCEPT}
            onChange={(event) => void handleFileChange(event)}
            disabled={committing}
            className="sr-only"
          />
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              variant="secondary"
              disabled={committing}
              onClick={() => inputRef.current?.click()}
            >
              {t('import.chooseFile')}
            </Button>
            <span className="text-gray-600 dark:text-gray-400">{fileName ?? t('import.noFileChosen')}</span>
          </div>
        </div>

        {previewing && (
          <p role="status" className="text-gray-600 dark:text-gray-400">
            {t('import.checking')}
          </p>
        )}

        {previewError !== null && (
          <p role="alert" className="text-red-700 dark:text-red-300">
            {previewError}
          </p>
        )}

        {preview !== null && (
          <div className="space-y-3">
            <p role="status">
              {t('import.summary', {
                count: rows.length,
                valid: formatNumber(validCount, 0),
                total: formatNumber(rows.length, 0),
              })}
            </p>

            {preview.result.skippedColumns.length > 0 && (
              <div className="flex flex-wrap items-center gap-2">
                <span>{t('import.skippedColumns')}</span>
                {preview.result.skippedColumns.map((column) => (
                  <code
                    key={column}
                    className="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-800 dark:bg-gray-700 dark:text-gray-200"
                  >
                    {column}
                  </code>
                ))}
              </div>
            )}

            {invalidCount > 0 && (
              <div className="space-y-2">
                <p className="text-red-700 dark:text-red-300">
                  {t('import.invalidSummary', { count: invalidCount, shown: formatNumber(invalidCount, 0) })}
                </p>
                {validCount > 0 ? (
                  <label className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      checked={skipInvalid}
                      onChange={(event) => setSkipInvalid(event.target.checked)}
                      disabled={committing}
                      className={`mt-0.5 ${IMPORT_PREVIEW_CHECKBOX_CLASS}`}
                    />
                    <span>{t('import.skipInvalid')}</span>
                  </label>
                ) : (
                  <p>{t('import.nothingToImport')}</p>
                )}
              </div>
            )}

            <div className="max-h-80 overflow-auto rounded border border-gray-200 dark:border-gray-700">
              <table className={TABLE_CLASS}>
                <thead className="bg-gray-50 dark:bg-gray-800">
                  <tr>
                    <Th align="right">{t('import.columns.line')}</Th>
                    <Th>{t('import.columns.name')}</Th>
                    <Th>{t('import.columns.expires')}</Th>
                    <Th>{t('import.columns.outcome')}</Th>
                    <Th>{t('import.columns.problems')}</Th>
                  </tr>
                </thead>
                <tbody className={TABLE_BODY_CLASS}>
                  {rows.map((row) => (
                    <tr key={row.line}>
                      <Td align="right" className="tabular-nums">
                        {formatNumber(row.line, 0)}
                      </Td>
                      <Td>{row.name ?? t('import.unnamed')}</Td>
                      <Td className="whitespace-nowrap">{expiryText(row)}</Td>
                      <Td>
                        <Badge variant={OUTCOME_VARIANT[row.outcome]}>{t(`import.outcome.${row.outcome}`)}</Badge>
                      </Td>
                      <Td>
                        {row.errors.length + row.warnings.length > 0 && (
                          <ul className="space-y-1">
                            {row.errors.map((message, i) => (
                              <li key={`e${i}`} className="text-red-700 dark:text-red-300">
                                {t('import.errorItem', { message })}
                              </li>
                            ))}
                            {row.warnings.map((message, i) => (
                              <li key={`w${i}`} className="text-amber-700 dark:text-amber-300">
                                {t('import.warningItem', { message })}
                              </li>
                            ))}
                          </ul>
                        )}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
