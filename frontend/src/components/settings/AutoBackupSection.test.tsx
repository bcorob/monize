import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@/test/render';
import { AutoBackupSection } from './AutoBackupSection';

vi.mock('@/lib/backupApi', () => ({
  backupApi: {
    getAutoBackupSettings: vi.fn(),
    getAutoBackupCapability: vi.fn(),
    updateAutoBackupSettings: vi.fn(),
    validateFolder: vi.fn(),
    browseFolders: vi.fn(),
    runAutoBackup: vi.fn(),
    exportBackup: vi.fn(),
    restoreBackup: vi.fn(),
  },
}));

vi.mock('@/lib/errors', () => ({
  getErrorMessage: vi.fn((_error: unknown, fallback: string) => fallback),
}));

vi.mock('@/store/preferencesStore', () => ({
  usePreferencesStore: vi.fn((selector: (s: Record<string, unknown>) => unknown) =>
    selector({ preferences: { timezone: 'America/New_York' } }),
  ),
}));

const mockUseDemoMode = vi.fn(() => false);
vi.mock('@/hooks/useDemoMode', () => ({
  useDemoMode: () => mockUseDemoMode(),
}));

import { backupApi } from '@/lib/backupApi';
import toast from 'react-hot-toast';

const defaultSettings = {
  enabled: false,
  folderPath: '',
  frequency: 'daily' as const,
  backupTime: '02:00',
  timezone: 'America/New_York',
  retentionDaily: 7,
  retentionWeekly: 4,
  retentionMonthly: 6,
  lastBackupAt: null,
  lastBackupStatus: null,
  lastBackupError: null,
  nextBackupAt: null,
};

// A capability whose store has a folder to choose: the `local` default every
// test that is not about the store itself assumes.
const localCapability = {
  available: true,
  folderPath: '/data/backups',
  locationSelectable: true,
  storageProvider: 'local',
};

async function renderAutoBackupSection() {
  let result: ReturnType<typeof render>;
  await act(async () => {
    result = render(<AutoBackupSection />);
  });
  return result!;
}

