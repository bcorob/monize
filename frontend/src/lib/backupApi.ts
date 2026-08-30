import apiClient from './api';
import { clearAllCache } from './apiCache';
import { filenameFromContentDisposition } from './download';
import {
  AutoBackupCapability,
  AutoBackupSettings,
  UpdateAutoBackupSettingsData,
} from '@/types/auth';

// HTTP header values have their leading and trailing whitespace stripped in
// transit (RFC 7230 "optional whitespace"), which silently corrupts passwords
// that begin or end with a space. Base64-encode password header values so every
// byte -- including surrounding whitespace and non-ASCII characters -- survives
// the round trip. The backend decodes them with the matching scheme before any
// credential comparison.
function encodePasswordHeader(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/**
 * Short-lived authorization for one restore upload.
 *
 * The backend's upload admission runs in front of its body parser -- and so in
 * front of every guard -- which is why this exists: the ticket is minted by an
 * ordinary authenticated request and verified before any memory is reserved for
 * the upload. `header` travels with it so the client cannot drift from the server
 * on the header name.
 */
export interface RestoreUploadTicket {
  ticket: string;
  expiresInSeconds: number;
  header: string;
}

export interface RestoreResult {
  message: string;
  restored: Record<string, number>;
  /**
   * Attachments whose metadata was deliberately not restored because their
   * bytes could not be made reachable (absent from the sidecar volume/bucket,
   * failing their recorded checksum, or exported from an instance using a
   * different storage provider). Deliberately outside `restored`, whose values
   * are summed into a row total -- rows that were not written must not be
   * counted as written. Absent when nothing was skipped.
   */
  skippedAttachments?: number;
  /**
   * Restored AI provider rows left without a usable API key. Keys normally
   * travel decrypted and are re-encrypted on arrival, so this covers only a
   * backup written before that (its ciphertext belongs to another instance's
   * `ENCRYPTION_KEY`) or a server with no `ENCRYPTION_KEY` at all. The
   * rows *were* written, so this stays outside `restored` rather than being
   * deducted from it. Absent when none.
   */
  unusableAiProviderKeys?: number;
}

export type SupportBackupSection =
  | 'investments'
  | 'scheduled'
  | 'budgets'
  | 'reports'
  | 'importMappings'
  | 'autoBackup';

export const SUPPORT_BACKUP_SECTIONS: SupportBackupSection[] = [
  'investments',
  'scheduled',
  'budgets',
  'reports',
  'importMappings',
  'autoBackup',
];

export interface SupportBackupInput {
  multiplier: number;
  sections?: SupportBackupSection[];
  accountIds?: string[];
  /** Inclusive yyyy-MM-dd bounds on exported history. */
  dateFrom?: string;
  dateTo?: string;
  /** Price history is excluded by default: a full series can identify a
   *  masked ticker against public market data. */
  includePriceHistory?: boolean;
  /** Required: support backups always leave the machine encrypted. */
  password: string;
}

export interface SupportBackupFile {
  blob: Blob;
  /** Server-chosen filename (Content-Disposition), or null when absent. */
  filename: string | null;
}

export interface SupportBackupPreviewSample {
  table: string;
  before: Record<string, unknown>[];
  after: Record<string, unknown>[];
}

export interface SupportBackupPreview {
  samples: SupportBackupPreviewSample[];
}

/**
 * A random multiplier in [1.1, 9.99] with 5 decimal places, never an integer,
 * matching the backend contract: > 1 (so nothing rounds to zero) and
 * non-integer (so it can't be trivially guessed from a round value). Drawn
 * from the Web Crypto API -- the multiplier is the factor hiding the user's
 * real amounts, so it must not come from a predictable PRNG.
 */
export function randomSupportMultiplier(): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  const value = 1.1 + (buf[0] / 2 ** 32) * 8.89;
  const rounded = Math.round(value * 1e5) / 1e5;
  return Number.isInteger(rounded) ? rounded + 0.12345 : rounded;
}

/**
 * A random 20-character password from an unambiguous alphabet (no 0/O, 1/l/I),
 * generated with the Web Crypto API. Pre-fills the required encryption
 * password so a support backup never ships with a weak ad-hoc one; the user
 * can still edit or regenerate it.
 */
