'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { RefreshPricesButton } from '@/components/reports/RefreshPricesButton';
import type { Account } from '@/types/account';

interface InvestmentDetailActionsProps {
  /**
   * The account the page is about. It is always the brokerage (or standalone)
   * half: `AccountDetailPage` redirects a linked cash id to its partner before
   * anything renders.
   */
  account: Account;
  /** Prices are written to the DB, so the body must re-fetch to show them. */
  onRefreshComplete: () => void;
}

/**
 * The investment detail page's header actions, rendered on the title row via
 * `AccountDetailShell`'s `headerActions` rather than as a second row above the
 * body.
 */
export function InvestmentDetailActions({
  account,
  onRefreshComplete,
}: InvestmentDetailActionsProps) {
  const t = useTranslations('accountDetail-investment');
  const router = useRouter();

  return (
    <>
      <RefreshPricesButton size="md" onRefreshComplete={onRefreshComplete} />
      {/* A closed account is filtered out of the portfolio /investments works
          from (`getInvestmentAccounts` takes `isClosed: false`), so the link
          would drop its account filter and show the whole portfolio instead of
          this account. There is nowhere for it to go, so it is not offered. */}
      {!account.isClosed && (
        <Button
          variant="outline"
          onClick={() => router.push(`/investments?accountId=${account.id}`)}
        >
          {t('openInInvestments')}
        </Button>
      )}
    </>
  );
}
