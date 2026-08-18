import type { ColorTheme } from '@/lib/color-themes';

/**
 * The acting-context profile (`GET /auth/profile`, `GET /users/me`). While a
 * delegate is acting for an owner, the backend intentionally omits the owner's
 * credential-state fields (`hasPassword`, `mustChangePassword`,
 * `isDelegateOnly`, `backupEncryptionEnabled`) -- so they are optional here,
 * and any guard reading them must treat absence as "unknown", not as false.
 * Credential controls belong on the authenticated user's own profile from
 * `GET /auth/me-self`, which is `SelfUserProfile`.
 */
export interface User {
  id: string;
  email: string;
  firstName?: string;
  lastName?: string;
  authProvider: 'local' | 'oidc';
  hasPassword?: boolean;
  role: 'admin' | 'user';
  isActive: boolean;
  mustChangePassword?: boolean;
  isDelegateOnly?: boolean;
  backupEncryptionEnabled?: boolean;
  emailVerified?: boolean;
  createdAt: string;
  updatedAt: string;
  lastLogin?: string;
}

/**
 * The authenticated user's OWN profile (`GET /auth/me-self`, and the `user`
 * in auth responses): always a complete row, so the credential-state
 * booleans are guaranteed present.
 */
export type SelfUserProfile = User &
  Required<
    Pick<
      User,
      | 'hasPassword'
      | 'mustChangePassword'
      | 'isDelegateOnly'
      | 'backupEncryptionEnabled'
    >
  >;

export interface AdminUser {
  id: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  authProvider: 'local' | 'oidc';
  hasPassword: boolean;
  role: 'admin' | 'user';
  isActive: boolean;
  mustChangePassword: boolean;
  createdAt: string;
  updatedAt: string;
  lastLogin: string | null;
}

type Assert<T extends true> = T;
type IsAssignable<From, To> = [From] extends [To] ? true : false;

/**
 * Administrators receive complete rows, so AdminUser keeps its
 * credential-state booleans *required* -- exactly as on the authenticated
 * user's own profile. AdminUser is deliberately not a full SelfUserProfile
 * (its identification fields are nullable, and the admin list omits
 * delegate-only rows), so the shared contract asserted here is exactly the
 * credential state. This is a frontend-side consistency check between two
 * frontend types; the backend's own return annotations are the cross-package
 * half of the guarantee.
 */
type _AdminUserCarriesRequiredCredentialState = Assert<
  IsAssignable<
    Pick<AdminUser, 'hasPassword' | 'mustChangePassword'>,
    Pick<SelfUserProfile, 'hasPassword' | 'mustChangePassword'>
  >
>;

export interface LoginCredentials {
  email: string;
  password: string;
  rememberMe?: boolean;
}

export interface RegisterData {
  email: string;
  password: string;
  firstName?: string;
  lastName?: string;
  /**
   * Temporary password supplied by the registrant when their email is
   * already a delegate row (so they can claim and upgrade it into a full
   * account, preserving the existing delegate id).
   */
  currentPassword?: string;
}

export interface AuthResponse {
  user?: User;
  requires2FA?: boolean;
  tempToken?: string;
  /** Login was rejected because the account's email is not yet verified. */
  emailNotVerified?: boolean;
  /** Registration succeeded but the user must verify their email before logging in. */
  verificationRequired?: boolean;
}

export interface TwoFactorSetupResponse {
  secret: string;
  qrCodeDataUrl: string;
  otpauthUrl: string;
}

export interface BackupCodesResponse {
  codes: string[];
}

export interface TrustedDevice {
  id: string;
  deviceName: string;
  ipAddress: string | null;
  lastUsedAt: string;
  expiresAt: string;
  createdAt: string;
  isCurrent?: boolean;
}

export interface AuthState {
  user: User | null;
  token: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;
}

