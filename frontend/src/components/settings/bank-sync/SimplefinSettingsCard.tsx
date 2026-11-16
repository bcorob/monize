"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { LoadingSpinner } from "@/components/ui/LoadingSpinner";
import { useNumberFormat } from "@/hooks/useNumberFormat";
import { useDateFormat } from "@/hooks/useDateFormat";
import { simplefinApi } from "@/lib/simplefin";
import { getErrorMessage } from "@/lib/errors";
import type { SimplefinStatus, SimplefinDiscovery } from "@/types/simplefin";
import { BankSyncExternalLink } from "./BankSyncExternalLink";

type Status =
  | { state: "loading" }
  | { state: "failed"; data?: SimplefinStatus }
  | { state: "ready"; data: SimplefinStatus };

export function SimplefinSettingsCard({
  disabled = false,
  onChanged,
}: {
  disabled?: boolean;
  onChanged: () => Promise<void> | void;
}) {
  const t = useTranslations("settings.bankSync.simplefin");
  const loadFailed = useTranslations("settings.bankSync.loadFailed");
  const common = useTranslations("common");
  const { formatNumber } = useNumberFormat();
  const { formatDateTime } = useDateFormat();
  const [status, setStatus] = useState<Status>({ state: "loading" });
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [discovery, setDiscovery] = useState<SimplefinDiscovery | null>(null);
  const [confirm, setConfirm] = useState<"replace" | "remove" | null>(null);
  const pendingToken = useRef("");
  const inFlight = useRef(false);
  const active = useRef(true);
  const statusRequest = useRef(0);

  const refreshStatus = useCallback(() => {
    const request = ++statusRequest.current;
    return simplefinApi
      .getStatus()
      .then((data) => {
        if (active.current && request === statusRequest.current)
          setStatus({ state: "ready", data });
      })
      .catch(() => {
        if (active.current && request === statusRequest.current)
          setStatus((previous) => ({
            state: "failed",
            data: "data" in previous ? previous.data : undefined,
          }));
      });
  }, []);

  useEffect(() => {
    active.current = true;
    void refreshStatus();
    const timer = window.setInterval(() => void refreshStatus(), 30_000);
    return () => {
      window.clearInterval(timer);
      active.current = false;
      pendingToken.current = "";
    };
  }, [refreshStatus]);

  const run = async (operation: () => Promise<SimplefinDiscovery | null>) => {
    if (inFlight.current || disabled) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    setDiscovery(null);
    try {
      const result = await operation();
      if (active.current) setDiscovery(result);
    } catch (failure) {
      if (active.current) setError(getErrorMessage(failure, t("failed")));
    } finally {
      await refreshStatus();
      try {
        await onChanged();
      } catch (failure) {
        if (active.current) setError(getErrorMessage(failure, t("failed")));
      } finally {
        inFlight.current = false;
        if (active.current) setBusy(false);
      }
    }
  };

  const connect = (value: string, replace: boolean) =>
    run(async () => {
      const result = await simplefinApi.connect(value, replace);
      return result.discovery;
    });
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (
      inFlight.current ||
      disabled ||
      !token.trim() ||
      status.state !== "ready"
    )
      return;
    const value = token.trim();
    setToken("");
    if (status.data.credentialSet) {
      pendingToken.current = value;
      setConfirm("replace");
    } else void connect(value, false);
  };
  const confirmAction = () => {
    const action = confirm;
    setConfirm(null);
    if (action === "replace") {
      const value = pendingToken.current;
      pendingToken.current = "";
      if (value) void connect(value, true);
    } else if (action === "remove") {
      void run(async () => {
        await simplefinApi.remove();
        return null;
      });
    }
  };
  const configured = "data" in status && !!status.data?.credentialSet;
  const allowed = status.state === "ready" && status.data.encryptionAvailable;
  const quota = status.state === "ready" ? status.data.quota : null;

  return (
    <Card padding="md" className="mb-6">
      <h2 className="text-lg font-semibold">{t("title")}</h2>
      <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">
        {t.rich("description", {
          bridge: (chunks) => (
            <BankSyncExternalLink href="https://bridge.simplefin.org/simplefin/create">
              {chunks}
            </BankSyncExternalLink>
          ),
        })}
      </p>
      {status.state === "loading" && <LoadingSpinner />}
      {status.state === "failed" && (
        <div role="alert" className="mt-3">
          <p>{t("loadFailed")}</p>
          <Button
            type="button"
            variant="outline"
            onClick={() => void refreshStatus()}
          >
            {loadFailed("retry")}
          </Button>
        </div>
      )}
      {configured && (
        <p role="status" className="mt-3 text-sm">
          {t(status.state === "failed" ? "lastKnownConnected" : "connected")}
        </p>
      )}
      {status.state === "ready" && !allowed && (
        <p role="alert">{t("encryptionRequired")}</p>
      )}
      <form onSubmit={submit} className="mt-4 space-y-3">
        <Input
          id="simplefin-setup-token"
          label={t("setupToken")}
          type="password"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          maxLength={16384}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          disabled={disabled || busy || !allowed}
        />
        <div className="flex flex-wrap gap-2">
          <Button
            type="submit"
            disabled={disabled || busy || !allowed || !token.trim()}
          >
            {busy ? common("loading") : t("connect")}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={
              disabled ||
              busy ||
              !configured ||
              status.state !== "ready" ||
              quota?.remaining === 0
            }
            onClick={() => void run(() => simplefinApi.discover())}
          >
            {t("refresh")}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={
              disabled || busy || !configured || status.state !== "ready"
            }
            onClick={() => setConfirm("remove")}
          >
            {t("remove")}
          </Button>
        </div>
      </form>
      {quota && (
        <p className="mt-3 text-sm">
          {t("quota", { remaining: formatNumber(quota.remaining, 0) })}
        </p>
      )}
      {quota?.nextEligibleAt && (
        <p className="text-sm">
          {t("nextEligible", { date: formatDateTime(quota.nextEligibleAt) })}
        </p>
      )}
      {error && (
        <div
          role="alert"
          className="mt-3 text-sm text-red-600 dark:text-red-400"
        >
          <p>{t("failed")}</p>
          <p>{error}</p>
        </div>
      )}
      {discovery && !discovery.ok && (
        <div
          role="alert"
          className="mt-3 text-sm text-amber-700 dark:text-amber-300"
        >
          <p>{t("savedDiscoveryFailed")}</p>
          <ul className="list-disc pl-5">
            {discovery.errors.map((code) => (
              <li key={code}>{t(`errors.${code}`)}</li>
            ))}
          </ul>
        </div>
      )}
      <ConfirmDialog
        isOpen={confirm !== null}
        title={t(confirm === "replace" ? "replaceTitle" : "removeTitle")}
        message={t(confirm === "replace" ? "replaceBody" : "removeBody")}
        confirmLabel={confirm === "replace" ? t("connect") : t("remove")}
        pushHistory
        onConfirm={confirmAction}
        onCancel={() => {
          pendingToken.current = "";
          setConfirm(null);
        }}
      />
    </Card>
  );
}
