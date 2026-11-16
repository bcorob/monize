import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@/test/render';
import { AttachmentPreviewDialog, type PreviewTarget } from './AttachmentPreviewDialog';
import { attachmentsApi } from '@/lib/attachments';
import { downloadBlob } from '@/lib/download';
import type { Attachment } from '@/types/attachment';
import { buttonClassName } from '@/components/ui/Button';
import { SEGMENTED_GROUP_CLASS, segmentClass } from '@/components/ui/segmented-control';

vi.mock('@/lib/attachments', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/attachments')>()),
  attachmentsApi: { fetchBytes: vi.fn() },
}));

vi.mock('@/lib/download', () => ({ downloadBlob: vi.fn() }));

/** The PDF renderer has its own suite; here it only has to be handed the bytes. */
vi.mock('./PdfPages', () => ({
  PdfPages: ({ bytes }: { bytes: ArrayBuffer }) => (
    <div data-testid="pdf-pages">{bytes.byteLength}</div>
  ),
}));

const fetchBytes = attachmentsApi.fetchBytes as ReturnType<typeof vi.fn>;

const bytesOf = (text: string) => new TextEncoder().encode(text).buffer;

function makeAttachment(overrides: Partial<Attachment> = {}): Attachment {
  return {
    id: 'a-1',
    transactionId: 't-1',
    warrantyId: null,
    documentKind: 'other',
    filename: 'receipt.png',
    contentType: 'image/png',
    byteSize: 2048,
    sha256: 'abc',
    createdAt: '2026-01-01T00:00:00Z',
    originalAttachmentId: null,
    ...overrides,
  };
}

const saved = (overrides: Partial<Attachment> = {}): PreviewTarget => ({
  kind: 'saved',
  attachment: makeAttachment(overrides),
});

async function open(target: PreviewTarget | null, isOpen = true) {
  const onClose = vi.fn();
  let rerender: (ui: React.ReactElement) => void = () => {};
  await act(async () => {
    ({ rerender } = render(
      <AttachmentPreviewDialog isOpen={isOpen} target={target} onClose={onClose} />,
    ));
  });
  return { onClose, rerender };
}

