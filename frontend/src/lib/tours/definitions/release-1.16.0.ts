import { TOUR_ANCHORS } from '../anchors';
import type { TourDefinition } from '../types';

/** Minor line these tours belong to; matched against the running major.minor. */
export const RELEASE_1_16_MINOR = '1.16';

/**
 * Notification delivery (discussion #1291): the bell as the record, the panel's
 * filters, and the three Settings blocks that decide where a notification goes
 * -- the channel matrix with its cooldowns, browser push and its devices, and
 * the daily investment-movement threshold.
 *
 * Two halves, in the order a reader meets them: what arrives (the bell), then
 * what they can do about it (Settings). The bell comes first deliberately --
 * the matrix's columns only mean something once you know the bell always gets
 * the row whatever the columns say.
 *
 * **Not gated on data.** Every anchor is a container that renders in every
 * state of its block: the panel and its filter strip render over an empty
 * inbox, and the push block renders its own "an administrator has not enabled
 * this" message rather than disappearing. So there is no `requiresData` and no
 * step that a first-run account would drop -- which matters here, because a
 * user with no notifications yet is precisely who this tour is for.
 *
 * The two panel steps carry `openNotificationBell`, the sibling of the
 * introduction tour's `openToolsMenu`: the panel is a dropdown that closes on a
 * click outside itself, so a `click` advance on the bell would open it and the
 * user's next click -- anywhere -- would close it under the step describing its
 * contents.
 */
export const RELEASE_1_16_NOTIFICATIONS_TOUR: TourDefinition = {
  id: 'release-1.16.0/notifications',
  area: 'settings',
  version: RELEASE_1_16_MINOR,
  i18nPrefix: 'release.v1_16_0.notifications',
  steps: [
    {
      // Route-agnostic welcome: shows wherever the tour was launched, so it
      // never fights a closing What's New modal's history.back().
      id: 'welcome',
      anchorId: null,
    },
    {
      // The header bell, closed. Pinned to /dashboard so the tour starts from a
      // known screen -- the bell itself is in the header on every route, but a
      // step whose route the engine can navigate to is one less thing that
      // depends on where the user happened to launch the tour.
      id: 'bell',
      route: '/dashboard',
      anchorId: TOUR_ANCHORS.notificationBell,
      placement: 'bottom',
    },
    {
      // The open panel. Unobtrusive because on a phone the panel covers the
      // whole viewport, so dimming everything outside the cutout dims nothing
      // and only darkens the panel's own edges.
      id: 'panel',
      route: '/dashboard',
      anchorId: TOUR_ANCHORS.notificationPanel,
      openNotificationBell: true,
      placement: 'auto',
      unobtrusive: true,
    },
    {
      // The filter strip, and the fact that Delete all follows it. Same
      // `openNotificationBell`: leaving it off here would close the panel this
      // step points inside.
      id: 'filters',
      route: '/dashboard',
      anchorId: TOUR_ANCHORS.notificationPanelFilters,
      openNotificationBell: true,
      placement: 'bottom',
      // Passive, but the chips stay clickable so the reader can try one while
      // the step explains it; a plain Next-advancing step would cover them with
      // the spotlight's click blocker.
      allowInteraction: true,
    },
    {
      // Settings -> Notifications as a whole. Unobtrusive: the step is about a
      // screen, and dimming hides the very card it names.
      id: 'settings',
      route: '/settings',
      anchorId: TOUR_ANCHORS.settingsNotifications,
      placement: 'auto',
      unobtrusive: true,
    },
    {
      // The channel matrix, cooldown column included -- the Cooldown heading is
      // desktop-only markup, so it gets a sentence inside this step rather than
      // a step of its own pointing at an element a phone never renders.
      // `allowInteraction` because every switch here saves as it is flipped,
      // which is the other half of what the copy says.
      id: 'matrix',
      route: '/settings',
      anchorId: TOUR_ANCHORS.notificationChannelMatrix,
      placement: 'auto',
      allowInteraction: true,
    },
    {
      id: 'push',
      route: '/settings',
      anchorId: TOUR_ANCHORS.notificationPushDevices,
      placement: 'auto',
      allowInteraction: true,
    },
    {
      // The daily investment-movement threshold. Its control renders nothing
      // until the setting has loaded and renders a retry panel when that load
      // failed, so this is the one step whose anchor can genuinely be absent --
      // the engine skips it, which is right: a transient failure is not
      // something the step has anything to say about.
      id: 'portfolio',
      route: '/settings',
      anchorId: TOUR_ANCHORS.notificationPortfolioAlert,
      placement: 'auto',
      allowInteraction: true,
    },
    {
      id: 'finish',
      route: '/settings',
      anchorId: null,
    },
  ],
};

