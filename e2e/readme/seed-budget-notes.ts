import type { ApiClient } from '../helpers/api';
import { has, indexByName, type Named } from './seed-lookup';
import { monthName, type ShowcaseMonth } from './settings';

// The budget, the calendar day notes and the user's preferences.

interface Analysis {
  categories: { categoryId: string; isIncome: boolean; suggested: number }[];
  transfers?: { accountId: string; suggested: number }[];
  estimatedMonthlyIncome: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * One monthly budget, built the way the "Create Your First Budget" wizard
 * builds it: analyse the last six months, then apply the suggested amounts.
 */
export async function seedBudget(
  api: ApiClient,
  month: ShowcaseMonth,
  currencyCode: string,
): Promise<string> {
  const name = `${monthName(month.month)} ${month.year} Budget`;
  const existing = indexByName(await api.get<Named[]>('/budgets'));
  if (has(existing, name)) return existing.get(name.toLowerCase())!.id;

  const analysis = await api.post<Analysis>('/budgets/generate', {
    analysisMonths: 6,
    strategy: 'FIXED',
    profile: 'ON_TRACK',
  });

  const categories = analysis.categories
    .filter((c) => c.isIncome || c.suggested > 0)
    .map((c) => ({
      categoryId: c.categoryId,
      amount: c.suggested,
      isIncome: c.isIncome,
      rolloverType: 'NONE',
    }));
  const transfers = (analysis.transfers ?? [])
    .filter((t) => t.suggested > 0)
    .map((t) => ({
      transferAccountId: t.accountId,
      isTransfer: true,
      amount: t.suggested,
      rolloverType: 'NONE',
    }));

  const created = await api.post<{ id: string }>('/budgets/generate/apply', {
    name,
    budgetType: 'MONTHLY',
    periodStart: month.start,
    strategy: 'FIXED',
    currencyCode,
    baseIncome: analysis.estimatedMonthlyIncome > 0 ? round2(analysis.estimatedMonthlyIncome) : undefined,
    incomeLinked: false,
    categories: [...categories, ...transfers],
  });
  return created.id;
}

const ymd = (month: ShowcaseMonth, day: number) =>
  `${month.year}-${String(month.month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

interface StoredNote {
  startDate: string;
  endDate: string;
  body: string;
}

/**
 * A few notes on the showcase month's calendar, one of them spanning three
 * days. The server's write is an upsert keyed by the day, so repeating it would
 * be harmless, but a note that already reads back as intended is left alone
 * rather than rewritten.
 */
export async function seedDayNotes(api: ApiClient, month: ShowcaseMonth): Promise<void> {
  const notes: { day: number; endDay?: number; body: string }[] = [
    { day: 5, body: 'Car insurance renews: ask Aviva about the multi-policy discount' },
    { day: 12, endDay: 14, body: 'Parents visiting' },
    { day: 21, body: 'Review the mortgage rate before the renewal letter arrives' },
  ];
  const stored = await api.get<StoredNote[]>(
    `/calendar/day-notes?startDate=${ymd(month, 1)}&endDate=${ymd(month, 28)}`,
  );
  for (const note of notes) {
    const startDate = ymd(month, note.day);
    const endDate = ymd(month, note.endDay ?? note.day);
    const present = stored.some(
      (n) => n.startDate === startDate && n.endDate === endDate && n.body === note.body,
    );
    if (present) continue;
    await api.put(`/calendar/day-notes/${startDate}`, { body: note.body, startDate, endDate });
  }
}

interface Preferences {
  defaultCurrency: string | null;
  theme: string;
  colorTheme: string;
  gettingStartedDismissed: boolean;
  showWhatsNew: boolean;
  dashboardWidgets: string[];
  dashboardWidgetConfig: Record<string, unknown>;
}

/**
 * The widgets the dashboard shows, in order. The "Spending Insights" widget is
 * left out on purpose: it fills in only when an AI provider is configured, and
 * an empty card is no picture of the product.
 */
const DASHBOARD_WIDGETS = [
  'favourite-accounts',
  'upcoming-bills',
  'top-movers',
  'portfolio-value',
  'expenses-pie',
  'income-expenses',
  'budget-status',
  'net-worth',
  'assets-liabilities',
];

/**
 * Dark mode with the default palette, the dashboard layout above with upcoming
 * bills listing everything that is coming (not only what is inside its reminder
 * window), and the two first-run prompts the app itself lets a user switch off
 * (the getting-started card and the "What's new" dialog), so neither covers a
 * page.
 */
export async function seedPreferences(api: ApiClient): Promise<Preferences> {
  const current = await api.get<Preferences>('/users/preferences');
  const wanted = {
    theme: 'dark',
    colorTheme: 'default',
    gettingStartedDismissed: true,
    showWhatsNew: false,
    dashboardWidgets: DASHBOARD_WIDGETS,
    dashboardWidgetConfig: {
      ...current.dashboardWidgetConfig,
      'upcoming-bills': { scope: 'all', view: 'list' },
    },
  };
  const differs = (Object.keys(wanted) as (keyof typeof wanted)[]).some(
    (k) => JSON.stringify(current[k]) !== JSON.stringify(wanted[k]),
  );
  if (!differs) return current;
  return api.patch<Preferences>('/users/preferences', wanted);
}
