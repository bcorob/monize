'use client';

import { useParams } from 'next/navigation';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { RuleEditorScreen } from '@/components/rules/RuleEditorScreen';

export default function EditRulePage() {
  const params = useParams<{ id: string }>();

  return (
    <ProtectedRoute>
      {/* Another id is another rule: start its editor from scratch. */}
      <RuleEditorScreen key={params.id} ruleId={params.id} />
    </ProtectedRoute>
  );
}
