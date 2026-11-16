import type { ApiClient } from '../helpers/api';
import { need, security, loadLookups, indexByName, type Named } from './seed-lookup';

// The records the pictures open by id. Looked up by name, so the specs after
// `01-seed` need no state from it beyond the data it left on the server.

export interface Ids {
  chequing: string;
  mortgage: string;
  vehicle: string;
  carLoan: string;
  visa: string;
  voo: string;
  tim: string;
  restaurants: string;
  budget: string;
}

export async function loadIds(api: ApiClient): Promise<Ids> {
  const lookups = await loadLookups(api);
  const budgets = indexByName(await api.get<Named[]>('/budgets'));
  const budget = [...budgets.values()][0];
  if (!budget) throw new Error('The instance has no budget. Run readme/01-seed.spec.ts first.');
  return {
    chequing: need(lookups.accounts, 'Primary Chequing', 'account').id,
    mortgage: need(lookups.accounts, 'Home Mortgage', 'account').id,
    vehicle: need(lookups.accounts, 'Vehicle', 'account').id,
    carLoan: need(lookups.accounts, 'Car Loan', 'account').id,
    visa: need(lookups.accounts, 'Visa Rewards', 'account').id,
    voo: security(lookups, 'VOO').id,
    tim: need(lookups.payees, 'Tim Hortons', 'payee').id,
    restaurants: need(lookups.categories, 'Restaurants', 'category').id,
    budget: budget.id,
  };
}
