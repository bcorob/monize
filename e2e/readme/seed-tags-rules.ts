import type { ApiClient } from '../helpers/api';
import { createTag } from '../helpers/factories';
import { addDays } from './settings';
import {
  has,
  indexByName,
  loadTransactions,
  money,
  need,
  type Lookups,
  type Named,
  type TagRow,
  type TransactionRow,
} from './seed-lookup';

// Tags, the transactions they sit on, and the rules that would put them there.

/** The showcase tags. `key:value` names are the 1.17.0 key/value tags. */
const TAGS = [
  { name: 'trip:Lisbon', color: '#0EA5E9', icon: 'airplane' },
  { name: 'project:Kitchen', color: '#F59E0B', icon: 'home' },
  { name: 'Date night', color: '#EC4899', icon: 'heart' },
  { name: 'Coffee run', color: '#A16207', icon: 'shopping-bag' },
  { name: 'Subscription', color: '#8B5CF6', icon: 'refresh' },
  { name: 'Home office', color: '#10B981', icon: 'computer' },
] as const;

export const LISBON_TAG = 'trip:Lisbon';

export async function seedTags(api: ApiClient): Promise<Map<string, TagRow>> {
  const existing = indexByName(await api.get<TagRow[]>('/tags'));
  for (const tag of TAGS) {
    if (!has(existing, tag.name)) await createTag(api, tag);
  }
  return indexByName(await api.get<TagRow[]>('/tags'));
}

interface TagPlan {
  tag: string;
  matches: (row: TransactionRow, ctx: PlanContext) => boolean;
}

interface PlanContext {
  recentFrom: string;
  lisbonFrom: string;
  lisbonTo: string;
  homeGoodsId: string;
}

const payeeIs = (row: TransactionRow, ...names: string[]) =>
  row.payeeName !== null && names.some((n) => n.toLowerCase() === row.payeeName!.toLowerCase());

const PLANS: TagPlan[] = [
  {
    tag: 'Coffee run',
    matches: (row, c) => payeeIs(row, 'Tim Hortons', 'Starbucks') && row.transactionDate >= c.recentFrom,
  },
  {
    tag: 'Subscription',
    matches: (row, c) =>
      payeeIs(row, 'Netflix', 'Spotify', 'Disney+') && row.transactionDate >= c.recentFrom,
  },
  { tag: 'Date night', matches: (row) => payeeIs(row, 'The Keg Steakhouse') },
  {
    tag: 'project:Kitchen',
    matches: (row, c) =>
      payeeIs(row, 'IKEA') ||
      (payeeIs(row, 'Amazon.ca') && row.categoryId === c.homeGoodsId && Math.abs(money(row.amount)) >= 100),
  },
  {
    tag: 'trip:Lisbon',
    matches: (row, c) =>
      payeeIs(row, 'Air Canada', 'Airbnb', 'Hotel Avenida Palace') ||
      (payeeIs(row, 'Uber Eats') &&
        row.transactionDate >= c.lisbonFrom &&
        row.transactionDate <= c.lisbonTo),
  },
  {
    tag: 'Home office',
    matches: (row, c) => payeeIs(row, 'Rogers Internet', 'Bell Canada') && row.transactionDate >= c.recentFrom,
  },
];

/**
 * Put each tag on the rows it belongs to. The plan is worked out from the data
 * itself (the newest date, the Airbnb stay), not from today's date, because the
 * demo ledger is dated relative to when it was seeded. Rows that already carry
 * exactly the planned tags are left alone, so a second run writes nothing.
 */
