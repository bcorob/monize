-- Widen the budget-alert fingerprint with the flex group (audit A26-L39).
--
-- A flex-group warning is budget-wide: budget_category_id is NULL, and the
-- group it is about lives only in `data`. Keyed on (budget, period, type,
-- category, severity), two flex groups over 90 percent in one period shared
-- one fingerprint, so the second group's warning was refused by
-- `NotificationService.create`'s ON CONFLICT DO NOTHING and never raised.
-- `deduplicateAlerts` (budget-alert.service.ts) matches on the same group.
--
-- Widening a unique key cannot create a conflict among existing rows (every
-- pair distinct on the old key is distinct on the new one), so no preflight.
-- Alerts with no `flexGroup` key read '' and keep their old identity.
DROP INDEX IF EXISTS idx_notifications_fingerprint;
CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_fingerprint
    ON notifications(
        budget_id,
        period_start,
        alert_type,
        COALESCE(budget_category_id, '00000000-0000-0000-0000-000000000000'::uuid),
        severity,
        COALESCE(data->>'flexGroup', '')
    );
