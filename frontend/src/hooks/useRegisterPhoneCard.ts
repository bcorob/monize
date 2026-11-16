'use client';

import { useDensityPreference, type DensityView } from '@/store/densityStore';
import { useIsMobile } from '@/hooks/useIsMobile';

/**
 * Whether the transaction register draws each row as the phone card (Model B):
 * on a phone, density picks the LAYOUT rather than only the row height. At
 * Normal each row is a wrapped two-line card that shows more of the register
 * than a phone-width tier table can without scrolling sideways; Compact and
 * Dense keep the tier table, unchanged, and so does every non-phone width.
 *
 * The foreign-currency fee surfaces (`showFxColumns`) keep the tier table on a
 * phone: their whole subject is the paid-currency, paid-amount and fee
 * columns, which the card does not carry, so wrapping there would hide the
 * very data the surface exists to show.
 *
 * One predicate for the list that draws the card and the page that resolves a
 * remembered sort on a column the card does not show, so the two cannot
 * disagree about which layout is on screen.
 */
export function useRegisterPhoneCard(densityView: DensityView, showFxColumns: boolean): boolean {
  const { density } = useDensityPreference(densityView);
  const isMobile = useIsMobile();
  return isMobile && density === 'normal' && !showFxColumns;
}