export async function attachTags(
  api: ApiClient,
  lookups: Lookups,
  tags: Map<string, TagRow>,
): Promise<number> {
  const rows = (await loadTransactions(api)).filter((r) => !r.isTransfer && !r.isSplit);
  const newest = rows.reduce((max, r) => (r.transactionDate > max ? r.transactionDate : max), '');
  const airbnb = rows.find((r) => payeeIs(r, 'Airbnb'));
  const stay = airbnb?.transactionDate ?? newest;

  const ctx: PlanContext = {
    recentFrom: addDays(newest, -90),
    lisbonFrom: addDays(stay, -3),
    lisbonTo: addDays(stay, 6),
    homeGoodsId: need(lookups.categories, 'Home Goods', 'category').id,
  };

  const wanted = new Map<string, Set<string>>();
  for (const row of rows) {
    for (const plan of PLANS) {
      if (!plan.matches(row, ctx)) continue;
      const set = wanted.get(row.id) ?? new Set<string>();
      set.add(need(tags, plan.tag, 'tag').id);
      wanted.set(row.id, set);
    }
  }

  // One bulk update per distinct set of tags.
  const groups = new Map<string, { tagIds: string[]; ids: string[] }>();
  for (const row of rows) {
    const target = wanted.get(row.id);
    if (!target) continue;
    const current = new Set(row.tags.map((t) => t.id));
    const same = current.size === target.size && [...target].every((id) => current.has(id));
    if (same) continue;
    const tagIds = [...target].sort();
    const group = groups.get(tagIds.join()) ?? { tagIds, ids: [] };
    group.ids.push(row.id);
    groups.set(tagIds.join(), group);
  }

  let changed = 0;
  for (const { tagIds, ids } of groups.values()) {
    await api.post('/transactions/bulk-update', { mode: 'ids', transactionIds: ids, tagIds });
    changed += ids.length;
  }
  return changed;
}

interface RuleSeed {
  name: string;
  enabled?: boolean;
  condition: Record<string, unknown>;
  actions: Record<string, unknown>[];
}

/**
 * Six rules a household might keep: on payees, on an amount, on the text a bank sends, and one switched off. They are
 * saved, not run -- the tags above are already on the rows -- so the ledger the
 * pictures show is the one seeded here.
 */
export async function seedRules(
  api: ApiClient,
  lookups: Lookups,
  tags: Map<string, TagRow>,
): Promise<void> {
  const payee = (name: string) => need(lookups.payees, name, 'payee').id;
  const category = (name: string) => need(lookups.categories, name, 'category').id;
  const tag = (name: string) => need(tags, name, 'tag').id;

  const rules: RuleSeed[] = [
    {
      name: 'Coffee runs',
      condition: { all: [{ field: 'payeeId', op: 'in', value: [payee('Tim Hortons'), payee('Starbucks')] }] },
      actions: [
        { type: 'set_category', categoryId: category('Coffee Shops'), onlyIfEmpty: true },
        { type: 'add_tags', tagIds: [tag('Coffee run')] },
      ],
    },
    {
      name: 'Streaming subscriptions',
      condition: {
        all: [{ field: 'payeeId', op: 'in', value: [payee('Netflix'), payee('Spotify'), payee('Disney+')] }],
      },
      actions: [
        { type: 'set_category', categoryId: category('Streaming Services'), onlyIfEmpty: true },
        { type: 'add_tags', tagIds: [tag('Subscription')] },
      ],
    },
    {
      name: 'Dinners out over $100',
      condition: {
        all: [
          { field: 'categoryId', op: 'eq', value: category('Restaurants') },
          { field: 'absAmount', op: 'gte', value: 100 },
        ],
      },
      actions: [{ type: 'add_tags', tagIds: [tag('Date night')] }],
    },
    {
      name: 'Home office bills',
      condition: {
        all: [{ field: 'payeeId', op: 'in', value: [payee('Rogers Internet'), payee('Bell Canada')] }],
      },
      actions: [{ type: 'add_tags', tagIds: [tag('Home office')] }],
    },
    {
      name: 'Costco receipts',
      condition: { all: [{ field: 'payeeText', op: 'matches', value: '*costco*' }] },
      actions: [
        { type: 'set_payee', payeeId: payee('Costco'), onlyIfEmpty: false },
        { type: 'set_category', categoryId: category('Groceries'), onlyIfEmpty: true },
      ],
    },
    {
      // Switched off once the renovation was finished: shows a disabled row.
      name: 'Kitchen renovation',
      enabled: false,
      condition: {
        all: [
          { field: 'categoryId', op: 'eq', value: category('Home Goods') },
          { field: 'absAmount', op: 'gte', value: 50 },
        ],
      },
      actions: [{ type: 'add_tags', tagIds: [tag('project:Kitchen')] }],
    },
  ];

  const existing = indexByName(await api.get<Named[]>('/transaction-rules'));
  for (const rule of rules) {
    if (has(existing, rule.name)) continue;
    await api.post('/transaction-rules', {
      ...rule,
      enabled: rule.enabled ?? true,
      triggers: ['create', 'import'],
      stopProcessing: false,
    });
  }
}
