import { addDaysYMD } from "../common/date-utils";
import {
  BOUNDARY_LAG_DAYS,
  daysBetween,
} from "../common/time-series/price-boundary.util";
import { FX_MAX_RATE_AGE_DAYS } from "../common/time-series/fx-rate-resolver";

/**
 * Which provider windows would close the holes in one pair's stored history.
 *
 * A planner rather than a loop, for the reason `net-worth/series-rate-fill.ts`
 * is one: the policy here is the whole feature, and it is worth testing without
 * a provider, a database or a clock.
 *
 * **Two different questions, two different bounds.** `resolveFxRate` answers a
 * date with the newest observation on or before it, up to
 * `FX_MAX_RATE_AGE_DAYS` old, so a date is *unresolvable* only when nothing
 * falls in the 45 days before it. That is the right bound for telling a reader
 * which of their dates cannot be converted at all, and it is the wrong bound
 * for deciding what to fetch: a history holding one observation per month is
 * resolvable on every date and still wrong on 29 days in 30, every one of them
 * priced at a rate struck weeks earlier. Planning on the 45-day bound reports
 * such a pair as complete and fetches nothing, which is exactly what a history
 * assembled by earlier month-end-only requests looks like.
 *
 * So `MAX_OBSERVATION_GAP_DAYS` decides what to fetch and
 * `FX_MAX_RATE_AGE_DAYS` decides what to report. A weekend, a holiday and a
 * short provider outage still cost no call under the first; a month-end-only
 * stretch is work under it, and contributes nothing to `unresolvableDays`.
 *
 * `docs/specs/fx-history-gap-fill.md` is the contract this implements.
 */

/**
 * Windows *fetched* in one request.
 *
 * Each is one outbound provider call (two, when the direct symbol answers
 * nothing or a sparse series and the reverse is tried), so the cap is what keeps a press of a
 * button bounded. What it leaves out is reported rather than dropped: the plan
 * is recomputed from what is stored, so pressing again continues where this
 * one stopped.
 *
 * The planner does not apply it, and must not. A pair whose provider history
 * starts years after the reader's own data does -- `USDCAD=X` carries nothing
 * before December 2003, against a ledger opening in 1996 -- plans a run of
 * windows that can never be filled. Capping the plan puts those inside the
 * budget, so the second press spends itself skipping the same dead years and
 * fetches nothing at all. The caller drops what it already knows is empty and
 * then takes this many.
 */
export const MAX_GAP_WINDOWS = 8;

/**
 * Wall-clock budget for one fill, checked between windows.
 *
 * The cap alone does not bound the request: a slow provider turns eight
 * windows into a minute of somebody watching a spinner. Whichever bound is
 * reached first stops the loop, and the remainder is reported the same way.
 */
export const GAP_FILL_BUDGET_MS = 20_000;

/**
 * The longest stretch without an observation that still counts as covered.
 *
 * This is the bound that decides what to fetch, and it is deliberately far
 * tighter than `FX_MAX_RATE_AGE_DAYS`. Ten days clears every ordinary market
 * closure -- a weekend is three, Easter's Thursday-to-Tuesday is five, and
 * Christmas through the 2nd of January is nine -- so a densely stored pair
 * plans nothing. It does not clear a month: a history holding only month-end
 * observations sits 28 to 31 days apart and is planned as the hole it is.
 *
 * Raising this past a month would make month-end-only history read as
 * complete, which is the defect this constant exists to prevent. Lowering it
 * past a long weekend would re-fetch the whole history every press to chase
 * days no market ever priced.
 */
export const MAX_OBSERVATION_GAP_DAYS = 10;

/**
 * The widest window one provider request may cover.
 *
 * Asked for decades in one breath Yahoo answers with monthly bars stamped on
 * the 1st, each carrying the month's close under the wrong date;
 * `persistRateSeries` would store those as daily observations -- which is how a
 * month-end-only history comes to exist in the first place. A one-year window
 * always comes back daily. `MarketIndexService` chunks at the same figure, for
 * the same reason, and prices have `assertDailySeries` behind them as well --
 * exchange rates do not, so this chunking is the whole protection.
 */
export const GAP_WINDOW_MAX_DAYS = 365;