export interface UserPreferences {
  userId: string;
  defaultCurrency: string;
  dateFormat: string; // 'browser' = use browser locale
  numberFormat: string; // 'browser' = use browser locale
  theme: 'light' | 'dark' | 'system';
  colorTheme: ColorTheme;
  timezone: string; // 'browser' = use browser timezone
  notificationEmail: boolean;
  notificationBrowser: boolean;
  twoFactorEnabled: boolean;
  gettingStartedDismissed: boolean;
  weekStartsOn: number; // 0=Sunday, 1=Monday, ..., 6=Saturday
  budgetDigestEnabled: boolean;
  budgetDigestDay: 'MONDAY' | 'FRIDAY';
  favouriteReportIds: string[];
  dashboardWidgets: string[]; // ordered visible widget ids; empty = default layout
  dashboardWidgetConfig: Record<string, Record<string, unknown>>; // per-widget settings keyed by widget id
  showCreatedAt: boolean;
  timeFormat: '24h' | '12h';
  preferredExchanges: string[];
  defaultQuoteProvider: 'yahoo' | 'msn';
  recentTransactionsLimit: number;
  aiBubbleEnabled: boolean;
  showWhatsNew: boolean;
  /**
   * Strict reconciled lock. False (the default) keeps Money's behaviour: the
   * transaction form warns before an edit that would move a reconciled row's
   * date or amount and then lets it through. True makes the server refuse the
   * write outright -- an edit, a delete, or a status change away from
   * RECONCILED -- so the way to make one is to turn this off in Settings.
   */
  lockReconciledTransactions: boolean;
  language: string;
  createdAt: string;
  updatedAt: string;
}

export interface AutoBackupSettings {
  userId: string;
  enabled: boolean;
  folderPath: string;
  /**
   * Folder this user's backup files actually land in --
   * `<folderPath>/<ab>/<cd>/<userId>`. Server-computed and read-only; absent
   * when the configured base folder is unusable.
   */
  resolvedFolderPath?: string;
  frequency: 'daily' | 'every12hours' | 'every6hours' | 'weekly';
  backupTime: string;
  timezone: string;
  retentionDaily: number;
  retentionWeekly: number;
  retentionMonthly: number;
  lastBackupAt: string | null;
  lastBackupStatus: 'success' | 'partial' | 'failed' | null;
  lastBackupError: string | null;
  nextBackupAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Whether the deployment has somewhere to write automatic backups.
 *
 * This is a deployment capability, not a field from the acting-context user
 * profile or the user's settings row.
 */
export interface AutoBackupCapability {
  available: boolean;
  folderPath: string;
  /** Operator-facing detail when the capability is unavailable. */
  reason?: string;
}

export interface UpdateAutoBackupSettingsData {
  enabled?: boolean;
  folderPath?: string;
  frequency?: AutoBackupSettings['frequency'];
  backupTime?: string;
  timezone?: string;
  retentionDaily?: number;
  retentionWeekly?: number;
  retentionMonthly?: number;
}

export interface UpdateProfileData {
  firstName?: string;
  lastName?: string;
  email?: string;
  currentPassword?: string;
}

export interface UpdatePreferencesData {
  defaultCurrency?: string;
  dateFormat?: string;
  numberFormat?: string;
  theme?: 'light' | 'dark' | 'system';
  colorTheme?: ColorTheme;
  timezone?: string;
  notificationEmail?: boolean;
  notificationBrowser?: boolean;
  gettingStartedDismissed?: boolean;
  weekStartsOn?: number;
  budgetDigestEnabled?: boolean;
  budgetDigestDay?: 'MONDAY' | 'FRIDAY';
  favouriteReportIds?: string[];
  dashboardWidgets?: string[];
  dashboardWidgetConfig?: Record<string, Record<string, unknown>>;
  showCreatedAt?: boolean;
  timeFormat?: '24h' | '12h';
  preferredExchanges?: string[];
  defaultQuoteProvider?: 'yahoo' | 'msn';
  recentTransactionsLimit?: number;
  aiBubbleEnabled?: boolean;
  showWhatsNew?: boolean;
  lockReconciledTransactions?: boolean;
  language?: string;
}

export interface ChangePasswordData {
  currentPassword: string;
  newPassword: string;
}

export interface PersonalAccessToken {
  id: string;
  name: string;
  tokenPrefix: string;
  scopes: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  isRevoked: boolean;
  createdAt: string;
}

export interface CreatePatData {
  name: string;
  scopes?: string;
  expiresAt?: string;
}

export interface CreatePatResponse extends PersonalAccessToken {
  token: string;
}
