"use client";

import { useTranslations } from "next-intl";
import { useNumberFormat } from "@/hooks/useNumberFormat";
import type { PlanNote } from "@/lib/email-import/build-plan";
import type {
  ImportProcessing,
  ImportRunStatus,
} from "@/lib/email-import/run-import";
import { PART_MAX_BYTES } from "@/lib/email-import/upload-plan";
import type { EmailReceiptImportResult } from "@/types/email-receipts";

interface Props {
  result: EmailReceiptImportResult;
  notes: readonly PlanNote[];
  processing: ImportProcessing;
  status: ImportRunStatus;
  /** Requests that succeeded, and how many the run had. */
  completed: number;
  total: number;
}

/** The merged per-file result of an import, and what the browser left out or did not finish. */
export function MailboxImportResultView({
  result,
  notes,
  processing,
  status,
  completed,
  total,
}: Props) {
  const t = useTranslations("emailReceipts.mailbox.import");
  const { formatNumber, formatBytes } = useNumberFormat();
  const count = (n: number) => formatNumber(n, 0);
  const oversized = notes.filter((note) => note.oversizedMessages > 0);

  return (
    <div role="status" className="space-y-2 text-sm">
      <h4 className="font-medium text-gray-900 dark:text-gray-100">
        {t("result.heading")}
      </h4>
      <ul className="space-y-1">
        {result.files.map((file, index) => (
          <li
            key={`${file.name}-${index}`}
            className={
              file.error
                ? "text-red-700 dark:text-red-400"
                : "text-gray-700 dark:text-gray-300"
            }
          >
            {file.error
              ? t(`result.errors.${file.error}`, { name: file.name })
              : t("result.file", {
                  name: file.name,
                  stored: count(file.stored),
                  duplicates: count(file.duplicates),
                  skipped: count(file.skipped),
                })}
            {file.ignoredEntries > 0 && (
              <span className="block text-gray-600 dark:text-gray-400">
                {t("result.ignored", {
                  name: file.name,
                  count: count(file.ignoredEntries),
                })}
              </span>
            )}
          </li>
        ))}
      </ul>
      {oversized.map((note) => (
        <p key={note.origin} className="text-amber-700 dark:text-amber-400">
          {t("result.oversized", {
            name: note.origin,
            count: count(note.oversizedMessages),
            max: formatBytes(PART_MAX_BYTES),
          })}
        </p>
      ))}
      {result.truncated > 0 && (
        <p className="text-amber-700 dark:text-amber-400">
          {t("result.truncated", { count: count(result.truncated) })}
        </p>
      )}
      {status === "failed" && completed === total ? (
        <p className="text-amber-700 dark:text-amber-400">
          {t("result.processingStopped")}
        </p>
      ) : (
        status !== "complete" && (
          <p className="text-amber-700 dark:text-amber-400">
            {t(status === "cancelled" ? "result.cancelled" : "result.stopped", {
              done: count(completed),
              total: count(total),
            })}
          </p>
        )
      )}
      <p className="text-gray-700 dark:text-gray-300">
        {t("result.summary", { processed: processing.processed })}
      </p>
      {processing.pendingLeft > 0 && (
        <p className="text-amber-700 dark:text-amber-400">
          {t("result.pendingLeft", { count: processing.pendingLeft })}
        </p>
      )}
      {processing.failed > 0 && (
        <p className="text-amber-700 dark:text-amber-400">
          {t("result.processFailed", { count: processing.failed })}
        </p>
      )}
    </div>
  );
}