/** One provider request: an inclusive `YYYY-MM-DD` range. */
export interface RateGapWindow {
  readonly start: string;
  readonly end: string;
}

export interface RateGapPlan {
  /**
   * Every window the span needs, oldest first, each at most
   * `GAP_WINDOW_MAX_DAYS` long. Budgeting belongs to the caller, which knows
   * which of these the provider has already answered with nothing.
   */
  readonly windows: RateGapWindow[];
  /**
   * Calendar days in the span no stored observation can answer *at all*, on
   * the `FX_MAX_RATE_AGE_DAYS` bound. Zero is common while `windows` is not
   * empty: a month-end-only history converts every date and prices almost none
   * of them on their own day.
   */
  readonly unresolvableDays: number;
  /**
   * Calendar days in the span with no observation within
   * `MAX_OBSERVATION_GAP_DAYS`. This is the measure the windows cover, and the
   * honest answer to "how much of this history is actually missing".
   */
  readonly sparseDays: number;
}

/** Inclusive day count, so a single-day range is 1. */
function inclusiveDays(start: string, end: string): number {
  return daysBetween(start, end) + 1;
}

/** Total inclusive days across a set of non-overlapping runs. */
function totalDays(runs: readonly RateGapWindow[]): number {
  return runs.reduce((sum, run) => sum + inclusiveDays(run.start, run.end), 0);
}

/**
 * The runs of dates in `[spanStart, spanEnd]` that no observation covers, where
 * an observation covers the `reachDays` after it.
 *
 * Computed from the observations themselves rather than by walking the
 * calendar: a date is uncovered exactly when it is more than `reachDays` after
 * the newest observation at or before it, which makes each run the stretch
 * between one observation's reach and the next observation.
 *
 * `observations` may include dates before `spanStart` -- an observation a
 * fortnight before the span is what answers its first days -- and anything
 * after `spanEnd` is ignored, because a rate struck after a date never stands
 * for it (INV-FX-001).
 */
function uncoveredRuns(
  observations: readonly string[],
  spanStart: string,
  spanEnd: string,
  reachDays: number,
): RateGapWindow[] {
  const inScope = observations
    .filter((date) => date <= spanEnd)
    .sort((a, b) => a.localeCompare(b));

  if (inScope.length === 0) return [{ start: spanStart, end: spanEnd }];

  const runs: RateGapWindow[] = [];
  const push = (start: string, end: string) => {
    const from = start < spanStart ? spanStart : start;
    const to = end > spanEnd ? spanEnd : end;
    if (from <= to) runs.push({ start: from, end: to });
  };

  // Before the first observation nothing can be carried forward from: a
  // lookup may not reach forwards to the observation that follows it.
  push(spanStart, addDaysYMD(inScope[0], -1));

  for (let i = 0; i < inScope.length; i++) {
    const reach = addDaysYMD(inScope[i], reachDays);
    const next = inScope[i + 1];
    // The day after this observation's reach until the day before the next one
    // answers anything. With no next observation, the run ends with the span.
    push(addDaysYMD(reach, 1), next ? addDaysYMD(next, -1) : spanEnd);
  }

  return runs;
}

/** A window split into pieces the provider still answers daily. */
function chunkWindow(window: RateGapWindow): RateGapWindow[] {
  const chunks: RateGapWindow[] = [];
  let start = window.start;
  while (start <= window.end) {
    const proposed = addDaysYMD(start, GAP_WINDOW_MAX_DAYS - 1);
    const end = proposed > window.end ? window.end : proposed;
    chunks.push({ start, end });
    start = addDaysYMD(end, 1);
  }
  return chunks;
}

/**
 * The runs packed into as few provider requests as they fit in.
 *
 * One request covering a year costs exactly what one covering a fortnight
 * costs, and it overwrites every date it spans with the provider's own answer
 * for that date, so covering two nearby holes and the stored rows between them
 * in one call is strictly cheaper than two calls that skip those rows. Month-
 * end-only history is the case that makes this necessary rather than tidy: its
 * holes recur every month, and planning one window each turns a decade into a
 * hundred and twenty requests, eight per press.
 *
 * `GAP_WINDOW_MAX_DAYS` is what stops the packing running away. Two holes more
 * than a year apart cannot share a window, so a dense decade between two gaps
 * is never swept up and re-fetched.
 */
