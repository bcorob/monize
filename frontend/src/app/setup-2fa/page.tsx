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
  const { preferences } = usePreferencesStore();

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
        onComplete={() => router.push('/dashboard')}
      />
    </AuthShell>
  );
}
