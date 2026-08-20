import { useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { transferPayeeParams } from '@/lib/transfer-label';

interface PayeeDisplaySource {
  payeeName?: string | null;
  payee?: { name: string } | null;
  isTransfer?: boolean;
  amount: number | string;
  linkedTransaction?: { account?: { name: string } | null } | null;
}

/**
 * The one way a surface turns a transaction row into its payee display text.
 *
 * A stored payee wins (denormalized `payeeName` first, then the linked payee's
 * name, exactly as the register always has). A transfer leg with NO stored
 * payee resolves "Transfer to/from <account>" from the linked leg's account at
 * render time (issue #1214) -- localized via `common.transferPayee`, and
 * always the account's CURRENT name, so renames and language switches reach
 * every historical row. Returns null when there is nothing to show (the
 * caller renders its usual dash/empty state).
 */
export function usePayeeDisplay(): (tx: PayeeDisplaySource) => string | null {
  const t = useTranslations('common');
  return useCallback(
    (tx: PayeeDisplaySource) => {
      const stored = tx.payeeName || tx.payee?.name;
      if (stored) return stored;
      const params = transferPayeeParams(tx);
      if (!params) return null;
      return t('transferPayee', params);
    },
    [t],
  );
}