function packRuns(runs: readonly RateGapWindow[]): RateGapWindow[] {
  const packed: RateGapWindow[] = [];
  let current: RateGapWindow | null = null;

  for (const run of runs) {
    // Lead so the run's first day has an observation to carry forward from
    // even where the provider's first bar of the window lands late. The end is
    // never extended: a window running past `spanEnd` would ask for dates the
    // market has not reached.
    const start = addDaysYMD(run.start, -BOUNDARY_LAG_DAYS);
    if (
      current &&
      run.end <= addDaysYMD(current.start, GAP_WINDOW_MAX_DAYS - 1)
    ) {
      current = { start: current.start, end: run.end };
      continue;
    }
    if (current) packed.push(current);
    current = { start, end: run.end };
  }
  if (current) packed.push(current);

  // A single run wider than the bound is still too wide to ask for at once.
  return packed.flatMap(chunkWindow);
}

export interface RateGapPlanOptions {
  /** Overrides `MAX_OBSERVATION_GAP_DAYS`, the bound that decides what to fetch. */
  readonly densityDays?: number;
  /** Overrides `FX_MAX_RATE_AGE_DAYS`, the bound that decides what to report. */
  readonly maxAgeDays?: number;
}

/**
 * The provider windows that would give `[spanStart, spanEnd]` a daily history,
 * oldest first.
 *
 * `storedDates` are the pair's observations as `YYYY-MM-DD`, in either stored
 * orientation, deduplicated by date; order does not matter. Pass the ones from
 * `maxAgeDays` before `spanStart` onwards, or the span's first days are
 * reported as a hole an earlier observation already fills.
 *
 * Oldest first because a report fails from its start date: covering the oldest
 * hole is what makes an all-time chart start answering, and a partially
 * completed fill then leaves a contiguous span rather than a scatter.
 */
export function planRateGapWindows(
  storedDates: readonly string[],
  spanStart: string,
  spanEnd: string,
  options: RateGapPlanOptions = {},
): RateGapPlan {
  if (spanStart > spanEnd) {
    return { windows: [], unresolvableDays: 0, sparseDays: 0 };
  }

  const densityDays = options.densityDays ?? MAX_OBSERVATION_GAP_DAYS;
  const maxAgeDays = options.maxAgeDays ?? FX_MAX_RATE_AGE_DAYS;

  const sparse = uncoveredRuns(storedDates, spanStart, spanEnd, densityDays);
  const unresolvable = uncoveredRuns(
    storedDates,
    spanStart,
    spanEnd,
    maxAgeDays,
  );

  return {
    windows: packRuns(sparse),
    unresolvableDays: totalDays(unresolvable),
    sparseDays: totalDays(sparse),
  };
}

/**
 * Whether a series one provider symbol returned for `[start, end]` leaves a
 * stretch longer than `MAX_OBSERVATION_GAP_DAYS` with no observation -- at the
 * window's opening, between two bars, or before its close.
 *
 * The same density bound the planner fetches on, applied to one answer: a
 * symbol that returned one bar for a month answered, and is still not a daily
 * series. Yahoo carries some pairs fully under one orientation and only
 * sporadically under the other (`VNDSGD=X` against `SGDVND=X`), so a fill that
 * stopped at "the direct symbol returned something" stored a month-end-only
 * history the reverse symbol could have made daily. An empty series is sparse.
 *
 * The opening edge is measured from `start` itself rather than treated as a
 * hole the way `planRateGapWindows` treats it: a window opening on a Saturday
 * has its first bar on the Monday, and that is a dense answer.
 */
export function isSparseRateSeries(
  dates: readonly string[],
  start: string,
  end: string,
  densityDays: number = MAX_OBSERVATION_GAP_DAYS,
): boolean {
  if (start > end) return false;
  const inWindow = [
    ...new Set(dates.filter((date) => date >= start && date <= end)),
  ].sort((a, b) => a.localeCompare(b));
  if (inWindow.length === 0) return true;

  const marks = [start, ...inWindow, end];
  for (let i = 1; i < marks.length; i++) {
    if (daysBetween(marks[i - 1], marks[i]) > densityDays) return true;
  }
  return false;
}
