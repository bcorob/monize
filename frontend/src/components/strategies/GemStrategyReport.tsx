"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import toast from "react-hot-toast";
import { useReportData } from "@/hooks/useReportData";
import { ReportError } from "@/components/reports/ReportError";
import { UnsavedChangesDialog } from "@/components/ui/UnsavedChangesDialog";
import { Skeleton } from "@/components/ui/LoadingSkeleton";
import { createLogger } from "@/lib/logger";
import { gemStrategyApi } from "@/lib/gem-strategy";
import {
  GemAssetRole,
  GemRange,
  GemStrategyReport as GemStrategyReportData,
} from "@/types/gem-strategy";
import { GEM_DEFAULT_RANGE, warningCodes } from "@/lib/gem-strategy-view";
import { tabId, tabPanelId } from "@/components/ui/Tabs";
import { TOUR_ANCHORS, tourAnchor } from "@/lib/tours/anchors";
import { GemStrategyHeader } from "./GemStrategyHeader";
import {
  GEM_TABS_ID_PREFIX,
  GemStrategyTabs,
  GemTab,
} from "./GemStrategyTabs";
import { GemWarningsBanner } from "./GemWarningsBanner";
import { GemSignalCard } from "./GemSignalCard";
import { GemPortfolioCard } from "./GemPortfolioCard";
import { GemTransferCard } from "./GemTransferCard";
import { GemAssetsCard } from "./GemAssetsCard";
import { GemPerformanceChart } from "./GemPerformanceChart";
import { GemNextActionCard } from "./GemNextActionCard";
import { GemAllocationCard } from "./GemAllocationCard";
import { GemReasoningSection } from "./GemReasoningSection";
import { GemSignalHistoryTable } from "./GemSignalHistoryTable";
import { GemPortfolioPanel } from "./GemPortfolioPanel";
import { GemBacktestPanel } from "./GemBacktestPanel";
import { GemSettingsForm } from "./GemSettingsForm";
import { GemStrategyFooter } from "./GemStrategyFooter";

const logger = createLogger("GemStrategyReport");

/** Rows of signal history shown on the overview before "see full history". */
const OVERVIEW_HISTORY_ROWS = 5;

function GemReportSkeleton() {
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((index) => (
          <Skeleton key={index} className="h-36 w-full" />
        ))}
      </div>
      <div className="grid gap-4 xl:grid-cols-[minmax(0,7fr)_minmax(0,3fr)]">
        <Skeleton className="h-80 w-full" />
        <Skeleton className="h-80 w-full" />
      </div>
      <Skeleton className="h-48 w-full" />
    </div>
  );
}

/**
 * The GEM strategy report. Answers, in reading order: what the current signal is,
 * why the strategy picked that instrument, whether the real portfolio matches it,
 * and which single operation to carry out -- all from one server-side read model,
 * with the strategy itself evaluated server-side.
 */
