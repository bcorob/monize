import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/render';
import TaxesPage from './page';

vi.mock('@/components/auth/ProtectedRoute', () => ({
  ProtectedRoute: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@/components/layout/PageLayout', () => ({
  PageLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

describe('TaxesPage', () => {
  it('lists the tax tools as links, Payroll Deductions first', () => {
    render(<TaxesPage />);
    expect(screen.getByRole('heading', { name: 'Taxes' })).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /Payroll Deductions/ });
    expect(link).toHaveAttribute('href', '/taxes/payroll-deductions');
    expect(screen.getByText(/yearly maximums on deductions/i)).toBeInTheDocument();
  });
});
