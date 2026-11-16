import { describe, it, expect, vi, beforeEach } from 'vitest';

const getAllAccounts = vi.fn();
const getSecurities = vi.fn();

vi.mock('@/lib/accounts', () => ({
  accountsApi: { getAll: (...args: unknown[]) => getAllAccounts(...args) },
}));
vi.mock('@/lib/investments', () => ({
  investmentsApi: { getSecurities: (...args: unknown[]) => getSecurities(...args) },
}));

import { resolveTourRequirements, isTourOfferable } from './requirements';
import { useAuthStore } from '@/store/authStore';
import type { TourDefinition } from './types';

function tour(overrides: Partial<TourDefinition> = {}): TourDefinition {
  return {
    id: 'test/tour',
    area: 'intro',
    i18nPrefix: 'test.tour',
    steps: [],
    ...overrides,
  };
}

describe('resolveTourRequirements', () => {
  beforeEach(() => {
    useAuthStore.setState({ actingAsUserId: null });
    getAllAccounts.mockReset().mockResolvedValue([]);
    getSecurities.mockReset().mockResolvedValue([]);
  });

  it('reports every requirement met when the user has the data', async () => {
    getAllAccounts.mockResolvedValue([{ id: 'a', accountType: 'CHEQUING' }]);
    getSecurities.mockResolvedValue([{ id: 's' }]);

    await expect(resolveTourRequirements()).resolves.toEqual({
      transactionEntry: true,
      accountsExist: true,
      securitiesExist: true,
      ownerView: true,
    });
  });

  it('reports a delegate view as not the owner', async () => {
    useAuthStore.setState({ actingAsUserId: 'owner-1' });

    await expect(resolveTourRequirements()).resolves.toMatchObject({
      ownerView: false,
    });
  });

  it('reports each requirement independently', async () => {
    getAllAccounts.mockResolvedValue([{ id: 'a', accountType: 'CHEQUING' }]);
    getSecurities.mockResolvedValue([]);

    await expect(resolveTourRequirements()).resolves.toEqual({
      transactionEntry: true,
      accountsExist: true,
      securitiesExist: false,
      ownerView: true,
    });
  });

  it('reports no account to open a detail page for when the list is empty', async () => {
    await expect(resolveTourRequirements()).resolves.toMatchObject({
      transactionEntry: false,
      accountsExist: false,
    });
  });

  it('counts only accounts that have a dedicated detail page', async () => {
    // An account type with no registered detail view has no Details action to
    // open, so a step asking the user to open one would wait for a route change
    // they cannot make -- even though they do have an account to record against.
    getAllAccounts.mockResolvedValue([{ id: 'a', accountType: 'NOT_A_TYPE' }]);

    await expect(resolveTourRequirements()).resolves.toMatchObject({
      transactionEntry: true,
      accountsExist: false,
    });
  });

  it('asks the account list once for both of its answers', async () => {
    // Two requests could disagree; one cannot.
    await resolveTourRequirements();
    expect(getAllAccounts).toHaveBeenCalledTimes(1);
  });

  it('asks only for active securities, as the list shows by default', async () => {
    await resolveTourRequirements();
    expect(getSecurities).toHaveBeenCalledWith();
  });

  it('excludes closed accounts from the account check', async () => {
    await resolveTourRequirements();
    expect(getAllAccounts).toHaveBeenCalledWith(false);
  });

  it('assumes a requirement is met when its lookup fails', async () => {
    getSecurities.mockRejectedValue(new Error('offline'));

    // A network blip must not silently hide a tour the user can take; a step
    // with nothing to point at is handled gracefully, a missing tour is not.
    await expect(resolveTourRequirements()).resolves.toMatchObject({
      securitiesExist: true,
    });
  });

  it('survives a lookup that throws instead of rejecting', async () => {
    // The case that broke CI: a test file mocking `investmentsApi` without
    // `getSecurities` makes the call itself throw, so `.catch()` on the returned
    // promise is never reached and the rejection escapes the hook that asked.
    // Whatever the cause, failing to decide which tours to offer must not be
    // able to take a page down.
    getSecurities.mockImplementation(() => {
      throw new TypeError('investmentsApi.getSecurities is not a function');
    });

    await expect(resolveTourRequirements()).resolves.toMatchObject({
      securitiesExist: true,
    });
  });

  it('does not let one failed lookup mask the other answer', async () => {
    getAllAccounts.mockRejectedValue(new Error('offline'));
    getSecurities.mockResolvedValue([]);

    // A failed account list answers neither account question, so both fall back
    // together rather than reporting a user with no accounts.
    await expect(resolveTourRequirements()).resolves.toEqual({
      transactionEntry: true,
      accountsExist: true,
      securitiesExist: false,
      ownerView: true,
    });
  });

  it('survives an account lookup that throws instead of rejecting', async () => {
    getAllAccounts.mockImplementation(() => {
      throw new TypeError('accountsApi.getAll is not a function');
    });

    await expect(resolveTourRequirements()).resolves.toMatchObject({
      transactionEntry: true,
      accountsExist: true,
    });
  });
});

describe('isTourOfferable', () => {
  it('always offers an ungated tour, even before the lookup resolves', () => {
    expect(isTourOfferable(tour(), null)).toBe(true);
  });

  it('offers a gated tour once its requirement is met', () => {
    expect(
      isTourOfferable(tour({ requiresData: 'securitiesExist' }), {
        transactionEntry: true,
        accountsExist: true,
        securitiesExist: true,
        ownerView: true,
      }),
    ).toBe(true);
  });

  it('withholds a gated tour whose requirement is not met', () => {
    expect(
      isTourOfferable(tour({ requiresData: 'securitiesExist' }), {
        transactionEntry: true,
        accountsExist: true,
        securitiesExist: false,
        ownerView: true,
      }),
    ).toBe(false);
  });

  it('withholds a gated tour until the lookup resolves', () => {
    // Offering it and taking it away again would be worse than a short wait.
    expect(
      isTourOfferable(tour({ requiresData: 'securitiesExist' }), null),
    ).toBe(false);
  });

  it('reads the requirement the tour actually names', () => {
    expect(
      isTourOfferable(tour({ requiresData: 'transactionEntry' }), {
        transactionEntry: false,
        accountsExist: false,
        securitiesExist: true,
        ownerView: true,
      }),
    ).toBe(false);
  });

  it('hides an owner-only tour from a delegate view', () => {
    const requirements = {
      transactionEntry: true,
      accountsExist: true,
      securitiesExist: true,
      ownerView: false,
    };
    expect(
      isTourOfferable(tour({ requiresData: 'ownerView' }), requirements),
    ).toBe(false);
    expect(
      isTourOfferable(tour({ requiresData: 'ownerView' }), {
        ...requirements,
        ownerView: true,
      }),
    ).toBe(true);
  });
});
