'use client';

import { DelegateSectionGuard } from '@/components/auth/DelegateSectionGuard';

export default function WarrantiesSectionLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <DelegateSectionGuard section="warranties">
      {children}
    </DelegateSectionGuard>
  );
}
