"use client";

import { useId, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import toast from "react-hot-toast";
import { ChevronDownIcon } from "@heroicons/react/24/outline";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { useNumberFormat } from "@/hooks/useNumberFormat";
import { buildUploadPlan, type PlanNote } from "@/lib/email-import/build-plan";
import {
  runImport,
  withPlanNotes,
  type ImportRunOutcome,
} from "@/lib/email-import/run-import";
import {
  SELECTION_MAX_BYTES,
  selectionExceedsLimit,
} from "@/lib/email-import/upload-plan";
import { getErrorMessage } from "@/lib/errors";
import { MailboxImportResultView } from "./MailboxImportResultView";

type Phase = "idle" | "preparing" | "sending" | "processing";
type Outcome = Omit<ImportRunOutcome, "error"> & { notes: PlanNote[] };

/**
 * No `accept` list can be a gate: a file with no extension (the `mbox` file Apple
 * Mail writes) must stay selectable, and the server reads the content, not the name.
 */
const ACCEPT =
  ".eml,.mbox,.mbx,.zip,.msg,message/rfc822,application/mbox,application/zip,application/vnd.ms-outlook";

function Steps({ items }: { items: string[] }) {
  return (
    <ol className="list-decimal space-y-0.5 pl-5">
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ol>
  );
}

/**
 * Upload of exported `.eml`, `.mbox`, `.msg` and `.zip` files into the person's mailbox, the
 * per-file result, and a guide to exporting from the common providers. A large
 * `.mbox` or `.zip` is cut into parts in the browser and sent in several requests
 * (`lib/email-import`). Rendered
 * only when a mailbox exists: the server answers 404 without one.
 */
export function MailboxImportCard() {
  const t = useTranslations("emailReceipts.mailbox.import");
  const { formatNumber, formatBytes } = useNumberFormat();
  const inputRef = useRef<HTMLInputElement>(null);
  const guideId = useId();

  const [files, setFiles] = useState<File[]>([]);
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [processProgress, setProcessProgress] = useState({ done: 0, total: 0 });
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const isImporting = phase !== "idle";
  const [problem, setProblem] = useState<string | null>(null);
  const [guideOpen, setGuideOpen] = useState(false);

  const count = (n: number) => formatNumber(n, 0);

  const handleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(event.target.files ?? []);
    setOutcome(null);
    if (selectionExceedsLimit(picked)) {
      setFiles([]);
      setProblem(t("tooLargeTotal", { max: formatBytes(SELECTION_MAX_BYTES) }));
      event.target.value = "";
      return;
    }
    setProblem(null);
    setFiles(picked);
  };

  const handleImport = async () => {
    if (files.length === 0) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase("preparing");
    setOutcome(null);
    setProblem(null);
    try {
      const plan = await buildUploadPlan(files);
      setProgress({ done: 0, total: plan.requests.length });
      setPhase("sending");
      setProcessProgress({ done: 0, total: 0 });
      const run = await runImport(plan.requests, {
        signal: controller.signal,
        onProgress: (done, total) => {
          setProgress({ done, total });
          if (done === total && total > 0) setPhase("processing");
        },
        onProcessProgress: (done, total) => setProcessProgress({ done, total }),
      });
      const { error, ...rest } = run;
      if (run.status === "failed") {
        const message = getErrorMessage(error, t("failed"));
        setProblem(message);
        toast.error(message);
      } else {
        setFiles([]);
        if (inputRef.current) inputRef.current.value = "";
      }
      if (run.status !== "failed" || run.completed > 0) {
        setOutcome({
          ...rest,
          result: withPlanNotes(run.result, plan.notes),
          notes: plan.notes,
        });
      }
    } catch (error) {
      const message = getErrorMessage(error, t("failed"));
      setProblem(message);
      toast.error(message);
    } finally {
      abortRef.current = null;
      setPhase("idle");
    }
  };

  return (
    <Card padding="md" as="section" aria-labelledby={`${guideId}-title`}>
      <div className="space-y-4">
        <div>
          <h3
            id={`${guideId}-title`}
            className="text-base font-semibold text-gray-900 dark:text-gray-100"
          >
            {t("title")}
          </h3>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
            {t("description")}
          </p>
        </div>

        <div className="space-y-2">
          <label
            htmlFor={`${guideId}-file`}
            className="block text-sm font-medium text-gray-700 dark:text-gray-300"
          >
            {t("fileLabel")}
          </label>
          {/* The native control's button and "no file" text are the browser's,
              in the browser's language: it is hidden and labelled here instead. */}
          <input
            id={`${guideId}-file`}
            ref={inputRef}
            type="file"
            multiple
            accept={ACCEPT}
            onChange={handleChange}
            disabled={isImporting}
            className="sr-only"
          />
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              variant="secondary"
              disabled={isImporting}
              onClick={() => inputRef.current?.click()}
            >
              {t("chooseFiles")}
            </Button>
            <span className="text-sm text-gray-600 dark:text-gray-400">
              {files.length > 0
                ? t("selected", { count: count(files.length) })
                : t("noFileChosen")}
            </span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="primary"
            isLoading={isImporting}
            disabled={files.length === 0}
            onClick={() => void handleImport()}
          >
            {t("button")}
          </Button>
          {(phase === "sending" || phase === "processing") && (
            <Button
              type="button"
              variant="secondary"
              onClick={() => abortRef.current?.abort()}
            >
              {t("cancel")}
            </Button>
          )}
        </div>

        {phase !== "idle" && (
          <p role="status" className="text-sm text-gray-600 dark:text-gray-400">
            {phase === "preparing"
              ? t("preparing")
              : phase === "processing"
                ? t("processing", {
                    done: count(processProgress.done),
                    total: count(processProgress.total),
                  })
                : t("sending", {
                    current: count(Math.min(progress.done + 1, progress.total)),
                    total: count(progress.total),
                  })}
          </p>
        )}

        {problem && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {problem}
          </p>
        )}

        {outcome && (
          <MailboxImportResultView
            result={outcome.result}
            notes={outcome.notes}
            processing={outcome.processing}
            status={outcome.status}
            completed={outcome.completed}
            total={outcome.total}
          />
        )}

        <div className="border-t border-gray-200 pt-3 dark:border-gray-700">
          <button
            type="button"
            aria-expanded={guideOpen}
            aria-controls={`${guideId}-guide`}
            onClick={() => setGuideOpen((open) => !open)}
            className="flex items-center gap-1 text-sm font-medium text-blue-700 hover:underline focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-blue-400"
          >
            <ChevronDownIcon
              aria-hidden="true"
              className={`h-4 w-4 transition-transform motion-reduce:transition-none ${guideOpen ? "rotate-180" : ""}`}
            />
            {t("guide.toggle")}
          </button>
          {guideOpen && (
            <div
              id={`${guideId}-guide`}
              className="mt-3 space-y-4 text-sm text-gray-700 dark:text-gray-300"
            >
              <section>
                <h4 className="font-medium text-gray-900 dark:text-gray-100">
                  {t("guide.gmailLabel.title")}
                </h4>
                <Steps
                  items={(["step1", "step2", "step3", "step4"] as const).map(
                    (k) => t(`guide.gmailLabel.${k}`),
                  )}
                />
              </section>
              <section>
                <h4 className="font-medium text-gray-900 dark:text-gray-100">
                  {t("guide.gmailOne.title")}
                </h4>
                <Steps
                  items={(["step1", "step2", "step3"] as const).map((k) =>
                    t(`guide.gmailOne.${k}`),
                  )}
                />
              </section>
              <section>
                <h4 className="font-medium text-gray-900 dark:text-gray-100">
                  {t("guide.imap.title")}
                </h4>
                <Steps
                  items={(["step1", "step2", "step3", "step4"] as const).map(
                    (k) => t(`guide.imap.${k}`),
                  )}
                />
              </section>
              <section>
                <h4 className="font-medium text-gray-900 dark:text-gray-100">
                  {t("guide.outlook.title")}
                </h4>
                <p>{t("guide.outlook.body")}</p>
              </section>
              <section>
                <h4 className="font-medium text-gray-900 dark:text-gray-100">
                  {t("guide.apple.title")}
                </h4>
                <Steps
                  items={(["step1", "step2"] as const).map((k) =>
                    t(`guide.apple.${k}`),
                  )}
                />
              </section>
              <p className="text-gray-600 dark:text-gray-400">
                {t("guide.tip")}
              </p>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}