export function GemStrategyReport() {
  const t = useTranslations("strategies");
  const router = useRouter();
  const [range, setRange] = useState<GemRange>(GEM_DEFAULT_RANGE);
  const [tab, setTab] = useState<GemTab>("overview");
  /**
   * How many mutations are in flight, rather than whether one is.
   *
   * These nest. "Save and carry on" runs the deferred scenario create or
   * delete from inside the settings save's own `onSaved`, so the create sets
   * the flag and the settings form's `finally` -- which runs immediately
   * afterwards -- cleared it again while the create was still waiting on the
   * server. The page went live over a mutation nobody had finished: a second
   * create could be started, or a late response adopted under a newer
   * selection. A boolean cannot express two owners, and whichever finishes
   * first speaks for both.
   */
  const [pendingMutations, setPendingMutations] = useState(0);
  const isSaving = pendingMutations > 0;
  const beginMutation = useCallback(
    () => setPendingMutations((count) => count + 1),
    [],
  );
  const endMutation = useCallback(
    () => setPendingMutations((count) => Math.max(0, count - 1)),
    [],
  );
  // The scenario on screen. Undefined means "whichever the server picks", which
  // is the user's first -- and the only one until they create a second.
  const [strategyId, setStrategyId] = useState<string | undefined>(undefined);

  /**
   * What the report on screen is a report *of*: the scenario and the chart
   * range together. Everything the page can act on is scoped to this pair, so
   * it is the identity a response has to match before it may be adopted or
   * acted upon.
   */
  const requestKey = `${range}|${strategyId ?? ""}`;

  const {
    data,
    dataKey,
    askedKey,
    isLoading,
    error,
    reload,
    setData: setReport,
    adoptAs,
  } = useReportData<GemStrategyReportData>(
    () => gemStrategyApi.getReport(range, strategyId),
    [range, strategyId],
    {
      requestKey,
      // The report is a report of whichever scenario came back, which is not
      // always the one asked for: a scenario deleted in another tab makes the
      // server fall back to the user's default rather than answer with an
      // unconfigured page. Keyed by the request, the page then held A's report
      // under B's selection and every action it offered was aimed at the pair
      // -- `markExecuted` sent A's signal id with `strategyId=B`, which the
      // server refuses, and nothing on screen could get back to a good state.
      keyForResult: (report) =>
        report.strategy.id ? `${range}|${report.strategy.id}` : null,
    },
  );

  /**
   * Move the selection onto the scenario the report actually describes.
   *
   * During render rather than in an effect, per the project's
   * `react-hooks/set-state-in-effect` rule: this is state derived from what
   * has just been loaded, and React re-renders before committing, so the pair
   * is never painted disagreeing. Idempotent -- once the two agree the branch
   * stops firing -- and it cannot fight a load in flight, because `dataKey` is
   * only stamped when one commits.
   *
   * It also settles the ordinary first load, where the selection starts unset
   * and the server picks. Leaving it unset there was what let the page build
   * mutation keys out of two different namespaces.
   */
  if (
    data?.strategy.id &&
    data.strategy.id !== strategyId &&
    dataKey === `${range}|${data.strategy.id}` &&
    // Only reconcile with an answer to the question currently being asked.
    //
    // Without this the branch could not tell a fallback from a selection the
    // user had just made: picking scenario B leaves B selected with A's report
    // still on screen, which reads exactly like "the server gave me A", so the
    // selection was set straight back to A -- during the same render, before
    // the effect that would have fetched B ever ran. The caret opened, the
    // scenario was picked, and nothing happened, every time.
    askedKey === requestKey
  ) {
    setStrategyId(data.strategy.id);
  }

  /**
   * True while what is rendered does not describe the current selection.
   *
   * The hook keeps the previous report visible during a load, which is the
   * right thing to look at and the wrong thing to act on: between selecting
   * scenario B and its report arriving, the page still shows A -- A's signal
   * id on the button, A's settings in the form. Every mutation is disabled
   * until the two agree again, so an action can only ever be aimed at the
   * report the user is actually reading.
   */
  const isStaleSelection = isLoading || dataKey !== requestKey;

  /**
   * Every mutation here answers with the refreshed report, so the response is
   * adopted rather than triggering a second read of the same thing -- but only
   * when the selection it was produced for is still the one on screen. A
   * settings save for scenario A that lands after the user moved to B would
   * otherwise retire B's fetch and put A back under B's selection.
   */
  const adopt = useCallback(
    (report: GemStrategyReportData, producedFor: string = requestKey) =>
      setReport(report, producedFor),
    [setReport, requestKey],
  );

  /**
   * A mutation that changed *which* scenario is on screen -- creating one,
   * deleting one -- also moves the page to whichever the server decided on.
   * That re-runs the loader, which is the point: the id has to stick, or the
   * next range change would fall back to the user's first scenario.
   */
  const adoptScenario = useCallback(
    (report: GemStrategyReportData) => {
      // Keyed to the scenario the response *is*, not to the one that was
      // selected a moment ago. Adopting it unkeyed stamped it with the
      // previous render's key, so the very next render found `dataKey` behind
      // `requestKey`, called a complete and correct report stale, and fetched
      // it again -- and if that superfluous request failed, a successful
      // create or delete was replaced by an error screen.
      setStrategyId(report.strategy.id ?? undefined);
      adoptAs(report, `${range}|${report.strategy.id ?? ""}`);
    },
    [adoptAs, range],
  );

  const codes = useMemo(() => warningCodes(data?.warnings), [data?.warnings]);
  const winnerRole = useMemo<GemAssetRole | null>(
    () => data?.signal?.target?.role ?? null,
    [data?.signal],
  );
  const symbolByRole = useMemo(
    () =>
      new Map((data?.assets ?? []).map((asset) => [asset.role, asset.symbol])),
    [data?.assets],
  );

  const handleMarkExecuted = useCallback(async () => {
    const signalId = data?.signal?.id;
    // Never act on a report that is not the current selection's: the id on
    // screen may belong to the scenario the user has just left.
    if (!signalId || isStaleSelection) return;
    const producedFor = requestKey;
    beginMutation();
    try {
      adopt(
        await gemStrategyApi.markExecuted(signalId, range, strategyId),
        producedFor,
      );
      toast.success(t("gem.action.markExecutedSuccess"));
    } catch (err) {
      logger.error("Failed to mark the GEM operation as executed:", err);
      toast.error(t("gem.action.markExecutedError"));
    } finally {
      endMutation();
    }
  }, [
    adopt,
    beginMutation,
    data?.signal?.id,
    endMutation,
    isStaleSelection,
    range,
    requestKey,
    strategyId,
    t,
  ]);

  const handleAddTransactions = useCallback(() => {
    router.push("/investments");
  }, [router]);

  /**
   * Both scenario mutations report success to the switcher rather than
   * swallowing it.
   *
   * The switcher closed its modal after awaiting these, and because the errors
   * are caught here the child saw a resolved promise either way -- so a
   * rejected create closed the dialog and threw away the name the user had just
   * typed. Returning a boolean keeps the failure visible to the one component
   * that can act on it, without a second toast.
   */
  const handleCreateScenario = useCallback(
    async (name: string) => {
      beginMutation();
      try {
        const report = await gemStrategyApi.createStrategy(name, range);
        adoptScenario(report);
        setTab("settings");
        toast.success(
          t("gem.scenarios.created", { name: report.strategy.name }),
        );
        return "done" as const;
      } catch (err) {
        logger.error("Failed to create a GEM scenario:", err);
        toast.error(t("gem.scenarios.createError"));
        return "failed" as const;
      } finally {
        endMutation();
      }
    },
    [adoptScenario, beginMutation, endMutation, range, t],
  );

  const handleDeleteScenario = useCallback(
    async (id: string) => {
      beginMutation();
      try {
        adoptScenario(await gemStrategyApi.deleteStrategy(id, range));
        setTab("overview");
        toast.success(t("gem.scenarios.deleted"));
        return "done" as const;
      } catch (err) {
        logger.error("Failed to delete a GEM scenario:", err);
        toast.error(t("gem.scenarios.deleteError"));
        return "failed" as const;
      } finally {
        endMutation();
      }
    },
    [adoptScenario, beginMutation, endMutation, range, t],
  );

  /**
   * The selection a settings save was started under.
   *
   * A save is a slow round trip and the user can change scenario or range
   * while it runs. Recording the key when the form begins lets the response be
   * matched against it: for the selection it belongs to it is adopted, and for
   * any other it is dropped and the newer fetch stands.
   */
  /**
   * Unsaved settings edits, and the navigation waiting on them.
   *
   * Every control that changes tab, scenario or deletes the scenario unmounts
   * the settings form, and remounting it under a new key does not bring the
   * edits back. The form reports its dirty state up; those controls run
   * through `guarded`, which holds the action until the user has said what to
   * do with the edits.
   */
  const [settingsDirty, setSettingsDirty] = useState(false);
  const [pendingNavigation, setPendingNavigation] = useState<
    (() => void) | null
  >(null);
  /**
   * Bumped when the user discards, and part of the settings form's `key`, so
   * discarding remounts it and its defaults are read again.
   *
   * "Discard" has to discard something. Clearing `settingsDirty` alone disarmed
   * the guard and left the edits in the form: the staged action can be a no-op
   * -- the header's "Edit settings" while already on the Settings tab is one --
   * so the form was neither unmounted nor reset, react-hook-form's `isDirty`
   * stayed true, and `useFormDirtyNotify` had no transition left to report. The
   * next tab or scenario switch then unmounted a genuinely dirty form with no
   * prompt at all: precisely the silent data loss the guard exists to prevent,
   * reached through the button that claims to have handled it.
   */
  const [settingsResetNonce, setSettingsResetNonce] = useState(0);
  const submitSettings = useRef<(() => void) | null>(null);
  /**
   * The navigation "Save" is saving *for*.
   *
   * The dialog offers three answers and one of them is "save and carry on".
   * Dropping the navigation at submit time turned it into "save and stay",
   * so the tab or scenario the user had already asked for never arrived and
   * they had to ask again. It is held until the save resolves rather than run
   * beside it: a server that refuses the configuration leaves the edits on
   * screen, and navigating away from them would discard exactly what the
   * dialog was protecting.
   */
  const navigateAfterSave = useRef<(() => void) | null>(null);

  /**
   * The dialog's "Save" was answered by a form that refused to submit.
   *
   * Nothing went to the server, so nothing is coming back to run the action
   * the dialog staged -- and leaving it armed is not merely useless, it is
   * dangerous: `pendingNavigation` can be a scenario *deletion*, and it would
   * have fired on whatever the user's next successful save happened to be,
   * long after they had stopped asking for it.
   *
   * The edits and their validation errors stay exactly where they are. Only
   * the staged action is dropped, because the user has to answer the dialog
   * again once the form is valid.
   */
  const handleInvalidSettingsSubmit = useCallback(() => {
    navigateAfterSave.current = null;
  }, []);

  const guarded = useCallback(
    (action: () => void) => () => {
      if (!settingsDirty) {
        action();
        return;
      }
      // Stored as a thunk, so the state setter does not call it.
      setPendingNavigation(() => action);
    },
    [settingsDirty],
  );

  const savingForKey = useRef<string | null>(null);
  const savingForStrategy = useRef<string | null>(null);
  const handleSettingsSaving = useCallback(
    (saving: boolean) => {
      // The key the report on screen was *loaded under*, straight from the
      // hook -- not one rebuilt here out of the report's contents.
      //
      // Both name the report the form is rendering, which is the thing this
      // has to be taken from, but only one of them is in the namespace the
      // hook compares against. `requestKey` is built from the `strategyId`
      // state, and that state is undefined until the user picks from the
      // switcher, while a loaded report always carries a real id -- so on the
      // ordinary single-scenario path the rebuilt key was `1Y|<uuid>` against
      // a current key of `1Y|`, and every settings save was discarded as
      // belonging to a selection nobody was on. Nothing refetched afterwards,
      // so the page went on showing the configuration the user had just
      // replaced.
      //
      // `dataKey` cannot drift from `requestKey` that way: it is the same
      // string the hook stamped when the fetch committed.
      savingForKey.current = saving ? dataKey : null;
      savingForStrategy.current = saving ? (data?.strategy.id ?? null) : null;
      // A save that ends without `onSaved` was refused. The navigation it was
      // carrying is not owed to a later, unrelated save.
      if (!saving) navigateAfterSave.current = null;
      if (saving) beginMutation();
      else endMutation();
    },
    [beginMutation, dataKey, data?.strategy.id, endMutation],
  );

  /**
   * The save returns the strategy re-evaluated with its new configuration, so
   * the page takes it as-is -- provided the user is still looking at what was
   * saved. The scenario id is deliberately left alone: the save never moves the
   * user to a different one, and the first save creates the only scenario there
   * is, which is what an unset id already resolves to.
   */
  const handleConfigSaved = useCallback(
    (report: GemStrategyReportData) => {
      // The response has to be of the scenario that was saved. `updateConfig`
      // answers with the strategy it wrote, so a mismatch means the two have
      // drifted and neither is safe to show.
      if (
        savingForStrategy.current &&
        report.strategy.id !== savingForStrategy.current
      ) {
        // The response is not of what was saved, so neither is the navigation
        // that was waiting on it. Dropping it is the same call as dropping the
        // report: an action aimed at a scenario nobody is looking at.
        navigateAfterSave.current = null;
        return;
      }
      adopt(report, savingForKey.current ?? requestKey);
      // The edits are on the server, so the dialog's question is answered and
      // whatever the user was on their way to can happen.
      const onward = navigateAfterSave.current;
      navigateAfterSave.current = null;
      setSettingsDirty(false);
      onward?.();
    },
    [adopt, requestKey],
  );

  // A failed load of a *new* selection cannot fall back to the old report.
  //
  // Keeping the previous one visible is right while the next is on its way and
  // wrong once it has failed: the page would then present scenario A, with A's
  // signal and A's numbers, as though it were the B the user asked for -- and
  // the actions on it would be aimed at A. `dataKey` is what tells the two
  // situations apart, because the hook stamps a failure with the key it was
  // loading rather than leaving the previous one in place.
  if (error && (!data || dataKey !== requestKey)) {
    return (
      <div className="px-4 pt-6 pb-8 sm:px-6 lg:px-12">
        <ReportError message={t("gem.error.loadFailed")} onRetry={reload} />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="px-4 pt-6 pb-8 sm:px-6 lg:px-12">
        <GemReportSkeleton />
      </div>
    );
  }

  const {
    strategy,
    assets,
    signal,
    position,
    action,
    performance,
    history,
    backtest,
  } = data;
  const signalUnavailable = signal === null;

  /**
   * A panel's attributes: its tab wiring, and the stale marking every panel
   * needs.
   *
   * Ids come from the shared tab helpers so a panel and its tab cannot drift
   * apart if the convention changes.
   *
   * The marking is on all of them rather than on one. While the selection and
   * the report disagree, the body goes on showing the previous scenario's
   * signal, portfolio, transfer, allocation and history -- only the chart and
   * the settings tab swapped to skeletons. Keeping the rest on screen is the
   * better read, a blank page loses the user's place, but `docs/frontend/api-and-cache.md`
   * allows it only while the pixels *and* assistive technology both say the data
   * is stale. Mutations are already disabled; this is the other half.
   */
  const panelProps = (panel: GemTab, className?: string) => ({
    role: "tabpanel" as const,
    id: tabPanelId(GEM_TABS_ID_PREFIX, panel),
    "aria-labelledby": tabId(GEM_TABS_ID_PREFIX, panel),
    tabIndex: -1,
    "aria-busy": isStaleSelection,
    className: [
      "transition-opacity motion-reduce:transition-none",
      isStaleSelection ? "opacity-60" : "",
      className ?? "",
    ]
      .filter(Boolean)
      .join(" "),
  });

  return (
    <main className="px-4 pt-6 pb-8 sm:px-6 lg:px-12">
      <GemStrategyHeader
        strategyId={strategy.id}
        strategyName={strategy.name}
        scenarios={data.strategies}
        onSelectScenario={(id: string) => guarded(() => setStrategyId(id))()}
        // Creating switches to the new scenario's settings, which unmounts a
        // dirty form exactly as switching or deleting does. It is guarded for
        // the same reason, and the thunk carries the typed name so the
        // scenario is still created once the user has answered.
        onCreateScenario={async (name: string) => {
          if (settingsDirty) {
            guarded(() => void handleCreateScenario(name))();
            return "deferred";
          }
          return handleCreateScenario(name);
        }}
        onDeleteScenario={async (id: string) => {
          // Deleting is the one guarded action that answers the child: the
          // confirmation stays open until it knows. Holding the edits behind
          // the unsaved-changes dialog is not a failure and must not read as
          // one -- a confirmation left open across the deferred delete comes
          // back pointed at whichever scenario replaced this one.
          if (settingsDirty) {
            guarded(() => void handleDeleteScenario(id))();
            return "deferred";
          }
          return handleDeleteScenario(id);
        }}
        scenarioBusy={isSaving || isStaleSelection}
        cadence={strategy.cadence}
        lookbackMonths={strategy.lookbackMonths}
        nextEvaluationOn={strategy.nextEvaluationOn}
        daysUntilNextEvaluation={strategy.daysUntilNextEvaluation}
        onEditSettings={guarded(() => setTab("settings"))}
      />

      <GemStrategyTabs
        active={tab}
        onChange={(next: GemTab) => guarded(() => setTab(next))()}
      />

      {/* What the greyed-out panels mean, in words. The opacity alone is a
          styling cue a screen reader never sees and a user with a high-contrast
          theme may not either, so the state is stated as well as drawn -- and
          announced, because the switch is the user's own action and they are
          waiting on its answer. */}
      {isStaleSelection && (
        <p
          role="status"
          aria-live="polite"
          data-testid="gem-stale-indicator"
          className="mb-3 inline-flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400"
        >
          <span
            aria-hidden="true"
            className="inline-block h-3 w-3 animate-spin rounded-full border-b-2 border-blue-600 dark:border-blue-400"
          />
          {t("gem.stale.updating")}
        </p>
      )}

      <GemWarningsBanner
        warnings={data.warnings}
        lookbackMonths={strategy.lookbackMonths}
        assets={assets}
      />

      {tab === "overview" && (
        <div {...panelProps("overview", "space-y-4")}>
          {/* Four summary cards: signal, portfolio fit, money to move, asset roster. */}
          <div
            className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"
            {...tourAnchor(TOUR_ANCHORS.gemStrategyOverviewCards)}
          >
            <GemSignalCard
              signal={signal}
              nextEvaluationOn={strategy.nextEvaluationOn}
              daysUntilNextEvaluation={strategy.daysUntilNextEvaluation}
              firstRun={codes.has("FIRST_RUN")}
              failed={codes.has("CALCULATION_FAILED")}
            />
            <GemPortfolioCard
              position={position}
              noAccount={codes.has("NO_ACCOUNT")}
            />
            <GemTransferCard
              action={action}
              signalUnavailable={signalUnavailable}
              noAccount={codes.has("NO_ACCOUNT")}
            />
            <GemAssetsCard assets={assets} winnerRole={winnerRole} />
          </div>

          {/*
            Chart left / recommendation right on wide screens. On mobile the
            recommendation comes first (it is the actionable part); from the
            tablet breakpoint the chart leads, per the layout spec.
          */}
          <div
            className="grid gap-4 xl:grid-cols-[minmax(0,7fr)_minmax(0,3fr)] xl:items-start"
            // The grid, not GemNextActionCard: that card is also rendered on the
            // Portfolio tab, so anchoring it there would attach the id twice.
            {...tourAnchor(TOUR_ANCHORS.gemStrategyChartAndAction)}
          >
            <div className="order-2 md:order-1 xl:order-none">
              <GemPerformanceChart
                performance={performance}
                assets={assets}
                winnerRole={winnerRole}
                range={range}
                onRangeChange={setRange}
                isLoading={isLoading}
              />
            </div>
            <div className="order-1 space-y-4 md:order-2 xl:order-none">
              <GemNextActionCard
                action={action}
                signalUnavailable={signalUnavailable}
                noAccount={codes.has("NO_ACCOUNT")}
                onMarkExecuted={handleMarkExecuted}
                onAddTransactions={handleAddTransactions}
                isSaving={isSaving || isStaleSelection}
              />
              <GemAllocationCard
                signal={signal}
                winnerRole={winnerRole}
                cadence={strategy.cadence}
              />
            </div>
          </div>

          <GemReasoningSection
            signal={signal}
            lookbackMonths={strategy.lookbackMonths}
          />

          <GemSignalHistoryTable
            history={history}
            limit={OVERVIEW_HISTORY_ROWS}
            onShowAll={guarded(() => setTab("signals"))}
            symbolByRole={symbolByRole}
            lookbackMonths={strategy.lookbackMonths}
          />
        </div>
      )}

      {tab === "signals" && (
        <div {...panelProps("signals")}>
          <GemSignalHistoryTable
            history={history}
            symbolByRole={symbolByRole}
            lookbackMonths={strategy.lookbackMonths}
          />
        </div>
      )}

      {tab === "portfolio" && (
        <div
          {...panelProps("portfolio", "grid gap-4 lg:grid-cols-2 lg:items-start")}
        >
          <GemPortfolioPanel
            position={position}
            noAccount={codes.has("NO_ACCOUNT")}
            noPosition={codes.has("NO_POSITION")}
          />
          <GemNextActionCard
            action={action}
            signalUnavailable={signalUnavailable}
            noAccount={codes.has("NO_ACCOUNT")}
            onMarkExecuted={handleMarkExecuted}
            onAddTransactions={handleAddTransactions}
            isSaving={isSaving || isStaleSelection}
          />
        </div>
      )}

      {tab === "backtest" && (
        <div {...panelProps("backtest")}>
          <GemBacktestPanel backtest={backtest} />
        </div>
      )}

      {tab === "settings" && (
        <div {...panelProps("settings")}>
          {isStaleSelection ? (
            /* The whole form goes, not just its submit button. Disabling the
               action cards was not enough here: the form kept rendering the
               scenario the user had just left, with its instrument pickers,
               its one-click fill and its save all live, so a submit sent the
               old scenario's id and the response could then be adopted under
               the new selection. There is no version of this form that is
               safe to interact with while it describes something other than
               what is selected. */
            <Skeleton className="h-96 w-full" />
          ) : (
            /* Keyed on the scenario: react-hook-form reads its defaults once,
               at mount, so switching scenarios with the tab open would
               otherwise leave the previous scenario's values under the new
               one's name. The nonce is the other half of that: it is what makes
               "Discard" a remount, and so an actual discard. */
            <GemSettingsForm
              key={`${strategy.id ?? "unsaved"}:${settingsResetNonce}`}
              strategy={strategy}
              assets={assets}
              range={range}
              onSaved={handleConfigSaved}
              onDirtyChange={setSettingsDirty}
              submitRef={submitSettings}
              onSavingChange={handleSettingsSaving}
              onInvalidSubmit={handleInvalidSettingsSubmit}
            />
          )}
        </div>
      )}

      <GemStrategyFooter strategy={strategy} />

      {/* The repository's own dialog rather than a second bespoke flow.
          "Save" submits the form and stays put: navigating on the strength of
          a submit that has not resolved would discard the edits anyway if the
          server refused them. */}
      <UnsavedChangesDialog
        isOpen={pendingNavigation !== null}
        onSave={() => {
          navigateAfterSave.current = pendingNavigation;
          setPendingNavigation(null);
          submitSettings.current?.();
        }}
        onDiscard={() => {
          const action = pendingNavigation;
          navigateAfterSave.current = null;
          setSettingsDirty(false);
          // Throw the edits away for real. Without the remount the form keeps
          // them, stays dirty, and has no transition left to report -- so the
          // guard never re-arms and the *next* switch loses them silently.
          setSettingsResetNonce((nonce) => nonce + 1);
          setPendingNavigation(null);
          action?.();
        }}
        onCancel={() => {
          navigateAfterSave.current = null;
          setPendingNavigation(null);
        }}
      />
    </main>
  );
}
