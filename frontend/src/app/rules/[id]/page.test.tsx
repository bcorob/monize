import { describe, it, expect, vi } from 'vitest';
import { render, screen, act } from '@/test/render';
import EditRulePage from './page';
import { makeRule } from '@/components/rules/rules-test-fixtures';

const rules = vi.hoisted(() => ({ getById: vi.fn(), getApplications: vi.fn().mockResolvedValue([]) }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useParams: () => ({ id: 'rule-42' }),
  usePathname: () => '/rules/rule-42',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/components/auth/ProtectedRoute', () => ({
  ProtectedRoute: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));
vi.mock('@/lib/transaction-rules-api', () => ({ transactionRulesApi: rules }));
vi.mock('@/lib/accounts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/accounts')>()),
  accountsApi: { getAll: vi.fn().mockResolvedValue([]) },
}));
vi.mock('@/lib/payees', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/payees')>()),
  payeesApi: { getAll: vi.fn().mockResolvedValue([]) },
}));
vi.mock('@/lib/categories', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/categories')>()),
  categoriesApi: { getAll: vi.fn().mockResolvedValue([]) },
}));
vi.mock('@/lib/tags', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tags')>()),
  tagsApi: { getAll: vi.fn().mockResolvedValue([{ id: 'tag-1', name: 'Coffee' }]) },
}));
vi.mock('@/lib/exchange-rates', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/exchange-rates')>()),
  exchangeRatesApi: { getCurrencies: vi.fn().mockResolvedValue([{ code: 'CAD', isActive: true }]) },
}));

describe('EditRulePage', () => {
  it('loads the rule named by the route', async () => {
    rules.getById.mockResolvedValue(makeRule({ id: 'rule-42', name: 'From the route', condition: { all: [] } }));
    await act(async () => {
      render(<EditRulePage />);
    });
    expect(rules.getById).toHaveBeenCalledWith('rule-42');
    expect(screen.getByRole('heading', { level: 1, name: 'Edit rule' })).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveValue('From the route');
  });
});
