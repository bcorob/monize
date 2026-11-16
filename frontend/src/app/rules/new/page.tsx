'use client';

import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { RuleEditorScreen } from '@/components/rules/RuleEditorScreen';

export default function NewRulePage() {
  return (
    <ProtectedRoute>
      <RuleEditorScreen />
    </ProtectedRoute>
  );
}
