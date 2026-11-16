import { describe, it, expect, vi } from 'vitest';
import { render, screen, act } from '@/test/render';
import NewRulePage from './page';

vi.mock('@/components/auth/ProtectedRoute', () => ({
  ProtectedRoute: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));
vi.mock('@/lib/transaction-rules-api', () => ({ transactionRulesApi: { getById: vi.fn() } }));
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
  tagsApi: { getAll: vi.fn().mockResolvedValue([]) },
}));
vi.mock('@/lib/exchange-rates', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/exchange-rates')>()),
  exchangeRatesApi: { getCurrencies: vi.fn().mockResolvedValue([{ code: 'CAD', isActive: true }]) },
}));

describe('NewRulePage', () => {
  it('renders the editor for a new rule under a way back to the list', async () => {
    await act(async () => {
      render(<NewRulePage />);
    });
    expect(screen.getByRole('heading', { level: 1, name: 'New rule' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to Rules' })).toHaveAttribute('href', '/rules');
    expect(screen.getByLabelText('Name')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Save rule' })).toBeInTheDocument();
  });
});
