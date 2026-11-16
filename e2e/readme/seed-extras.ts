import type { ApiClient } from '../helpers/api';
import { addDays, todayYmd } from './settings';
import { has, indexByName, need, security, type Lookups, type Named } from './seed-lookup';

// More records that give a page its less common panel: fund allocations, a
// vehicle that loses value, saved Monte Carlo scenarios and favourite accounts.

interface Weight {
  name: string;
  weight: number;
}

interface AllocationPlan {
  countries: Weight[];
  assets: Weight[];
}

const EQUITY = 'Stocks';

const ALLOCATIONS: Record<string, AllocationPlan> = {
  VOO: { countries: [{ name: 'United States', weight: 0.995 }], assets: [{ name: EQUITY, weight: 0.997 }, { name: 'Cash', weight: 0.003 }] },
  VFV: { countries: [{ name: 'United States', weight: 0.995 }], assets: [{ name: EQUITY, weight: 0.997 }, { name: 'Cash', weight: 0.003 }] },
  VCN: { countries: [{ name: 'Canada', weight: 0.99 }], assets: [{ name: EQUITY, weight: 0.995 }, { name: 'Cash', weight: 0.005 }] },
  XIU: { countries: [{ name: 'Canada', weight: 0.99 }], assets: [{ name: EQUITY, weight: 0.996 }, { name: 'Cash', weight: 0.004 }] },
  XAW: {
    countries: [
      { name: 'United States', weight: 0.62 },
      { name: 'Japan', weight: 0.06 },
      { name: 'United Kingdom', weight: 0.04 },
      { name: 'France', weight: 0.03 },
      { name: 'Switzerland', weight: 0.03 },
      { name: 'Germany', weight: 0.03 },
    ],
    assets: [{ name: EQUITY, weight: 0.995 }, { name: 'Cash', weight: 0.005 }],
  },
  ZAG: { countries: [{ name: 'Canada', weight: 0.97 }, { name: 'United States', weight: 0.02 }], assets: [{ name: 'Bonds', weight: 0.99 }, { name: 'Cash', weight: 0.01 }] },
};

interface SecurityDetail {
  id: string;
  countryWeightings: Weight[] | null;
  assetWeightings: Weight[] | null;
}

/** A manual country and asset-class split on each fund, so the allocation views have something to draw. */
export async function seedAllocations(api: ApiClient, lookups: Lookups): Promise<void> {
  for (const [symbol, plan] of Object.entries(ALLOCATIONS)) {
    const sec = security(lookups, symbol);
    const current = await api.get<SecurityDetail>(`/securities/${sec.id}`);
    if (current.countryWeightings?.length && current.assetWeightings?.length) continue;
    await api.patch(`/securities/${sec.id}`, {
      countryWeightings: plan.countries,
      assetWeightings: plan.assets,
    });
  }
}

/**
 * The Vehicle's market value, adjusted four times over the year the way the
 * "Update Value" dialog does it: a transaction for the difference. Without them
 * the value history and the equity panel are a flat line.
 */
export async function seedVehicleValue(api: ApiClient, lookups: Lookups): Promise<void> {
  const vehicle = need(lookups.accounts, 'Vehicle', 'account');
  const existing = await api.get<{ data: { id: string }[] }>(
    `/transactions?accountIds=${vehicle.id}&limit=1`,
  );
  if (existing.data.length > 0) return;

  const today = todayYmd();
  const adjustments: [number, number][] = [
    [-270, -900],
    [-180, -700],
    [-90, -650],
    [-14, -450],
  ];
  for (const [daysAgo, delta] of adjustments) {
    await api.post('/transactions', {
      accountId: vehicle.id,
      transactionDate: addDays(today, daysAgo),
      amount: delta,
      currencyCode: vehicle.currencyCode,
      description: 'Value adjustment',
    });
  }
}

interface BrokerageAccount extends Named {
  currencyCode: string;
}

/**
 * Two saved Monte Carlo scenarios over the Canadian brokerage accounts, each
 * with a fixed random seed so the fan of paths is the same on every run.
 */
export async function seedMonteCarlo(api: ApiClient): Promise<void> {
  const accounts = await api.get<BrokerageAccount[]>('/monte-carlo/accounts');
  const accountIds = accounts.filter((a) => a.currencyCode === 'CAD').map((a) => a.id);
  if (accountIds.length === 0) return;

  const common = {
    accountIds,
    startingValue: 0,
    useCurrentBalance: true,
    contributionGrowthRate: 0.02,
    yearsInRetirement: 30,
    inflationRate: 0.02,
    showRealValues: true,
    useHistoricalReturns: false,
    simulationCount: 1000,
  };
  const scenarios = [
    {
      ...common,
      name: 'Retire at 60, balanced portfolio',
      description: 'Steady contributions into a 60/40 mix',
      yearsToRetirement: 25,
      annualContribution: 18000,
      annualWithdrawal: 60000,
      expectedReturn: 0.065,
      volatility: 0.12,
      targetValue: 1500000,
      randomSeed: '4242',
      cashFlows: [
        {
          name: 'Inheritance',
          amount: 50000,
          flowType: 'ONE_TIME',
          startYear: 12,
          inflationAdjust: true,
        },
      ],
    },
    {
      ...common,
      name: 'Retire at 55, growth portfolio',
      description: 'Higher contributions, more risk, earlier exit',
      yearsToRetirement: 20,
      annualContribution: 24000,
      annualWithdrawal: 66000,
      expectedReturn: 0.08,
      volatility: 0.17,
      targetValue: null,
      randomSeed: '7373',
    },
  ];

  const existing = indexByName(await api.get<Named[]>('/monte-carlo/scenarios'));
  for (const scenario of scenarios) {
    if (!has(existing, scenario.name)) await api.post('/monte-carlo/scenarios', scenario);
  }
}

/** More favourites, so the dashboard's card and the account strip are not two rows of white space. */
export async function seedFavourites(api: ApiClient, lookups: Lookups): Promise<void> {
  for (const name of ['Emergency Fund', 'Home Mortgage']) {
    const account = need(lookups.accounts, name, 'account');
    if (!account.isFavourite) await api.patch(`/accounts/${account.id}`, { isFavourite: true });
  }
}