describe('AttachmentPreviewDialog', () => {
  let createdUrls: string[];
  let revoked: string[];

  beforeEach(() => {
    vi.clearAllMocks();
    createdUrls = [];
    revoked = [];
    URL.createObjectURL = vi.fn(() => {
      const url = `blob:preview-${createdUrls.length + 1}`;
      createdUrls.push(url);
      return url;
    });
    URL.revokeObjectURL = vi.fn((url: string) => {
      revoked.push(url);
    });
    fetchBytes.mockImplementation((id: string) =>
      Promise.resolve({
        bytes: bytesOf(id),
        contentType: id.startsWith('pdf') ? 'application/pdf' : 'image/png',
      }),
    );
  });

  afterEach(() => {
    // @ts-expect-error jsdom has no createObjectURL; restore its absence.
    delete URL.createObjectURL;
    // @ts-expect-error same
    delete URL.revokeObjectURL;
  });

  it('renders nothing without a target', async () => {
    await open(null);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('names the dialog after the file and draws an image from its bytes', async () => {
    await open(saved());
    expect(screen.getByRole('dialog', { name: 'receipt.png' })).toBeInTheDocument();
    expect(fetchBytes).toHaveBeenCalledWith('a-1', expect.any(AbortSignal));

    const image = await screen.findByRole('img', { name: 'receipt.png' });
    expect(image).toHaveAttribute('src', 'blob:preview-1');
  });

  it('offers Download for the attachment, named as the row names it', async () => {
    await open(saved());
    const link = screen.getByRole('link', { name: 'Download' });
    expect(link).toHaveAttribute('href', '/api/v1/attachments/a-1/download');
    expect(link).toHaveAttribute('download', 'receipt.png');
  });

  it('toggles between fitting the screen and actual size', async () => {
    await open(saved());
    const image = await screen.findByRole('img', { name: 'receipt.png' });
    const fit = screen.getByRole('button', { name: 'Fit to screen' });
    const actual = screen.getByRole('button', { name: 'Actual size' });
    expect(fit).toHaveAttribute('aria-pressed', 'true');
    expect(image.className).toContain('object-contain');

    fireEvent.click(actual);
    expect(actual).toHaveAttribute('aria-pressed', 'true');
    expect(image.className).toContain('max-w-none');
    expect(image.className).not.toContain('object-contain');
  });

  it('offers no Original switch on an ordinary attachment', async () => {
    await open(saved());
    await screen.findByRole('img', { name: 'receipt.png' });
    expect(screen.queryByRole('button', { name: 'Original' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Enhanced' })).not.toBeInTheDocument();
  });

  it('switches a scan pair to its original, and points Download at it unnamed', async () => {
    await open(saved({ id: 'scan-1', filename: 'receipt-scan.jpg', originalAttachmentId: 'orig-1' }));
    await screen.findByRole('img', { name: 'receipt-scan.jpg' });
    const enhanced = screen.getByRole('button', { name: 'Enhanced' });
    const original = screen.getByRole('button', { name: 'Original' });
    expect(enhanced).toHaveAttribute('aria-pressed', 'true');

    await act(async () => {
      fireEvent.click(original);
    });
    expect(original).toHaveAttribute('aria-pressed', 'true');
    expect(fetchBytes).toHaveBeenCalledWith('orig-1', expect.any(AbortSignal));
    const link = screen.getByRole('link', { name: 'Download' });
    expect(link).toHaveAttribute('href', '/api/v1/attachments/orig-1/download');
    // The list does not know the original's filename; the server names it.
    expect(link.getAttribute('download')).toBe('');

    await act(async () => {
      fireEvent.click(enhanced);
    });
    expect(screen.getByRole('link', { name: 'Download' })).toHaveAttribute(
      'download',
      'receipt-scan.jpg',
    );
  });

  it('keeps Download when the preview cannot be loaded', async () => {
    fetchBytes.mockRejectedValue(new Error('boom'));
    await open(saved());
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The preview could not be loaded',
    );
    expect(screen.getByRole('link', { name: 'Download' })).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('says the bytes are unreachable, not lost, when the backend is not configured', async () => {
    // The one failure with a different repair: the server answered 503 naming a
    // storage backend it cannot reach, so the file is intact and the Download
    // link would fail for the same reason. Telling the reader to download it
    // instead -- which is what the generic message does -- would be wrong.
    fetchBytes.mockRejectedValue(
      Object.assign(new Error('unreachable'), {
        isAxiosError: true,
        response: {
          status: 503,
          data: new TextEncoder().encode(
            JSON.stringify({ code: 'ATTACHMENT_STORE_UNREACHABLE' }),
          ).buffer,
        },
      }),
    );
    await open(saved());
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('cannot currently reach');
    expect(alert).toHaveTextContent('Nothing is lost');
    expect(alert).not.toHaveTextContent('You can still download');
  });

  it('hands a PDF to the page renderer', async () => {
    await open(saved({ id: 'pdf-1', filename: 'invoice.pdf', contentType: 'application/pdf' }));
    const pages = await screen.findByTestId('pdf-pages');
    expect(pages).toHaveTextContent(String(bytesOf('pdf-1').byteLength));
    expect(screen.queryByRole('button', { name: 'Fit to screen' })).not.toBeInTheDocument();
  });

  it('says so for a type it cannot draw', async () => {
    fetchBytes.mockResolvedValue({ bytes: bytesOf('x'), contentType: 'text/plain' });
    await open(saved({ filename: 'notes.txt', contentType: 'text/plain' }));
    expect(
      await screen.findByText('This file type cannot be previewed. You can still download it.'),
    ).toBeInTheDocument();
  });

  it('previews a staged file and downloads it from the file itself', async () => {
    const file = new File(['staged'], 'draft.png', { type: 'image/png' });
    await open({ kind: 'file', file });
    await screen.findByRole('img', { name: 'draft.png' });
    expect(fetchBytes).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Download' }));
    expect(downloadBlob).toHaveBeenCalledWith(file, 'draft.png');
  });

  it('switches a staged pair to the photo it was scanned from', async () => {
    const file = new File(['scan'], 'receipt-scan.jpg', { type: 'image/jpeg' });
    const original = new File(['photo'], 'receipt.jpg', { type: 'image/jpeg' });
    await open({ kind: 'file', file, original });
    await screen.findByRole('img', { name: 'receipt-scan.jpg' });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Original' }));
    });
    await waitFor(() => expect(createdUrls).toHaveLength(2));
    fireEvent.click(screen.getByRole('button', { name: 'Download' }));
    expect(downloadBlob).toHaveBeenCalledWith(original, 'receipt.jpg');
  });

  it('revokes the image URL once the preview closes', async () => {
    const target = saved();
    const { rerender } = await open(target);
    await screen.findByRole('img', { name: 'receipt.png' });
    expect(revoked).toEqual([]);

    await act(async () => {
      rerender(<AttachmentPreviewDialog isOpen={false} target={target} onClose={vi.fn()} />);
    });
    expect(revoked).toEqual(['blob:preview-1']);
  });

  it('closes from the footer, with an outline button rather than a primary', async () => {
    const { onClose } = await open(saved());
    const close = screen.getByRole('button', { name: 'Close' });
    expect(close.className).toContain(buttonClassName('outline'));
    fireEvent.click(close);
    expect(onClose).toHaveBeenCalled();
  });

  it('draws its view switches as segmented controls, never as primary buttons', async () => {
    await open(saved({ id: 'scan-1', filename: 'receipt-scan.jpg', originalAttachmentId: 'orig-1' }));
    await screen.findByRole('img', { name: 'receipt-scan.jpg' });
    for (const name of ['Version', 'Zoom']) {
      expect(screen.getByRole('group', { name }).className).toContain(SEGMENTED_GROUP_CLASS);
    }
    expect(screen.getByRole('button', { name: 'Enhanced' }).className).toBe(segmentClass(true));
    const primaries = screen
      .getAllByRole('button')
      .filter((button) => button.className.includes(buttonClassName('primary')));
    expect(primaries).toHaveLength(0);
  });

  it('pads its heading as a fixed-height panel, so the title is not flush with the edge', async () => {
    await open(saved());
    const dialog = screen.getByRole('dialog');
    expect(dialog.className).toContain('h-[min(90vh,56rem)]');
    const heading = screen.getByRole('heading', { name: 'receipt.png' });
    expect(heading.parentElement!.className).toContain('px-4');
  });

  /**
   * The caller may rebuild the target object on every one of its own renders
   * -- the saved list does exactly that shape of thing -- and that must not be
   * read as a different attachment. Keyed on the object, this test finds the
   * reader thrown back to the enhanced image at Fit, mid-read.
   */
  it('keeps what the reader chose when an equivalent target arrives', async () => {
    const attachment = makeAttachment({
      id: 'scan-1',
      filename: 'receipt-scan.jpg',
      originalAttachmentId: 'orig-1',
    });
    const { rerender } = await open({ kind: 'saved', attachment });
    await screen.findByRole('img', { name: 'receipt-scan.jpg' });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Original' }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Actual size' }));
    });
    fetchBytes.mockClear();

    await act(async () => {
      rerender(
        <AttachmentPreviewDialog
          isOpen
          target={{ kind: 'saved', attachment }}
          onClose={vi.fn()}
        />,
      );
    });

    expect(screen.getByRole('button', { name: 'Original' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Actual size' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    // And nothing was re-read: the subject never changed.
    expect(fetchBytes).not.toHaveBeenCalled();
  });

  it('starts over when a different attachment is previewed', async () => {
    const first = makeAttachment({ id: 'a-1', originalAttachmentId: 'orig-1' });
    const { rerender } = await open({ kind: 'saved', attachment: first });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Original' }));
    });

    const second = makeAttachment({
      id: 'a-2',
      filename: 'other.png',
      originalAttachmentId: 'orig-2',
    });
    await act(async () => {
      rerender(
        <AttachmentPreviewDialog
          isOpen
          target={{ kind: 'saved', attachment: second }}
          onClose={vi.fn()}
        />,
      );
    });

    expect(screen.getByRole('button', { name: 'Enhanced' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  describe('the toolbar does not wait for the bytes', () => {
    it('offers the zoom controls on an image while it is still loading', async () => {
      fetchBytes.mockReturnValue(new Promise(() => {}));
      await open(saved());
      expect(screen.getByText('Loading preview…')).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: 'Fit to screen' }),
      ).toBeInTheDocument();
    });

    it('offers none on a PDF', async () => {
      fetchBytes.mockReturnValue(new Promise(() => {}));
      await open(saved({ filename: 'invoice.pdf', contentType: 'application/pdf' }));
      expect(
        screen.queryByRole('button', { name: 'Fit to screen' }),
      ).not.toBeInTheDocument();
    });

    it('keeps them while switching to a scan original', async () => {
      let resolveOriginal: (value: unknown) => void = () => {};
      fetchBytes.mockImplementation((id: string) =>
        id === 'orig-1'
          ? new Promise((resolve) => {
              resolveOriginal = resolve;
            })
          : Promise.resolve({ bytes: bytesOf(id), contentType: 'image/png' }),
      );
      await open(
        saved({ id: 'scan-1', filename: 'receipt-scan.jpg', originalAttachmentId: 'orig-1' }),
      );
      await screen.findByRole('img', { name: 'receipt-scan.jpg' });

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Original' }));
      });
      // Mid-switch, with nothing loaded: the controls stay put.
      expect(screen.getByText('Loading preview…')).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: 'Fit to screen' }),
      ).toBeInTheDocument();
      await act(async () => {
        resolveOriginal({ bytes: bytesOf('orig'), contentType: 'image/jpeg' });
      });
    });
  });
});
