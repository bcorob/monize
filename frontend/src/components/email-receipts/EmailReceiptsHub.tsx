'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { EmailReceiptsManager } from '@/components/email-receipts/EmailReceiptsManager';
import { EmailReceiptsOverview } from '@/components/email-receipts/EmailReceiptsOverview';
import { MailboxSection } from '@/components/email-receipts/MailboxSection';
import { ParsersSection } from '@/components/email-receipts/ParsersSection';
import { TabPanel, Tabs } from '@/components/ui/Tabs';
import { useDemoMode } from '@/hooks/useDemoMode';
import { normalizeDomainFilter } from '@/lib/email-receipts-format';
import { TOUR_ANCHORS, tourAnchor } from '@/lib/tours/anchors';

export const EMAIL_RECEIPTS_TABS = ['overview', 'mailbox', 'profiles', 'emails'] as const;
export type EmailReceiptsTab = (typeof EMAIL_RECEIPTS_TABS)[number];

/**
 * The tab a URL names: `?tab=` if it is one of the four; otherwise the Emails tab
 * when the link carries `?domain=` (the page's older shape, still linked from the
 * review inbox and from notifications), otherwise the Overview.
 */
export function tabFromSearch(tab: string | null, hasDomain: boolean): EmailReceiptsTab {
  const named = EMAIL_RECEIPTS_TABS.find((candidate) => candidate === tab);
  if (named) return named;
  return hasDomain ? 'emails' : 'overview';
}

const ID_PREFIX = 'email-receipts';

/**
 * `/email-receipts`: one hub for everything about order-confirmation emails. The
 * selected tab lives in the URL (`?tab=`), so a link, a reload, the back button and
 * the OAuth callback's return all land on the right one; a tab is mounted only once
 * it is opened. The mailbox is a credential and the profiles are written against the
 * owner's own mail, so the demo account gets the explanation on those two tabs and none
 * of their controls.
 */
export function EmailReceiptsHub() {
  const t = useTranslations('emailReceipts.hub');
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const isDemoMode = useDemoMode();

  const tab = tabFromSearch(searchParams.get('tab'), searchParams.has('domain'));

  // `?tab=profiles&wizard=<domain>` keeps the profile wizard's domain in the URL.
  const wizardDomain = tab === 'profiles' ? normalizeDomainFilter(searchParams.get('wizard')) || null : null;

  const setWizardDomain = (next: string | null) => {
    const params = new URLSearchParams();
    params.set('tab', 'profiles');
    if (next) params.set('wizard', next);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };

  const selectTab = (next: EmailReceiptsTab) => {
    if (next === tab) return;
    // The sender filter belongs to the Emails tab; no other tab carries it away.
    const params = new URLSearchParams();
    params.set('tab', next);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };

  const demoNote = (
    <div className="rounded-lg border border-amber-200 bg-amber-50 p-6 dark:border-amber-800 dark:bg-amber-900/30">
      <h2 className="mb-2 text-lg font-semibold text-amber-800 dark:text-amber-200">{t('demoRestricted.heading')}</h2>
      <p className="text-sm text-amber-700 dark:text-amber-300">{t('demoRestricted.body')}</p>
    </div>
  );

  return (
    <div>
      <Tabs
        tabs={EMAIL_RECEIPTS_TABS.map((key) => ({ key, label: t(`tabs.${key}`) }))}
        value={tab}
        onChange={selectTab}
        idPrefix={ID_PREFIX}
        ariaLabel={t('tabs.ariaLabel')}
        anchorProps={tourAnchor(TOUR_ANCHORS.emailReceiptsTabs)}
      />
      <div className="pt-4">
        <TabPanel idPrefix={ID_PREFIX} tabKey="overview" isActive={tab === 'overview'}>
          <EmailReceiptsOverview />
        </TabPanel>
        <TabPanel idPrefix={ID_PREFIX} tabKey="mailbox" isActive={tab === 'mailbox'}>
          {isDemoMode ? demoNote : <MailboxSection />}
        </TabPanel>
        <TabPanel idPrefix={ID_PREFIX} tabKey="profiles" isActive={tab === 'profiles'}>
          {isDemoMode ? (
            demoNote
          ) : (
            <ParsersSection
              wizardDomain={wizardDomain}
              onWizardDomainChange={setWizardDomain}
              onOpenEmails={() => selectTab('emails')}
            />
          )}
        </TabPanel>
        <TabPanel idPrefix={ID_PREFIX} tabKey="emails" isActive={tab === 'emails'}>
          <EmailReceiptsManager />
        </TabPanel>
      </div>
    </div>
  );
}
