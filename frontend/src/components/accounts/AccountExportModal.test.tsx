import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@/test/render';
import { AccountExportModal } from './AccountExportModal';
import { accountsApi } from '@/lib/accounts';
import { usePreferencesStore } from '@/store/preferencesStore';
import toast from 'react-hot-toast';

vi.mock('@/lib/accounts', () => ({
  accountsApi: {
    exportAccount: vi.fn(),
  },
}));

vi.mock('react-hot-toast');

const defaultProps = {
  isOpen: true,
  onClose: vi.fn(),
  accountId: 'account-1',
  accountName: 'Chequing',
};

describe('AccountExportModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    usePreferencesStore.setState({
      preferences: {
        dateFormat: 'YYYY-MM-DD',
      } as any,
      isLoaded: true,
    });
  });

  it('renders modal when isOpen is true', () => {
    render(<AccountExportModal {...defaultProps} />);
    expect(screen.getByText('Export Chequing')).toBeInTheDocument();
    expect(screen.getByLabelText('Format')).toBeInTheDocument();
    expect(screen.getByLabelText('Date format')).toBeInTheDocument();
  });

  it('does not render content when isOpen is false', () => {
    render(<AccountExportModal {...defaultProps} isOpen={false} />);
    expect(screen.queryByText('Export Chequing')).not.toBeInTheDocument();
  });

  it('shows split option only when CSV format is selected', () => {
    render(<AccountExportModal {...defaultProps} />);

    // CSV is default, split option should be visible
    expect(screen.getByLabelText('Split transactions')).toBeInTheDocument();

    // Switch to QIF
    fireEvent.change(screen.getByLabelText('Format'), { target: { value: 'qif' } });
    expect(screen.queryByLabelText('Split transactions')).not.toBeInTheDocument();

    // Switch back to CSV
    fireEvent.change(screen.getByLabelText('Format'), { target: { value: 'csv' } });
    expect(screen.getByLabelText('Split transactions')).toBeInTheDocument();
  });

  it('shows custom format input only when Custom is selected', () => {
    render(<AccountExportModal {...defaultProps} />);

    expect(screen.queryByLabelText('Custom format')).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Date format'), { target: { value: 'custom' } });
    expect(screen.getByLabelText('Custom format')).toBeInTheDocument();
    expect(screen.getByText(/Use Y for year/)).toBeInTheDocument();
  });

  it('defaults date format to user preference', () => {
    usePreferencesStore.setState({
      preferences: {
        dateFormat: 'DD/MM/YYYY',
      } as any,
      isLoaded: true,
    });

    render(<AccountExportModal {...defaultProps} />);
    const select = screen.getByLabelText('Date format') as HTMLSelectElement;
    expect(select.value).toBe('DD/MM/YYYY');
  });

  it('calls exportAccount with correct CSV params on export', async () => {
    vi.mocked(accountsApi.exportAccount).mockResolvedValue(undefined);

    render(<AccountExportModal {...defaultProps} />);

    await act(async () => {
      fireEvent.click(screen.getByText('Export'));
    });

    await waitFor(() => {
      expect(accountsApi.exportAccount).toHaveBeenCalledWith(
        'account-1',
        'csv',
        { expandSplits: true, dateFormat: 'YYYY-MM-DD' },
      );
    });
  });

  it('calls exportAccount with QIF format', async () => {
    vi.mocked(accountsApi.exportAccount).mockResolvedValue(undefined);

    render(<AccountExportModal {...defaultProps} />);

    fireEvent.change(screen.getByLabelText('Format'), { target: { value: 'qif' } });

    await act(async () => {
      fireEvent.click(screen.getByText('Export'));
    });

    await waitFor(() => {
      expect(accountsApi.exportAccount).toHaveBeenCalledWith(
        'account-1',
        'qif',
        { expandSplits: undefined, dateFormat: 'YYYY-MM-DD' },
      );
    });
  });

  it('calls exportAccount with collapsed splits when selected', async () => {
    vi.mocked(accountsApi.exportAccount).mockResolvedValue(undefined);

    render(<AccountExportModal {...defaultProps} />);

    fireEvent.change(screen.getByLabelText('Split transactions'), { target: { value: 'collapse' } });

    await act(async () => {
      fireEvent.click(screen.getByText('Export'));
    });

    await waitFor(() => {
      expect(accountsApi.exportAccount).toHaveBeenCalledWith(
        'account-1',
        'csv',
        { expandSplits: false, dateFormat: 'YYYY-MM-DD' },
      );
    });
  });

  it('shows error toast when custom format is empty', async () => {
    render(<AccountExportModal {...defaultProps} />);

    fireEvent.change(screen.getByLabelText('Date format'), { target: { value: 'custom' } });

    await act(async () => {
      fireEvent.click(screen.getByText('Export'));
    });

    expect(toast.error).toHaveBeenCalledWith('Please enter a custom date format');
    expect(accountsApi.exportAccount).not.toHaveBeenCalled();
  });

  it('uses custom format when provided', async () => {
    vi.mocked(accountsApi.exportAccount).mockResolvedValue(undefined);

    render(<AccountExportModal {...defaultProps} />);

    fireEvent.change(screen.getByLabelText('Date format'), { target: { value: 'custom' } });
    fireEvent.change(screen.getByLabelText('Custom format'), { target: { value: 'DD.MM.YYYY' } });

    await act(async () => {
      fireEvent.click(screen.getByText('Export'));
    });

    await waitFor(() => {
      expect(accountsApi.exportAccount).toHaveBeenCalledWith(
        'account-1',
        'csv',
        { expandSplits: true, dateFormat: 'DD.MM.YYYY' },
      );
    });
  });

  it('calls onClose after successful export', async () => {
    vi.mocked(accountsApi.exportAccount).mockResolvedValue(undefined);

    render(<AccountExportModal {...defaultProps} />);

    await act(async () => {
      fireEvent.click(screen.getByText('Export'));
    });

    await waitFor(() => {
      expect(defaultProps.onClose).toHaveBeenCalled();
    });
  });

  it('shows error toast on export failure', async () => {
    vi.mocked(accountsApi.exportAccount).mockRejectedValue(new Error('Network error'));

    render(<AccountExportModal {...defaultProps} />);

    await act(async () => {
      fireEvent.click(screen.getByText('Export'));
    });

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalled();
    });
    expect(defaultProps.onClose).not.toHaveBeenCalled();
  });

  it('shows success toast on successful export', async () => {
    vi.mocked(accountsApi.exportAccount).mockResolvedValue(undefined);

    render(<AccountExportModal {...defaultProps} />);

    await act(async () => {
      fireEvent.click(screen.getByText('Export'));
    });

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Exported as CSV');
    });
  });

  it('shows success toast with QIF format name', async () => {
    vi.mocked(accountsApi.exportAccount).mockResolvedValue(undefined);

    render(<AccountExportModal {...defaultProps} />);

    fireEvent.change(screen.getByLabelText('Format'), { target: { value: 'qif' } });

    await act(async () => {
      fireEvent.click(screen.getByText('Export'));
    });

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Exported as QIF');
    });
  });

  it('uses browser date format when preference is browser', async () => {
    vi.mocked(accountsApi.exportAccount).mockResolvedValue(undefined);

    usePreferencesStore.setState({
      preferences: {
        dateFormat: 'browser',
      } as any,
      isLoaded: true,
    });

    render(<AccountExportModal {...defaultProps} />);

    await act(async () => {
      fireEvent.click(screen.getByText('Export'));
    });

    await waitFor(() => {
      expect(accountsApi.exportAccount).toHaveBeenCalledWith(
        'account-1',
        'csv',
        expect.objectContaining({ dateFormat: expect.any(String) }),
      );
    });
    // dateFormat should be a resolved string, not 'browser'
    const callArgs = vi.mocked(accountsApi.exportAccount).mock.calls[0][2];
    expect(callArgs?.dateFormat).not.toBe('browser');
  });

  it('defaults to browser date format when preferences are missing', async () => {
    vi.mocked(accountsApi.exportAccount).mockResolvedValue(undefined);

    usePreferencesStore.setState({
      preferences: null as any,
      isLoaded: true,
    });

    render(<AccountExportModal {...defaultProps} />);

    const select = screen.getByLabelText('Date format') as HTMLSelectElement;
    expect(select.value).toBe('browser');

    await act(async () => {
      fireEvent.click(screen.getByText('Export'));
    });

    await waitFor(() => {
      expect(accountsApi.exportAccount).toHaveBeenCalledWith(
        'account-1',
        'csv',
        expect.objectContaining({ dateFormat: expect.any(String) }),
      );
    });
    const callArgs = vi.mocked(accountsApi.exportAccount).mock.calls[0][2];
    expect(callArgs?.dateFormat).not.toBe('browser');
  });

  it('shows error for whitespace-only custom date format', async () => {
    render(<AccountExportModal {...defaultProps} />);

    fireEvent.change(screen.getByLabelText('Date format'), { target: { value: 'custom' } });
    fireEvent.change(screen.getByLabelText('Custom format'), { target: { value: '   ' } });

    await act(async () => {
      fireEvent.click(screen.getByText('Export'));
    });

    expect(toast.error).toHaveBeenCalledWith('Please enter a custom date format');
    expect(accountsApi.exportAccount).not.toHaveBeenCalled();
  });

  it('ignores second click while export is in progress', async () => {
    let resolveExport: () => void;
    vi.mocked(accountsApi.exportAccount).mockReturnValue(
      new Promise<undefined>((resolve) => { resolveExport = () => resolve(undefined); }),
    );

    render(<AccountExportModal {...defaultProps} />);

    const exportButton = screen.getByText('Export');

    // First click starts the export
    await act(async () => {
      fireEvent.click(exportButton);
    });

    // Second click while exporting should be ignored
    await act(async () => {
      fireEvent.click(exportButton);
    });

    resolveExport!();

    await waitFor(() => {
      expect(accountsApi.exportAccount).toHaveBeenCalledTimes(1);
    });
  });

  it('calls Cancel button handler', () => {
    render(<AccountExportModal {...defaultProps} />);

    fireEvent.click(screen.getByText('Cancel'));
    expect(defaultProps.onClose).toHaveBeenCalled();
  });

  it('uses named date format directly when a specific format is selected', async () => {
    vi.mocked(accountsApi.exportAccount).mockResolvedValue(undefined);

    usePreferencesStore.setState({
      preferences: {
        dateFormat: 'MM/DD/YYYY',
      } as any,
      isLoaded: true,
    });

    render(<AccountExportModal {...defaultProps} />);

    await act(async () => {
      fireEvent.click(screen.getByText('Export'));
    });

    await waitFor(() => {
      expect(accountsApi.exportAccount).toHaveBeenCalledWith(
        'account-1',
        'csv',
        { expandSplits: true, dateFormat: 'MM/DD/YYYY' },
      );
    });
  });

  describe('browser date format, resolved by the shared resolveDateFormatPattern', () => {
    const originalIntlDateTimeFormat = globalThis.Intl.DateTimeFormat;

    function mockIntlForOrder(parts: Array<{ type: string; value: string }>) {
      const MockFormatter = function () {
        return { formatToParts: () => parts };
      };
      MockFormatter.supportedLocalesOf = originalIntlDateTimeFormat.supportedLocalesOf.bind(originalIntlDateTimeFormat);
      (globalThis.Intl as any).DateTimeFormat = MockFormatter;
    }

    afterEach(() => {
      (globalThis.Intl as any).DateTimeFormat = originalIntlDateTimeFormat;
    });

    it('resolves YYYY/MM/DD for year-first locales', async () => {
      vi.mocked(accountsApi.exportAccount).mockResolvedValue(undefined);
      usePreferencesStore.setState({ preferences: { dateFormat: 'browser' } as any, isLoaded: true });

      mockIntlForOrder([
        { type: 'year', value: '2024' },
        { type: 'literal', value: '/' },
        { type: 'month', value: '12' },
        { type: 'literal', value: '/' },
        { type: 'day', value: '31' },
      ]);

      render(<AccountExportModal {...defaultProps} />);
      await act(async () => { fireEvent.click(screen.getByText('Export')); });
      await waitFor(() => {
        expect(accountsApi.exportAccount).toHaveBeenCalledWith(
          'account-1', 'csv', expect.objectContaining({ dateFormat: 'YYYY/MM/DD' }),
        );
      });
    });

    it('resolves DD/MM/YYYY for day-first locales', async () => {
      vi.mocked(accountsApi.exportAccount).mockResolvedValue(undefined);
      usePreferencesStore.setState({ preferences: { dateFormat: 'browser' } as any, isLoaded: true });

      mockIntlForOrder([
        { type: 'day', value: '31' },
        { type: 'literal', value: '/' },
        { type: 'month', value: '12' },
        { type: 'literal', value: '/' },
        { type: 'year', value: '2024' },
      ]);

      render(<AccountExportModal {...defaultProps} />);
      await act(async () => { fireEvent.click(screen.getByText('Export')); });
      await waitFor(() => {
        expect(accountsApi.exportAccount).toHaveBeenCalledWith(
          'account-1', 'csv', expect.objectContaining({ dateFormat: 'DD/MM/YYYY' }),
        );
      });
    });

    it('falls back to YYYY-MM-DD for unrecognized part order', async () => {
      vi.mocked(accountsApi.exportAccount).mockResolvedValue(undefined);
      usePreferencesStore.setState({ preferences: { dateFormat: 'browser' } as any, isLoaded: true });

      // Only two date parts — no match for any of the three known orderings
      mockIntlForOrder([
        { type: 'month', value: '12' },
        { type: 'literal', value: '/' },
        { type: 'year', value: '2024' },
      ]);

      render(<AccountExportModal {...defaultProps} />);
      await act(async () => { fireEvent.click(screen.getByText('Export')); });
      await waitFor(() => {
        expect(accountsApi.exportAccount).toHaveBeenCalledWith(
          'account-1', 'csv', expect.objectContaining({ dateFormat: 'YYYY-MM-DD' }),
        );
      });
    });

    it('falls back to YYYY-MM-DD when Intl.DateTimeFormat throws', async () => {
      vi.mocked(accountsApi.exportAccount).mockResolvedValue(undefined);
      usePreferencesStore.setState({ preferences: { dateFormat: 'browser' } as any, isLoaded: true });

      (globalThis.Intl as any).DateTimeFormat = function () {
        throw new Error('Intl not supported');
      };

      render(<AccountExportModal {...defaultProps} />);
      await act(async () => { fireEvent.click(screen.getByText('Export')); });
      await waitFor(() => {
        expect(accountsApi.exportAccount).toHaveBeenCalledWith(
          'account-1', 'csv', expect.objectContaining({ dateFormat: 'YYYY-MM-DD' }),
        );
      });
    });

    it('keeps the locale\'s own (absent) separators rather than inventing one', async () => {
      vi.mocked(accountsApi.exportAccount).mockResolvedValue(undefined);
      usePreferencesStore.setState({ preferences: { dateFormat: 'browser' } as any, isLoaded: true });

      // MM/DD/YYYY order but no literal part: the pattern is the parts as the
      // locale writes them, the same pattern useDateFormat reads typed dates with.
      mockIntlForOrder([
        { type: 'month', value: '12' },
        { type: 'day', value: '31' },
        { type: 'year', value: '2024' },
      ]);

      render(<AccountExportModal {...defaultProps} />);
      await act(async () => { fireEvent.click(screen.getByText('Export')); });
      await waitFor(() => {
        expect(accountsApi.exportAccount).toHaveBeenCalledWith(
          'account-1', 'csv', expect.objectContaining({ dateFormat: 'MMDDYYYY' }),
        );
      });
    });
  });
});
