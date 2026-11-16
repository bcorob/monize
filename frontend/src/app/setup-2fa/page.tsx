'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { TwoFactorSetup } from '@/components/auth/TwoFactorSetup';
import { AuthShell } from '@/components/auth/AuthShell';
import { usePreferencesStore } from '@/store/preferencesStore';

export default function Setup2FAPage() {
  const t = useTranslations('auth.register.twoFactor');
  const router = useRouter();
  const { preferences, updatePreferences } = usePreferencesStore();

  // If 2FA is already enabled, redirect to dashboard
  useEffect(() => {
    if (preferences?.twoFactorEnabled) {
      router.push('/dashboard');
    }
  }, [preferences, router]);

  if (preferences?.twoFactorEnabled) {
    return null;
  }

  return (
    <AuthShell title={t('title')} subtitle={t('requiredSubtitle')}>
      <TwoFactorSetup
        isForced
        onComplete={() => {
          // Record the enrolment in the store before leaving: ProtectedRoute
          // reads `preferences.twoFactorEnabled` to decide whether FORCE_2FA
          // still owes a setup, and a stale `false` sends the user straight
          // back here to enrol again.
          updatePreferences({ twoFactorEnabled: true });
          router.push('/dashboard');
        }}
      />
    </AuthShell>
  );
}
