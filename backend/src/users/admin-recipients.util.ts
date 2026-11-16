import { EntityManager } from "typeorm";

/**
 * One administrator a deployment-wide operational fact can be told about.
 *
 * `emailEnabled` folds the two email preconditions into one flag: an address
 * exists AND email notifications are not switched off. In-app surfaces
 * (system alert rows) address every active administrator regardless; only the
 * email leg filters on the flag.
 */
export interface AdminRecipient {
  userId: string;
  email: string | null;
  firstName: string;
  emailEnabled: boolean;
}

/**
 * The administrators of this deployment, oldest first.
 *
 * A system-level issue (a failed backup, a provider outage, a missing
 * encryption key) is a deployment-wide operational fact, not one user's
 * finance: it goes to whoever administers the install, which on a personal
 * deployment is its single user. Delegate-only identities have no inbox of
 * their own to speak of and are excluded, as they are from admin user
 * management.
 *
 * This is the one place the recipient predicate is written --
 * `ProviderOutageAlertService` and `SystemAlertService` both ask here, so the
 * two surfaces cannot drift on who counts as an administrator. Callers that
 * email filter on `emailEnabled`; callers that write in-app rows take the
 * whole list.
 *
 * Runs under whatever context the caller seeded; both callers are
 * cross-user sweeps under `withSystemContext`.
 */
export async function queryAdminRecipients(
  manager: EntityManager,
): Promise<AdminRecipient[]> {
  const rows: Array<{
    id: string;
    email: string | null;
    first_name: string | null;
    email_enabled: boolean;
  }> = await manager.query(
    `SELECT u.id,
            u.email,
            u.first_name,
            (u.email IS NOT NULL
             AND u.email <> ''
             AND COALESCE(p.notification_email, true) = true) AS email_enabled
       FROM users u
       LEFT JOIN user_preferences p ON p.user_id = u.id
      WHERE u.role = 'admin'
        AND u.is_active = true
        AND u.is_delegate_only = false
      ORDER BY u.created_at`,
  );
  return rows.map((row) => ({
    userId: row.id,
    email: row.email && row.email !== "" ? row.email : null,
    firstName: row.first_name ?? "",
    emailEnabled: row.email_enabled === true,
  }));
}