/**
 * "Break down by tag key" (`docs/specs/report-tag-key-breakdown.md`): the
 * opt-in control on Income vs Expenses and Cash Flow that splits either
 * report into per-tag-value buckets plus an Untagged bucket, and surfaces
 * tagged transfer flows as their own figure -- never folded into income
 * (INV-REPORT-003).
 *
 * **The anchored step is `fallbackWhenMissing`.** `TagKeyBreakdownSelect`
 * renders nothing until the user has at least one `KEY:VALUE` tag, so a
 * fresh account (or one that only categorizes, never tags) never mounts the
 * anchor. Skipping the step outright would be wrong here -- unlike an anchor
 * lost to a refactor, the absence is itself the thing worth a sentence: the
 * fallback explains that tagging a transaction `scope:household` (say) is
 * what makes the control appear, so the reader leaves knowing what to do
 * next rather than the step silently vanishing. A short `anchorTimeoutMs`
 * keeps that stand-in from sitting behind a blank screen.
 *
 * The buckets view is deliberately anchorless: `TagKeyBreakdownBuckets` only
 * mounts once a key is picked, which a passive tour cannot force (there is no
 * synthetic key to select on the reader's behalf), so it gets an unobtrusive
 * anchorless step describing what appears instead of pointing at it.
 */
export const RELEASE_1_16_REPORT_TAG_BREAKDOWN_TOUR: TourDefinition = {
  id: 'release-1.16.0/report-tag-breakdown',
  area: 'reports',
  version: RELEASE_1_16_MINOR,
  i18nPrefix: 'release.v1_16_0.reportTagBreakdown',
  steps: [
    {
      // Route-agnostic welcome: shows wherever the tour was launched, so it
      // never fights a closing What's New modal's history.back().
      id: 'welcome',
      anchorId: null,
    },
    {
      // The control itself. It renders nothing without a KEY:VALUE tag, so
      // the fallback carries the "how do I get this" answer instead of the
      // step disappearing. allowInteraction so the reader can try it when it
      // is there.
      id: 'breakdown',
      route: '/reports/income-vs-expenses',
      anchorId: TOUR_ANCHORS.reportTagBreakdownSelect,
      placement: 'bottom',
      allowInteraction: true,
      fallbackWhenMissing: true,
      anchorTimeoutMs: 2500,
    },
    {
      // The buckets view, described rather than anchored: it only mounts
      // once a key is picked, which nothing here can do for the reader.
      // Unobtrusive because the step is about a whole card of tabs, and
      // dimming would hide the very content it names.
      id: 'buckets',
      route: '/reports/income-vs-expenses',
      anchorId: null,
      unobtrusive: true,
    },
    {
      id: 'finish',
      route: '/reports/income-vs-expenses',
      anchorId: null,
    },
  ],
};

export const RELEASE_1_16_TOURS: readonly TourDefinition[] = [
  RELEASE_1_16_NOTIFICATIONS_TOUR,
  RELEASE_1_16_REPORT_TAG_BREAKDOWN_TOUR,
];
