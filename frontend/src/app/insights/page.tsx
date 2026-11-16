'use client';

import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { PageLayout } from '@/components/layout/PageLayout';
import { InsightsList } from '@/components/insights/InsightsList';

export default function InsightsPage() {
  return (
    <ProtectedRoute>
      <PageLayout>
        <main className="px-4 sm:px-6 lg:px-12 pt-6 pb-8">
          {/* The list draws its own PageHeader: Refresh, a screen-level
              action, belongs in the header and acts on the list's state. */}
          <InsightsList />
        </main>
      </PageLayout>
    </ProtectedRoute>
  );
}
