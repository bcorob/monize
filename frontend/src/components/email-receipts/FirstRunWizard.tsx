'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { CheckCircleIcon } from '@heroicons/react/24/solid';
import { buttonClassName } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import type { EmailReceiptsOverview } from '@/types/email-receipts';

interface FirstRunWizardProps {
  overview: EmailReceiptsOverview;
  /** Stored emails of every status. */
  stored: number;
}

interface Step {
  key: 'mailbox' | 'emails' | 'profile' | 'review';
  done: boolean;
  href: string;
}

/**
 * The four steps from nothing to the first proposal: connect a mailbox, let (or
 * make) it fetch emails, create and approve a profile for a sender, then review what
 * it proposed. Which step is done is read from the overview (a connected mailbox, a
 * stored email, an approved profile); the last step has no state of its own and is a
 * pointer to the review inbox. It is drawn until the first three are done, then it
 * gets out of the way: a person past the first run has the cards.
 */
export function FirstRunWizard({ overview, stored }: FirstRunWizardProps) {
  const t = useTranslations('emailReceipts.wizard');
  const steps: Step[] = [
    { key: 'mailbox', done: overview.mailbox !== null && overview.mailbox.connected, href: '/email-receipts?tab=mailbox' },
    { key: 'emails', done: stored > 0, href: '/email-receipts?tab=emails' },
    { key: 'profile', done: overview.parsers.approved > 0, href: '/email-receipts?tab=profiles' },
    { key: 'review', done: false, href: '/ai-reviews?kind=email_receipt' },
  ];
  if (steps.slice(0, 3).every((step) => step.done)) return null;
  // The step to do now: the first that is not done.
  const current = steps.find((step) => !step.done)?.key;

  return (
    <Card padding="md" aria-labelledby="email-receipts-wizard-heading">
      <h2 id="email-receipts-wizard-heading" className="text-lg font-semibold text-gray-900 dark:text-gray-100">
        {t('heading')}
      </h2>
      <p className="mb-4 mt-1 text-sm text-gray-600 dark:text-gray-400">{t('intro')}</p>
      <ol className="space-y-4">
        {steps.map((step, index) => (
          <li key={step.key} className="flex gap-3">
            <span
              aria-hidden
              className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                step.done
                  ? 'text-green-600 dark:text-green-400'
                  : step.key === current
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-200 text-gray-700 dark:bg-gray-700 dark:text-gray-200'
              }`}
            >
              {step.done ? <CheckCircleIcon className="h-6 w-6" /> : index + 1}
            </span>
            <div className="min-w-0">
              <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
                {t(`steps.${step.key}.title`)}
                {step.done && <span className="sr-only"> {t('done')}</span>}
              </p>
              <p className="mt-0.5 text-sm text-gray-600 dark:text-gray-400">{t(`steps.${step.key}.body`)}</p>
              {(step.key === current || step.key === 'review') && (
                <Link href={step.href} className={`${buttonClassName(step.key === current ? 'primary' : 'outline', 'sm')} mt-2 inline-flex`}>
                  {t(`steps.${step.key}.action`)}
                </Link>
              )}
            </div>
          </li>
        ))}
      </ol>
    </Card>
  );
}
