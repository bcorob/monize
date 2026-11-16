import { TOUR_ANCHORS } from '../anchors';
import type { TourDefinition } from '../types';

/** Minor line these tours belong to; matched against the running major.minor. */
export const RELEASE_1_17_MINOR = '1.17';

/**
 * Transaction rules: conditions that fire when a transaction is created or
 * imported and set its category or payee, add tags, rewrite its description or
 * queue it for an AI review. A rule never changes an amount, account or date.
 *
 * The order is the order a reader meets the feature: where it lives (Tools),
 * the list, then the editor's When / If / Then / Test panels, and finally the
 * AI review inbox that a rule's "ask an AI" action feeds.
 *
 * **Not gated on data.** `/rules` renders a list card in every state (loading,
 * failed, empty, populated) and `/rules/new` renders the whole editor for a
 * blank draft, so a user with zero rules is precisely who this tour is for and
 * no step needs a rule to exist. The editor's "Run on existing transactions"
 * button only exists for a saved rule, so it is described inside the Test step
 * rather than anchored on a screen that does not render it.
 *
 * **Gated on `ownerView`.** The Rules entry in the Tools menu and the AI
 * review inbox are owner-only: the header hides the first from a delegate, and
 * the inbox's layout redirects a delegate to the dashboard. The whole tour is
 * hidden from the offer surfaces for a delegate, and the inbox step carries
 * the same requirement so a tour started any other way omits it instead of
 * being redirected away mid-step.
 *
 * The two Tools steps are `skipOnMobile`, as the introduction tour's is: the
 * phone drawer is not anchored. The menu step carries `openToolsMenu` and the
 * step pointing at the closed trigger must not (the open menu would cover the
 * button it names).
 */
export const RELEASE_1_17_TRANSACTION_RULES_TOUR: TourDefinition = {
  id: 'release-1.17.0/transaction-rules',
  area: 'transactions',
  version: RELEASE_1_17_MINOR,
  i18nPrefix: 'release.v1_17_0.transactionRules',
  requiresData: 'ownerView',
  steps: [
    {
      // Route-agnostic welcome: shows wherever the tour was launched, so it
      // never fights a closing What's New modal's history.back().
      id: 'welcome',
      anchorId: null,
    },
    {
      // The closed Tools trigger.
      id: 'tools',
      route: '/dashboard',
      anchorId: TOUR_ANCHORS.navTools,
      placement: 'bottom',
      skipOnMobile: true,
    },
    {
      // The Rules entry inside the open menu.
      id: 'rulesLink',
      route: '/dashboard',
      anchorId: TOUR_ANCHORS.navRules,
      openToolsMenu: true,
      unobtrusive: true,
      placement: 'right',
      skipOnMobile: true,
    },
    {
      // The list card, which also holds the empty state.
      id: 'list',
      route: '/rules',
      anchorId: TOUR_ANCHORS.rulesList,
      placement: 'auto',
      unobtrusive: true,
    },
    {
      id: 'create',
      route: '/rules',
      anchorId: TOUR_ANCHORS.rulesCreateButton,
      placement: 'bottom',
    },
    {
      id: 'when',
      route: '/rules/new',
      anchorId: TOUR_ANCHORS.ruleEditorWhen,
      placement: 'auto',
    },
    {
      id: 'if',
      route: '/rules/new',
      anchorId: TOUR_ANCHORS.ruleEditorIf,
      placement: 'auto',
    },
    {
      id: 'then',
      route: '/rules/new',
      anchorId: TOUR_ANCHORS.ruleEditorThen,
      placement: 'auto',
    },
    {
      // Also carries the running and undo story: the Run button is drawn only
      // for a saved rule.
      id: 'test',
      route: '/rules/new',
      anchorId: TOUR_ANCHORS.ruleEditorTest,
      placement: 'auto',
    },
    {
      id: 'reviews',
      requires: 'ownerView',
      route: '/ai-reviews',
      anchorId: TOUR_ANCHORS.aiReviewInbox,
      placement: 'auto',
      unobtrusive: true,
    },
  ],
};

export const RELEASE_1_17_TOURS: readonly TourDefinition[] = [
  RELEASE_1_17_TRANSACTION_RULES_TOUR,
];
