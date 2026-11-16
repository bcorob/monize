import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/render';
import BillsLayout from './bills/layout';
import InvestmentsLayout from './investments/layout';
import BudgetsLayout from './budgets/layout';
import ReportsLayout from './reports/layout';
import InsightsLayout from './insights/layout';
import AiLayout from './ai/layout';
import WarrantiesLayout from './warranties/layout';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
}));

// Non-delegate by default: the guard passes children straight through.
let mockAuthState: {
  actingAsUserId: string | null;
  delegateSections: Record<string, boolean> | null;
} = { actingAsUserId: null, delegateSections: null };

vi.mock('@/store/authStore', () => ({
  useAuthStore: (selector: (s: unknown) => unknown) => selector(mockAuthState),
}));

describe('section route layouts', () => {
  beforeEach(() => {
    mockAuthState = { actingAsUserId: null, delegateSections: null };
  });

  it('render their children for a non-delegate', () => {
    const layouts = [
      ['bills', BillsLayout],
      ['investments', InvestmentsLayout],
      ['budgets', BudgetsLayout],
      ['reports', ReportsLayout],
      ['insights', InsightsLayout],
      ['ai', AiLayout],
      ['warranties', WarrantiesLayout],
    ] as const;
    for (const [name, Layout] of layouts) {
      const { unmount } = render(<Layout>{<p>{name}-child</p>}</Layout>);
      expect(screen.getByText(`${name}-child`)).toBeInTheDocument();
      unmount();
    }
  });

  it('gates the warranties section on its delegate grant', () => {
    mockAuthState = {
      actingAsUserId: 'owner-1',
      delegateSections: { warranties: true },
    };
    const granted = render(
      <WarrantiesLayout>
        <p>warranties-child</p>
      </WarrantiesLayout>,
    );
    expect(screen.getByText('warranties-child')).toBeInTheDocument();
    granted.unmount();

    mockAuthState = {
      actingAsUserId: 'owner-1',
      delegateSections: { warranties: false },
    };
    render(
      <WarrantiesLayout>
        <p>warranties-child</p>
      </WarrantiesLayout>,
    );
    expect(screen.queryByText('warranties-child')).not.toBeInTheDocument();
  });
});