export function randomSupportPassword(): string {
  const alphabet = '23456789ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz';
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

/**
 * Axios delivers error bodies as Blobs when the request used
 * `responseType: 'blob'`, which hides the backend's JSON `message` from
 * getErrorMessage. Parse the Blob back into the response data so error
 * toasts show the real reason (demo restriction, validation error).
 */
async function normalizeBlobError(error: unknown): Promise<never> {
  const response = (error as { response?: { data?: unknown } })?.response;
  if (response && response.data instanceof Blob) {
    try {
      response.data = JSON.parse(await response.data.text());
    } catch {
      // Not JSON -- leave the Blob; the caller falls back to its default text.
    }
  }
  throw error;
}

export interface BackupEncryptionStatus {
  enabled: boolean;
  /**
   * Whether the dedicated backup-password controls belong to this user. False
   * for local-auth accounts: the server keeps a copy of the password they typed
   * at sign-in and encrypts with it, so there is no second password to invent.
   * True for OIDC accounts, which have no password of ours and must set a
   * dedicated backup password (or leave their backups unencrypted).
   */
  manageable: boolean;
  /**
   * Which password opens this user's backups. `login-password` for local
   * accounts, `backup-password` for OIDC ones. Mirrors the backend's
   * `BackupEncryptionStatus`.
   */
  method: 'login-password' | 'backup-password';
  /**
   * Whether the server holds key material to store a password at all. Off means
   * no backup this deployment writes can be encrypted, which is a different
   * thing from this user not having turned it on -- and the difference is the
   * whole point of showing it.
   */
  available: boolean;
}

// Error code surfaced by the backend when an encrypted backup can't be
// decrypted with any password we tried. Frontend uses this to prompt the
// user for the password the backup was originally made with.
export const BACKUP_PASSWORD_REQUIRED_CODE = 'BACKUP_PASSWORD_REQUIRED';

// Encrypted Monize backups begin with the ASCII magic "MZBE" (see the backend
// backup-crypto.util envelope format). Sniffing the first four bytes lets the
// restore UI show a backup-password field only when one is actually needed.
const MZBE_MAGIC = [0x4d, 0x5a, 0x42, 0x45];

export async function isEncryptedBackupFile(file: File): Promise<boolean> {
  try {
    const header = new Uint8Array(
      await file.slice(0, MZBE_MAGIC.length).arrayBuffer(),
    );
    if (
      header.length === MZBE_MAGIC.length &&
      MZBE_MAGIC.every((byte, i) => header[i] === byte)
    ) {
      return true;
    }
  } catch {
    // Reading the header failed (unusual); fall back to the extension below.
  }
  return file.name.toLowerCase().endsWith('.mzbe');
}

async function compressGzip(data: ArrayBuffer): Promise<Blob> {
  const stream = new Blob([data]).stream().pipeThrough(
    new CompressionStream('gzip'),
  );
  return new Response(stream).blob();
}

export const backupApi = {
  /**
   * The artifact, plus whether the server could actually include every
   * attachment it names. The completeness answer travels in headers rather than
   * the body, because the body is a gzip/encrypted stream (see the backend's
   * `markIncompleteExport`). A caller that ignores `complete` shows a plain
   * success for a download the server knows cannot restore every attachment --
   * the defect this return shape exists to make hard.
   */
  exportBackup: async (
    encryptionPassword?: string,
  ): Promise<{
    blob: Blob;
    complete: boolean;
    expectedAttachments: number;
    /** Attachments the server actually wrote into the artifact. */
    includedAttachments: number;
    /** Rows whose bytes are absent from the artifact entirely. */
    missingAttachments: number;
    /**
     * Rows whose bytes are present but contradict their own metadata, so they
     * cannot be trusted either -- a different diagnosis from absent bytes.
     */
    inconsistentAttachments: number;
  }> => {
    const headers: Record<string, string> = {};
    if (encryptionPassword) {
      headers['X-Export-Password'] = encodePasswordHeader(encryptionPassword);
    }
    const response = await apiClient.post('/backup/export', {}, {
      responseType: 'blob',
      timeout: 120000,
      headers,
    });
    // Axios lowercases response header names, so index them lowercase (matching
    // the `content-disposition` read in supportExport below). A malformed or
    // duplicated numeric header parses to NaN; treat that as zero rather than
    // letting a "NaN of NaN attachment(s)" reach the incomplete-export toast.
    const count = (name: string): number => {
      const parsed = Number(response.headers?.[name]);
      return Number.isFinite(parsed) ? parsed : 0;
    };
    return {
      blob: response.data,
      // Absent marker means complete: only an incomplete export sets the header,
      // so an old server or a header-stripping proxy reads as complete rather
      // than as a false alarm on every download.
      complete: String(response.headers?.['x-backup-complete']) !== 'false',
      expectedAttachments: count('x-backup-attachments-expected'),
      includedAttachments: count('x-backup-attachments-included'),
      missingAttachments: count('x-backup-attachments-missing'),
      inconsistentAttachments: count('x-backup-attachments-inconsistent'),
    };
  },

  supportExport: async (input: SupportBackupInput): Promise<SupportBackupFile> => {
    try {
      const response = await apiClient.post('/backup/support-export', input, {
        responseType: 'blob',
        timeout: 120000,
      });
      return {
        blob: response.data,
        filename: filenameFromContentDisposition(
          response.headers['content-disposition'] as string | undefined,
        ),
      };
    } catch (error) {
      return normalizeBlobError(error);
    }
  },

  supportExportPreview: async (
    input: SupportBackupInput,
  ): Promise<SupportBackupPreview> => {
    const response = await apiClient.post<SupportBackupPreview>(
      '/backup/support-export/preview',
      input,
      { timeout: 120000 },
    );
    return response.data;
  },

  // Short-lived authorization for one restore upload. The header name comes back
  // with the ticket so the client cannot drift from the server on it.
  mintRestoreUploadTicket: async (): Promise<RestoreUploadTicket> => {
    const response = await apiClient.post<RestoreUploadTicket>(
      '/backup/restore/ticket',
      {},
    );
    return response.data;
  },

  restoreBackup: async (params: {
    file: File;
    password?: string;
    oidcIdToken?: string;
    backupPassword?: string;
  }): Promise<RestoreResult> => {
    // Three accepted file shapes:
    //   *.mzbe       -> Monize encrypted envelope, sent as-is
    //   *.gz/*.json.gz -> already gzipped, sent as-is
    //   anything else -> assume raw JSON, gzip it client-side
    const ext = params.file.name.toLowerCase();
    const isEncrypted = ext.endsWith('.mzbe');
    const isAlreadyCompressed = isEncrypted || ext.endsWith('.gz');
    const body = isAlreadyCompressed
      ? params.file
      : await compressGzip(await params.file.arrayBuffer());

    // The upload's memory admission runs in front of the body parser, which is in
    // front of every backend guard -- so it cannot authenticate the request it is
    // budgeting for. This ticket is how authorization gets there first: an upload
    // without one is refused 403 before a byte is buffered. Minted here rather
    // than at page load because it is short-lived, and the file picker and any
    // password prompt happen before this call.
    const ticket = await backupApi.mintRestoreUploadTicket();

    const headers: Record<string, string> = {
      'Content-Type': isEncrypted ? 'application/octet-stream' : 'application/gzip',
      [ticket.header]: ticket.ticket,
    };
    if (params.password) {
      headers['X-Restore-Password'] = encodePasswordHeader(params.password);
    }
    if (params.oidcIdToken) {
      headers['X-Restore-OIDC-Token'] = params.oidcIdToken;
    }
    if (params.backupPassword) {
      headers['X-Backup-Password'] = encodePasswordHeader(params.backupPassword);
    }

    const response = await apiClient.post<RestoreResult>(
      '/backup/restore',
      body,
      { headers, timeout: 300000 },
    );
    // A restore replaces the whole dataset; nothing cached from before it is
    // still true.
    clearAllCache();
    return response.data;
  },

  getEncryptionStatus: async (): Promise<BackupEncryptionStatus> => {
    const response = await apiClient.get<BackupEncryptionStatus>(
      '/backup/encryption',
    );
    return response.data;
  },

  // Set/clear the dedicated backup password. OIDC accounts only -- the backend
  // rejects a local-auth caller, whose password is recaptured at every login.
  setBackupPassword: async (backupPassword: string): Promise<void> => {
    await apiClient.post('/backup/encryption/backup-password', {
      backupPassword,
    });
  },

  // Turn on encryption for a local account by confirming the login password it
  // already has. The sign-in capture is the primary path; this exists for a
  // session that outlived the deploy which shipped it, where nothing would
  // otherwise ask for the password again.
  enableWithLoginPassword: async (loginPassword: string): Promise<void> => {
    await apiClient.post('/backup/encryption/login-password', {
      loginPassword,
    });
  },

  disableEncryption: async (): Promise<void> => {
    await apiClient.delete('/backup/encryption');
  },

  getAutoBackupSettings: async (): Promise<AutoBackupSettings> => {
    const response = await apiClient.get<AutoBackupSettings>('/backup/auto-backup-settings');
    return response.data;
  },

  /**
   * Whether this deployment can write an automatic backup at all. Saving an
   * enabled schedule already fails when it cannot -- the server creates the
   * directory and probes it -- but only after the user has chosen a frequency,
   * a time and a retention policy and pressed save, and the answer never
   * depended on any of that. This lets the section say so first.
   */
  getAutoBackupCapability: async (): Promise<AutoBackupCapability> => {
    const response = await apiClient.get<AutoBackupCapability>(
      '/backup/auto-backup-capability',
    );
    return response.data;
  },

  updateAutoBackupSettings: async (
    data: UpdateAutoBackupSettingsData,
  ): Promise<AutoBackupSettings> => {
    const response = await apiClient.patch<AutoBackupSettings>(
      '/backup/auto-backup-settings',
      data,
    );
    return response.data;
  },

  validateFolder: async (
    folderPath: string,
  ): Promise<{ valid: boolean; error?: string }> => {
    const response = await apiClient.post<{ valid: boolean; error?: string }>(
      '/backup/validate-folder',
      { folderPath },
    );
    return response.data;
  },

  browseFolders: async (
    path: string,
  ): Promise<{ current: string; directories: string[] }> => {
    const response = await apiClient.post<{ current: string; directories: string[] }>(
      '/backup/browse-folders',
      { folderPath: path },
    );
    return response.data;
  },

  runAutoBackup: async (): Promise<{ message: string; filename: string }> => {
    const response = await apiClient.post<{ message: string; filename: string }>(
      '/backup/run-auto-backup',
    );
    return response.data;
  },
};