describe('AutoBackupSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseDemoMode.mockReturnValue(false);
    (
      backupApi.getAutoBackupCapability as ReturnType<typeof vi.fn>
    ).mockResolvedValue(localCapability);
    (backupApi.getAutoBackupSettings as ReturnType<typeof vi.fn>).mockResolvedValue(
      defaultSettings,
    );
  });

  it('renders the auto-backup section with default settings', async () => {
    await renderAutoBackupSection();

    expect(screen.getByText('Automatic Backup')).toBeInTheDocument();
    expect(screen.getByText('Enable automatic backups')).toBeInTheDocument();
    expect(screen.getByLabelText('Backup Folder')).toHaveValue('');
    expect(screen.getByLabelText('Backup Frequency')).toHaveValue('daily');
  });

  it('shows loading state initially', async () => {
    (backupApi.getAutoBackupSettings as ReturnType<typeof vi.fn>).mockReturnValue(
      new Promise(() => {}),
    );

    // Rendered inside act even though the assertion is about the first paint:
    // the capability probe beside the settings load *does* resolve, and a bare
    // render leaves its state update outside act.
    await renderAutoBackupSection();

    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });

  it('shows error toast on load failure', async () => {
    (backupApi.getAutoBackupSettings as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Load failed'),
    );

    await renderAutoBackupSection();

    expect(toast.error).toHaveBeenCalledWith('Failed to load auto-backup settings');
  });

  it('populates form with existing settings', async () => {
    (backupApi.getAutoBackupSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...defaultSettings,
      enabled: true,
      folderPath: '/backups',
      frequency: 'weekly',
      retentionDaily: 14,
      retentionWeekly: 8,
      retentionMonthly: 12,
    });

    await renderAutoBackupSection();

    const toggle = screen.getByRole('switch', { name: 'Enable automatic backups' });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByLabelText('Backup Folder')).toHaveValue('/backups');
    expect(screen.getByLabelText('Backup Frequency')).toHaveValue('weekly');
    expect(screen.getByLabelText('Daily backups')).toHaveValue('14');
    expect(screen.getByLabelText('Weekly backups')).toHaveValue('8');
    expect(screen.getByLabelText('Monthly backups')).toHaveValue('12');
  });

  it('enables save button when form is dirty', async () => {
    await renderAutoBackupSection();

    const saveButton = screen.getByText('Save Policy');
    expect(saveButton).toBeDisabled();

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Backup Folder'), {
        target: { value: '/backups' },
      });
    });

    expect(saveButton).not.toBeDisabled();
  });

  it('validates folder path', async () => {
    (backupApi.validateFolder as ReturnType<typeof vi.fn>).mockResolvedValue({
      valid: true,
    });

    await renderAutoBackupSection();

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Backup Folder'), {
        target: { value: '/backups' },
      });
    });

    await act(async () => {
      fireEvent.click(screen.getByText('Validate'));
    });

    await waitFor(() => {
      expect(backupApi.validateFolder).toHaveBeenCalledWith('/backups');
      expect(toast.success).toHaveBeenCalledWith('Folder is valid and writable');
    });
  });

  it('shows validation error for invalid folder', async () => {
    (backupApi.validateFolder as ReturnType<typeof vi.fn>).mockResolvedValue({
      valid: false,
      error: 'Folder does not exist',
    });

    await renderAutoBackupSection();

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Backup Folder'), {
        target: { value: '/invalid' },
      });
    });

    await act(async () => {
      fireEvent.click(screen.getByText('Validate'));
    });

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Folder does not exist');
    });
  });

  it('saves settings on save button click', async () => {
    (backupApi.updateAutoBackupSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...defaultSettings,
      folderPath: '/backups',
    });

    await renderAutoBackupSection();

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Backup Folder'), {
        target: { value: '/backups' },
      });
    });

    await act(async () => {
      fireEvent.click(screen.getByText('Save Policy'));
    });

    await waitFor(() => {
      expect(backupApi.updateAutoBackupSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          folderPath: '/backups',
          frequency: 'daily',
          retentionDaily: 7,
          retentionWeekly: 4,
          retentionMonthly: 6,
        }),
      );
      expect(toast.success).toHaveBeenCalledWith('Backup policy saved and applied to every account');
    });
  });

  it('shows error toast on save failure', async () => {
    (backupApi.updateAutoBackupSettings as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Save failed'),
    );

    await renderAutoBackupSection();

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Backup Folder'), {
        target: { value: '/backups' },
      });
    });

    await act(async () => {
      fireEvent.click(screen.getByText('Save Policy'));
    });

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to save settings');
    });
  });

  it('offers the run even where the store has no folder to configure', async () => {
    // Gating this on a stored folder hid the button entirely on every object
    // store deployment, which has none. Whether the store can be written to is
    // the capability's answer, not the settings row's.
    await renderAutoBackupSection();

    expect(screen.getByText('Back Up Every Account Now')).toBeInTheDocument();
  });

  it('runs a backup of every account and reports the count', async () => {
    (backupApi.getAutoBackupSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...defaultSettings,
      folderPath: '/backups',
    });
    (backupApi.runAutoBackup as ReturnType<typeof vi.fn>).mockResolvedValue({
      message: 'Backed up 3 of 3 account(s)',
      usersRequested: 3,
      usersBackedUp: 3,
      usersSkipped: 0,
      usersFailed: 0,
      usersPartial: 0,
      filename: 'monize-backup-daily-2026-04-02.json.gz',
    });

    await renderAutoBackupSection();

    await act(async () => {
      fireEvent.click(screen.getByText('Back Up Every Account Now'));
    });

    await waitFor(() => {
      expect(backupApi.runAutoBackup).toHaveBeenCalled();
      expect(toast.success).toHaveBeenCalledWith('Backed up 3 of 3 accounts');
    });
  });

  it('does not report a run that failed or wrote a partial as a success', async () => {
    (backupApi.runAutoBackup as ReturnType<typeof vi.fn>).mockResolvedValue({
      message: 'Backed up 2 of 3 account(s), 1 partial, 1 failed',
      usersRequested: 3,
      usersBackedUp: 2,
      usersSkipped: 0,
      usersFailed: 1,
      usersPartial: 1,
    });

    await renderAutoBackupSection();

    await act(async () => {
      fireEvent.click(screen.getByText('Back Up Every Account Now'));
    });

    await waitFor(() => {
      expect(toast.success).not.toHaveBeenCalled();
      expect(toast).toHaveBeenCalledWith(
        'Backed up 2 of 3: 1 partial, 1 failed. Check the status below.',
      );
    });
  });

  it('shows status section when last backup exists', async () => {
    (backupApi.getAutoBackupSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...defaultSettings,
      folderPath: '/backups',
      lastBackupAt: '2026-04-01T10:00:00Z',
      lastBackupStatus: 'success',
      nextBackupAt: '2026-04-02T10:00:00Z',
    });

    await renderAutoBackupSection();

    // Deployment-wide: the most recent run of any account and the soonest
    // next one, not the signed-in administrator's own row.
    expect(screen.getByText('Deployment Status')).toBeInTheDocument();
    expect(screen.getByText('Most recent backup')).toBeInTheDocument();
    expect(screen.getByText('Success')).toBeInTheDocument();
    expect(screen.getByText('Next scheduled backup')).toBeInTheDocument();
  });

  it('shows error details when last backup failed', async () => {
    (backupApi.getAutoBackupSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...defaultSettings,
      folderPath: '/backups',
      lastBackupAt: '2026-04-01T10:00:00Z',
      lastBackupStatus: 'failed',
      lastBackupError: 'Folder not writable',
    });

    await renderAutoBackupSection();

    expect(screen.getByText('Failed')).toBeInTheDocument();
    expect(screen.getByText('Folder not writable')).toBeInTheDocument();
  });

  it('changes frequency selection', async () => {
    await renderAutoBackupSection();

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Backup Frequency'), {
        target: { value: 'every6hours' },
      });
    });

    expect(screen.getByLabelText('Backup Frequency')).toHaveValue('every6hours');
  });

  it('changes retention values', async () => {
    await renderAutoBackupSection();

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Daily backups'), {
        target: { value: '14' },
      });
    });

    expect(screen.getByLabelText('Daily backups')).toHaveValue('14');
  });

  it('disables validate button when folder path is empty', async () => {
    await renderAutoBackupSection();

    expect(screen.getByText('Validate')).toBeDisabled();
  });

  it('renders backup time field with default value', async () => {
    await renderAutoBackupSection();

    const timeInput = screen.getByLabelText('Backup Time (America/New_York)');
    expect(timeInput).toBeInTheDocument();
    expect(timeInput).toHaveValue('02:00');
  });

  it('populates backup time from settings', async () => {
    (backupApi.getAutoBackupSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...defaultSettings,
      backupTime: '14:30',
    });

    await renderAutoBackupSection();

    expect(screen.getByLabelText('Backup Time (America/New_York)')).toHaveValue('14:30');
  });

  it('includes backupTime when saving settings', async () => {
    (backupApi.updateAutoBackupSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...defaultSettings,
      backupTime: '08:00',
    });

    await renderAutoBackupSection();

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Backup Time (America/New_York)'), {
        target: { value: '08:00' },
      });
    });

    await act(async () => {
      fireEvent.click(screen.getByText('Save Policy'));
    });

    await waitFor(() => {
      expect(backupApi.updateAutoBackupSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          backupTime: '08:00',
        }),
      );
    });
  });

  it('displays timezone from user preferences in backup time label', async () => {
    await renderAutoBackupSection();

    expect(screen.getByLabelText('Backup Time (America/New_York)')).toBeInTheDocument();
  });

  it('sends timezone when saving settings', async () => {
    (backupApi.updateAutoBackupSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...defaultSettings,
      folderPath: '/backups',
    });

    await renderAutoBackupSection();

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Backup Folder'), {
        target: { value: '/backups' },
      });
    });

    await act(async () => {
      fireEvent.click(screen.getByText('Save Policy'));
    });

    await waitFor(() => {
      expect(backupApi.updateAutoBackupSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          timezone: 'America/New_York',
        }),
      );
    });
  });

  it('shows Browse button for folder selection', async () => {
    await renderAutoBackupSection();

    expect(screen.getByText('Browse...')).toBeInTheDocument();
  });

  it('opens folder browser and displays directories', async () => {
    (backupApi.browseFolders as ReturnType<typeof vi.fn>).mockResolvedValue({
      current: '/',
      directories: ['backups', 'data', 'tmp'],
    });

    await renderAutoBackupSection();

    await act(async () => {
      fireEvent.click(screen.getByText('Browse...'));
    });

    await waitFor(() => {
      expect(backupApi.browseFolders).toHaveBeenCalledWith('/');
      expect(screen.getByText('backups')).toBeInTheDocument();
      expect(screen.getByText('data')).toBeInTheDocument();
      expect(screen.getByText('tmp')).toBeInTheDocument();
    });
  });

  it('keeps browse panel open when folder has no subdirectories', async () => {
    (backupApi.browseFolders as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        current: '/',
        directories: ['backups'],
      })
      .mockResolvedValueOnce({
        current: '/backups',
        directories: [],
      });

    await renderAutoBackupSection();

    await act(async () => {
      fireEvent.click(screen.getByText('Browse...'));
    });

    await waitFor(() => {
      expect(screen.getByText('backups')).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByText('backups'));
    });

    await waitFor(() => {
      expect(screen.getByText('No subdirectories')).toBeInTheDocument();
      expect(screen.getByText('Select This Folder')).toBeInTheDocument();
    });
  });

  it('navigates into a subdirectory when clicked', async () => {
    (backupApi.browseFolders as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        current: '/',
        directories: ['backups', 'data'],
      })
      .mockResolvedValueOnce({
        current: '/backups',
        directories: ['daily', 'weekly'],
      });

    await renderAutoBackupSection();

    await act(async () => {
      fireEvent.click(screen.getByText('Browse...'));
    });

    await waitFor(() => {
      expect(screen.getByText('backups')).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByText('backups'));
    });

    await waitFor(() => {
      expect(backupApi.browseFolders).toHaveBeenCalledWith('/backups');
      expect(screen.getByText('daily')).toBeInTheDocument();
    });
  });

  describe('per-user folder', () => {
    it("shows where this user's backups actually land", async () => {
      (backupApi.getAutoBackupSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...defaultSettings,
        folderPath: '/data/backups',
        resolvedFolderPath:
          '/data/backups/12/34/12345678-1234-1234-1234-123456789abc',
      });

      await renderAutoBackupSection();

      // The folder field holds the base; the files go in a per-user folder
      // underneath it, so showing the base alone would send an admin looking
      // in a directory that only contains shard directories.
      expect(
        screen.getByText(
          /Example: \/data\/backups\/12\/34\/12345678-1234-1234-1234-123456789abc/,
        ),
      ).toBeInTheDocument();
    });

    it('still explains the layout when the server sent no resolved folder', async () => {
      await renderAutoBackupSection();

      expect(
        screen.getAllByText(/their own folder inside this one/).length,
      ).toBeGreaterThan(0);
    });

    it('says the policy is administrator-only and governs every account', async () => {
      await renderAutoBackupSection();

      expect(
        screen.getByText(/Only administrators can change this policy/),
      ).toBeInTheDocument();
      expect(
        screen.getByText(/governs every account on this deployment/),
      ).toBeInTheDocument();
    });

    it('says how many accounts the policy covers', async () => {
      // "Daily at 02:00" over a count of 1 on a twelve-account instance is the
      // defect this line makes visible.
      (backupApi.getAutoBackupSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...defaultSettings,
        accountCount: 12,
        scheduledAccountCount: 12,
      });

      await renderAutoBackupSection();

      expect(
        screen.getByText(
          'Scheduled on 12 of 12 active accounts on this deployment.',
        ),
      ).toBeInTheDocument();
    });

    it('does not invent a coverage count the server did not send', async () => {
      await renderAutoBackupSection();

      expect(
        screen.getByText('How far this policy reaches is not available.'),
      ).toBeInTheDocument();
    });

    it('shows the gap when the policy has not reached every account', async () => {
      // A single number could only have been the total, which states coverage
      // the deployment does not have.
      (backupApi.getAutoBackupSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...defaultSettings,
        accountCount: 12,
        scheduledAccountCount: 11,
      });

      await renderAutoBackupSection();

      expect(
        screen.getByText(
          'Scheduled on 11 of 12 active accounts on this deployment.',
        ),
      ).toBeInTheDocument();
    });
  });

  /**
   * Which store is bound is a fact an operator needs whether or not they may
   * change it, and on an object store the storage row is the only place it is
   * stated. It used to be stated nowhere: the section rendered a folder input,
   * a Browse and a Validate against endpoints that refuse on `s3`, posted a
   * folderPath that failed every save, and hid the run button entirely because
   * an object store stores no folder.
   */
  describe('which store is in use', () => {
    it('names the local folder store and keeps the folder picker', async () => {
      await renderAutoBackupSection();

      expect(screen.getByText('Local folder')).toBeInTheDocument();
      expect(screen.getByLabelText('Backup Folder')).toBeInTheDocument();
      expect(screen.getByText('Browse...')).toBeInTheDocument();
    });

    it('names the object store and hides the folder controls on it', async () => {
      (
        backupApi.getAutoBackupCapability as ReturnType<typeof vi.fn>
      ).mockResolvedValue({
        available: true,
        folderPath: 's3://monize-backups/store/',
        locationSelectable: false,
        storageProvider: 's3',
        artifactCount: 4,
      });

      await renderAutoBackupSection();

      expect(
        screen.getByText('S3-compatible object storage'),
      ).toBeInTheDocument();
      expect(screen.getByText('s3://monize-backups/store/')).toBeInTheDocument();
      expect(screen.queryByLabelText('Backup Folder')).not.toBeInTheDocument();
      expect(screen.queryByText('Browse...')).not.toBeInTheDocument();
      expect(screen.queryByText('Validate')).not.toBeInTheDocument();
      // The run is still offered: an object store has no folder, and gating on
      // one hid the button on every `s3` deployment.
      expect(screen.getByText('Back Up Every Account Now')).toBeInTheDocument();
    });

    it('sends no folderPath on a store that refuses one', async () => {
      (
        backupApi.getAutoBackupCapability as ReturnType<typeof vi.fn>
      ).mockResolvedValue({
        available: true,
        folderPath: 's3://monize-backups/store/',
        locationSelectable: false,
        storageProvider: 's3',
      });
      (
        backupApi.updateAutoBackupSettings as ReturnType<typeof vi.fn>
      ).mockResolvedValue(defaultSettings);

      await renderAutoBackupSection();

      await act(async () => {
        fireEvent.change(screen.getByLabelText('Backup Frequency'), {
          target: { value: 'weekly' },
        });
      });
      await act(async () => {
        fireEvent.click(screen.getByText('Save Policy'));
      });

      await waitFor(() => {
        expect(backupApi.updateAutoBackupSettings).toHaveBeenCalledWith(
          expect.not.objectContaining({ folderPath: expect.anything() }),
        );
      });
    });

    it('says how many artifacts the current store already holds', async () => {
      (
        backupApi.getAutoBackupCapability as ReturnType<typeof vi.fn>
      ).mockResolvedValue({ ...localCapability, artifactCount: 0 });

      await renderAutoBackupSection();

      // Zero is a number, not an absence: switching store is forward-only, so
      // an empty new store is the thing an operator most needs to see.
      expect(
        screen.getByText(/currently holds 0 backup files/),
      ).toBeInTheDocument();
    });
  });

  /**
   * Saving an enabled schedule already fails when the deployment cannot write --
   * the server creates the directory and probes it. But that happens only after
   * the user has chosen a frequency, a time and a retention policy and pressed
   * save, and the answer never depended on any of those. The capability endpoint
   * exists so the section can say so first; the server refusal stays the
   * authoritative guard.
   */
  describe('when the deployment has no backup storage', () => {
    beforeEach(() => {
      (
        backupApi.getAutoBackupCapability as ReturnType<typeof vi.fn>
      ).mockResolvedValue({
        available: false,
        folderPath: '/data/backups',
        reason: 'EROFS: read-only file system',
      });
    });

    it('says so, and names the folder', async () => {
      await renderAutoBackupSection();

      // Scoped to the banner: the section's own intro copy also mentions
      // /data/backups, so an unscoped query matches both and proves nothing
      // about the banner.
      const banner = await screen.findByRole('status');
      expect(banner).toHaveTextContent(/no backup storage/i);
      expect(banner).toHaveTextContent('/data/backups');
    });

    it('disables the enable toggle rather than letting the save fail', async () => {
      await renderAutoBackupSection();
      await screen.findByRole('status');

      const toggle = screen.getByRole('switch');
      expect(toggle).toBeDisabled();
    });

    /**
     * The first version of the banner disabled the toggle unconditionally, which
     * is wrong in the case that matters most: storage that *used* to work. A
     * volume unmounted or turned read-only leaves a schedule armed and failing,
     * and the user arrives at this screen wanting to switch it off. Disabling
     * the control in both directions leaves them looking at a setting they can
     * see is broken and cannot change (F3RRR-005).
     */
    it('still lets the user switch an already-armed schedule off', async () => {
      (
        backupApi.getAutoBackupSettings as ReturnType<typeof vi.fn>
      ).mockResolvedValue({
        ...defaultSettings,
        enabled: true,
        folderPath: '/data/backups',
      });
      (
        backupApi.updateAutoBackupSettings as ReturnType<typeof vi.fn>
      ).mockResolvedValue({ ...defaultSettings, enabled: false });

      await renderAutoBackupSection();
      await screen.findByRole('status');

      const toggle = screen.getByRole('switch');
      expect(toggle).not.toBeDisabled();

      await act(async () => {
        fireEvent.click(toggle);
      });
      await act(async () => {
        fireEvent.click(screen.getByText('Save Policy'));
      });

      // Off has to reach the server, not merely the local state -- the schedule
      // runs from the stored row.
      expect(backupApi.updateAutoBackupSettings).toHaveBeenCalledWith(
        expect.objectContaining({ enabled: false }),
      );
    });

    it('does not offer a backup run that has nowhere to write', async () => {
      (
        backupApi.getAutoBackupSettings as ReturnType<typeof vi.fn>
      ).mockResolvedValue({
        ...defaultSettings,
        enabled: true,
        folderPath: '/data/backups',
      });

      await renderAutoBackupSection();
      await screen.findByRole('status');

      expect(
        screen.getByRole('button', { name: 'Back Up Every Account Now' }),
      ).toBeDisabled();
    });
  });

  describe('when the capability cannot be read', () => {
    it('fails open: a capability read that errors does not lock the controls', async () => {
      // A capability probe we could not read is not a refusal (maintainer
      // finding). Blocking here on a transient error, or on a backend that
      // predates the endpoint (rolling deploy), would strand the toggle and Run
      // Now with no way back; the server still creates and probes the folder on
      // save, so it stays the authoritative guard.
      (
        backupApi.getAutoBackupSettings as ReturnType<typeof vi.fn>
      ).mockResolvedValue({
        ...defaultSettings,
        enabled: false,
        folderPath: '/data/backups',
      });
      (
        backupApi.getAutoBackupCapability as ReturnType<typeof vi.fn>
      ).mockRejectedValue(new Error('network'));

      await renderAutoBackupSection();
      await act(async () => {}); // flush the capability rejection handler

      await waitFor(() => {
        expect(screen.getByRole('switch')).not.toBeDisabled();
      });
      expect(
        screen.getByText('Back Up Every Account Now').closest('button'),
      ).not.toBeDisabled();
      // A failed read is not a definitive "unavailable", so no banner either.
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
    });

    it('still lets an already-enabled schedule be switched off when storage is unavailable', async () => {
      // The other direction: a user whose backups have started failing must be
      // able to turn them off. A persisted-enabled schedule stays interactive
      // even when the capability is unavailable (uses the persisted state, not
      // the mutable toggle).
      (
        backupApi.getAutoBackupSettings as ReturnType<typeof vi.fn>
      ).mockResolvedValue({
        ...defaultSettings,
        enabled: true,
        folderPath: '/data/backups',
      });
      (
        backupApi.getAutoBackupCapability as ReturnType<typeof vi.fn>
      ).mockResolvedValue({
        available: false,
        folderPath: '/data/backups',
        reason: 'not writable',
      });

      await renderAutoBackupSection();

      await waitFor(() => {
        expect(screen.getByRole('switch')).not.toBeDisabled();
      });
    });
  });

  describe('re-reads capability after actions that can change it', () => {
    it('re-checks after a folder validates, clearing a stale no-storage banner', async () => {
      // Capability is read once at mount; without a re-check, pointing at a
      // writable alternate folder and validating it leaves the toggle disabled
      // until a full save (maintainer finding). A successful validate re-probes.
      (
        backupApi.getAutoBackupSettings as ReturnType<typeof vi.fn>
      ).mockResolvedValue({
        ...defaultSettings,
        enabled: false,
        folderPath: '/data/backups',
      });
      (backupApi.getAutoBackupCapability as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ available: false, folderPath: '/data/backups' })
        .mockResolvedValueOnce({ available: true, folderPath: '/data/backups' });
      (backupApi.validateFolder as ReturnType<typeof vi.fn>).mockResolvedValue({
        valid: true,
      });

      await renderAutoBackupSection();
      await screen.findByRole('status');

      await act(async () => {
        fireEvent.change(screen.getByLabelText('Backup Folder'), {
          target: { value: '/data/backups' },
        });
      });
      await act(async () => {
        fireEvent.click(screen.getByText('Validate'));
      });

      await waitFor(() => {
        expect(backupApi.getAutoBackupCapability).toHaveBeenCalledTimes(2);
      });
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
      expect(screen.getByRole('switch')).not.toBeDisabled();
    });

    it('re-checks after settings are saved', async () => {
      // The saved folder is what the server now probes, so capability is re-read
      // against it rather than leaving the mount-time answer on screen.
      (
        backupApi.getAutoBackupSettings as ReturnType<typeof vi.fn>
      ).mockResolvedValue({
        ...defaultSettings,
        enabled: false,
        folderPath: '/data/backups',
      });
      (backupApi.getAutoBackupCapability as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ available: false, folderPath: '/data/backups' })
        .mockResolvedValueOnce({ available: true, folderPath: '/new' });
      (
        backupApi.updateAutoBackupSettings as ReturnType<typeof vi.fn>
      ).mockResolvedValue({ ...defaultSettings, folderPath: '/new' });

      await renderAutoBackupSection();
      await screen.findByRole('status');

      await act(async () => {
        fireEvent.change(screen.getByLabelText('Backup Folder'), {
          target: { value: '/new' },
        });
      });
      await act(async () => {
        fireEvent.click(screen.getByText('Save Policy'));
      });

      await waitFor(() => {
        expect(backupApi.getAutoBackupCapability).toHaveBeenCalledTimes(2);
      });
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
    });
  });

  /**
   * The four mutating AutoBackupController endpoints (validate-folder,
   * browse-folders, run-auto-backup, PATCH auto-backup-settings) are
   * @DemoRestricted, so in demo mode the controls that reach them can only ever
   * error. Disable them (with the enable toggle) rather than hide them -- a
   * control the user is looking at is disabled, not removed.
   */
  describe('in demo mode', () => {
    it('disables Save, Validate, Run and Browse and the enable toggle', async () => {
      mockUseDemoMode.mockReturnValue(true);
      (
        backupApi.getAutoBackupSettings as ReturnType<typeof vi.fn>
      ).mockResolvedValue({
        ...defaultSettings,
        enabled: true,
        folderPath: '/data/backups',
      });

      await renderAutoBackupSection();

      expect(screen.getByRole('switch')).toBeDisabled();
      expect(screen.getByText('Browse...').closest('button')).toBeDisabled();
      expect(screen.getByText('Validate').closest('button')).toBeDisabled();
      expect(screen.getByText('Save Policy').closest('button')).toBeDisabled();
      expect(
        screen.getByRole('button', { name: 'Back Up Every Account Now' }),
      ).toBeDisabled();
      expect(
        screen.getByText(/read-only in demo mode/i),
      ).toBeInTheDocument();
    });

    it('leaves the controls enabled when not in demo mode', async () => {
      // A dirty form so Save's own precondition does not stand in for the demo
      // gate, a configured folder so Run and Validate are live.
      (
        backupApi.getAutoBackupSettings as ReturnType<typeof vi.fn>
      ).mockResolvedValue({
        ...defaultSettings,
        enabled: true,
        folderPath: '/data/backups',
      });

      await renderAutoBackupSection();

      await act(async () => {
        fireEvent.change(screen.getByLabelText('Backup Folder'), {
          target: { value: '/data/backups/new' },
        });
      });

      expect(screen.getByRole('switch')).not.toBeDisabled();
      expect(screen.getByText('Browse...').closest('button')).not.toBeDisabled();
      expect(screen.getByText('Validate').closest('button')).not.toBeDisabled();
      expect(
        screen.getByText('Save Policy').closest('button'),
      ).not.toBeDisabled();
      expect(
        screen.getByRole('button', { name: 'Back Up Every Account Now' }),
      ).not.toBeDisabled();
      expect(screen.queryByText(/read-only in demo mode/i)).not.toBeInTheDocument();
    });
  });
});
