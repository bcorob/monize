import { describe, it, expect, vi, beforeEach } from "vitest";
import toast from "react-hot-toast";
import { render, screen, fireEvent, act } from "@/test/render";
import { MailboxImportCard } from "./MailboxImportCard";
import {
  PART_MAX_BYTES,
  SELECTION_MAX_BYTES,
} from "@/lib/email-import/upload-plan";
import type {
  EmailReceiptImportFileResult,
  EmailReceiptImportResult,
  ProcessEmailReceiptsResult,
} from "@/types/email-receipts";

const api = vi.hoisted(() => ({
  importFiles: vi.fn(),
  processBatch: vi.fn(),
}));
vi.mock("@/lib/email-receipts-api", () => ({
  emailReceiptsApi: {
    mailbox: { import: api.importFiles },
    receipts: { processBatch: api.processBatch },
  },
}));
vi.mock("@/lib/logger", () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

function result(
  overrides: Partial<EmailReceiptImportResult> = {},
): EmailReceiptImportResult {
  return {
    files: [
      {
        name: "a.mbox",
        format: "mbox",
        messages: 5,
        stored: 3,
        duplicates: 1,
        skipped: 1,
        ignoredEntries: 0,
        error: null,
      },
    ],
    truncated: 0,
    processed: 0,
    busy: false,
    ...overrides,
  };
}

function entry(
  name: string,
  overrides: Partial<EmailReceiptImportFileResult> = {},
): EmailReceiptImportFileResult {
  return {
    name,
    format: "eml",
    messages: 1,
    stored: 1,
    duplicates: 0,
    skipped: 0,
    ignoredEntries: 0,
    error: null,
    ...overrides,
  };
}

function batch(
  overrides: Partial<ProcessEmailReceiptsResult> = {},
): ProcessEmailReceiptsResult {
  return {
    processed: 0,
    byOutcome: {},
    failed: 0,
    remaining: 0,
    since: "T",
    ...overrides,
  };
}

function file(name: string, size = 10) {
  const f = new File(["x"], name);
  Object.defineProperty(f, "size", { value: size });
  return f;
}

async function pick(files: File[]) {
  await act(async () => {
    fireEvent.change(
      screen.getByLabelText("Email files (.eml, .mbox, .msg or .zip)"),
      {
        target: { files },
      },
    );
  });
}

async function importNow() {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
  });
  await act(async () => {});
}

describe("MailboxImportCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.processBatch.mockReset();
    api.processBatch.mockResolvedValue(batch());
  });

  it("explains the import and keeps files without an extension selectable", () => {
    render(<MailboxImportCard />);
    expect(
      screen.getByRole("heading", { name: "Import archived emails" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/keeps the sender and the purchase date/),
    ).toBeInTheDocument();
    const input = screen.getByLabelText(
      "Email files (.eml, .mbox, .msg or .zip)",
    ) as HTMLInputElement;
    expect(input.multiple).toBe(true);
    expect(input.accept).toContain(".eml");
    expect(input.accept).toContain("application/mbox");
    expect(input.accept).toContain(".zip");
    expect(input.accept).toContain(".msg");
  });

  it("keeps Import disabled until files are selected", async () => {
    render(<MailboxImportCard />);
    expect(screen.getByRole("button", { name: "Import" })).toBeDisabled();
    await pick([file("a.mbox")]);
    expect(screen.getByRole("button", { name: "Import" })).toBeEnabled();
    expect(screen.getByText("Selected: 1")).toBeInTheDocument();
  });

  it("uploads the selected files and lists the result per file", async () => {
    api.importFiles.mockResolvedValue(
      result({
        files: [
          {
            name: "a.mbox",
            format: "mbox",
            messages: 5,
            stored: 3,
            duplicates: 1,
            skipped: 1,
            ignoredEntries: 0,
            error: null,
          },
          {
            name: "b.eml",
            format: "eml",
            messages: 1,
            stored: 1,
            duplicates: 0,
            skipped: 0,
            ignoredEntries: 0,
            error: null,
          },
        ],
      }),
    );
    api.processBatch.mockResolvedValue(batch({ processed: 4 }));
    render(<MailboxImportCard />);
    const a = file("a.mbox");
    const b = file("b.eml");
    await pick([a, b]);
    await importNow();
    expect(api.importFiles).toHaveBeenCalledWith([a, b], { process: false });
    expect(
      screen.getByText("a.mbox: 3 stored, 1 duplicates, 1 skipped"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("b.eml: 1 stored, 0 duplicates, 0 skipped"),
    ).toBeInTheDocument();
    expect(api.processBatch).toHaveBeenCalledTimes(1);
    expect(api.processBatch).toHaveBeenCalledWith({
      statuses: ["pending"],
      limit: 100,
    });
    expect(screen.getByText("Processed 4 waiting emails.")).toBeInTheDocument();
    expect(screen.queryByText(/not read because/)).not.toBeInTheDocument();
    expect(screen.queryByText(/still wait/)).not.toBeInTheDocument();
    expect(
      screen.queryByText(/could not be processed/),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Import" })).toBeDisabled();
  });

  it.each([
    ["invalid_archive", "x.zip: the ZIP file is damaged or cannot be read."],
    [
      "archive_too_large",
      "x.zip: the ZIP file expands to more than the import limit. Unpack it and upload the .mbox file inside.",
    ],
    [
      "unsupported_format",
      "x.pdf: this format is not supported. Supported formats are .eml, .mbox, .msg and .zip.",
    ],
    ["empty", "x.eml: the file holds no emails."],
  ] as const)("shows the refusal for %s", async (code, text) => {
    const name = text.split(":")[0];
    api.importFiles.mockResolvedValue(
      result({
        files: [
          {
            name,
            format: null,
            messages: 0,
            stored: 0,
            duplicates: 0,
            skipped: 0,
            ignoredEntries: 0,
            error: code,
          },
        ],
      }),
    );
    render(<MailboxImportCard />);
    await pick([file(name)]);
    await importNow();
    expect(screen.getByText(text)).toBeInTheDocument();
  });

  it("reports the ZIP entries that were not mail files, and only then", async () => {
    api.importFiles.mockResolvedValue(
      result({
        files: [
          {
            name: "takeout.zip",
            format: "zip",
            messages: 4,
            stored: 4,
            duplicates: 0,
            skipped: 0,
            ignoredEntries: 3,
            error: null,
          },
          {
            name: "b.msg",
            format: "msg",
            messages: 1,
            stored: 1,
            duplicates: 0,
            skipped: 0,
            ignoredEntries: 0,
            error: null,
          },
        ],
      }),
    );
    render(<MailboxImportCard />);
    await pick([file("takeout.zip"), file("b.msg")]);
    await importNow();
    expect(
      screen.getByText(
        "takeout.zip: 3 other files in the archive were skipped.",
      ),
    ).toBeInTheDocument();
    expect(screen.getAllByText(/other files in the archive/)).toHaveLength(1);
  });

  it("says how many messages were left out by the cap", async () => {
    api.importFiles.mockResolvedValue(result({ truncated: 1200 }));
    render(<MailboxImportCard />);
    await pick([file("a.mbox")]);
    await importNow();
    expect(
      screen.getByText(/1,200 messages were not read/),
    ).toBeInTheDocument();
  });

  it("counts only what the processing run did, not what the requests answered", async () => {
    // The server answers `processed` 9 for a request; it must not be summed or shown.
    api.importFiles.mockResolvedValue(result({ processed: 9, busy: true }));
    api.processBatch.mockResolvedValue(batch({ processed: 2 }));
    render(<MailboxImportCard />);
    await pick([file("a.mbox")]);
    await importNow();
    expect(screen.getByText("Processed 2 waiting emails.")).toBeInTheDocument();
    expect(screen.queryByText(/being read right now/)).not.toBeInTheDocument();
  });

  it("repeats the processing call with since until nothing remains", async () => {
    api.importFiles.mockResolvedValue(result());
    api.processBatch
      .mockResolvedValueOnce(
        batch({ processed: 100, remaining: 1, since: "S" }),
      )
      .mockResolvedValueOnce(batch({ processed: 1, remaining: 0, since: "S" }));
    render(<MailboxImportCard />);
    await pick([file("a.mbox")]);
    await importNow();
    expect(api.processBatch.mock.calls.map((c) => c[0].since)).toEqual([
      undefined,
      "S",
    ]);
    expect(
      screen.getByText("Processed 101 waiting emails."),
    ).toBeInTheDocument();
  });

  it("says how many emails still wait and how many could not be processed", async () => {
    api.importFiles.mockResolvedValue(result());
    api.processBatch.mockResolvedValue(
      batch({ processed: 0, failed: 0, remaining: 5 }),
    );
    render(<MailboxImportCard />);
    await pick([file("a.mbox")]);
    await importNow();
    expect(
      screen.getByText(
        "5 emails still wait to be processed. Monize processes them at the next mailbox read.",
      ),
    ).toBeInTheDocument();
  });

  it("says how many emails could not be processed", async () => {
    api.importFiles.mockResolvedValue(result());
    api.processBatch.mockResolvedValue(batch({ processed: 3, failed: 2 }));
    render(<MailboxImportCard />);
    await pick([file("a.mbox")]);
    await importNow();
    expect(screen.getByText("Processed 3 waiting emails.")).toBeInTheDocument();
    expect(
      screen.getByText("2 emails could not be processed."),
    ).toBeInTheDocument();
  });

  it("shows the processing progress and cancels between processing calls", async () => {
    api.importFiles.mockResolvedValue(result());
    let finishFirst: (value: ProcessEmailReceiptsResult) => void = () => {};
    api.processBatch.mockImplementationOnce(
      () => new Promise((resolve) => (finishFirst = resolve)),
    );
    render(<MailboxImportCard />);
    await pick([file("a.mbox")]);
    await importNow();
    expect(screen.getByText("Processing emails: 0 of 0")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await act(async () => {
      finishFirst(batch({ processed: 100, remaining: 40, since: "S" }));
    });
    await act(async () => {});
    expect(api.processBatch).toHaveBeenCalledTimes(1);
    expect(
      screen.getByText("Processed 100 waiting emails."),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/^40 emails still wait to be processed\./),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Cancel" }),
    ).not.toBeInTheDocument();
  });

  it("keeps the stored emails and says processing stopped when a processing call fails", async () => {
    api.importFiles.mockResolvedValue(result());
    api.processBatch.mockRejectedValue({
      response: { status: 500, data: { message: "Server broke" } },
    });
    render(<MailboxImportCard />);
    await pick([file("a.mbox")]);
    await importNow();
    expect(screen.getByRole("alert")).toHaveTextContent("Server broke");
    expect(
      screen.getByText(/^Processing the imported emails stopped\./),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/The import stopped after/),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/^a\.mbox: /)).toBeInTheDocument();
  });

  it("accepts more than 20 files and sends them in several requests", async () => {
    api.importFiles.mockImplementation(async (sent: File[]) =>
      result({
        files: sent.map((f) => entry(f.name)),
      }),
    );
    api.processBatch.mockResolvedValue(batch({ processed: 21 }));
    render(<MailboxImportCard />);
    await pick(Array.from({ length: 21 }, (_, i) => file(`m${i}.eml`)));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("Selected: 21")).toBeInTheDocument();
    await importNow();
    expect(api.importFiles).toHaveBeenCalledTimes(2);
    expect(api.importFiles.mock.calls.map((c) => c[0].length)).toEqual([20, 1]);
    expect(
      screen.getByText("Processed 21 waiting emails."),
    ).toBeInTheDocument();
    expect(screen.getByText(/^m20\.eml: /)).toBeInTheDocument();
  });

  it("accepts exactly the total limit and refuses one byte more, without a request", async () => {
    render(<MailboxImportCard />);
    await pick([file("a.mbox", SELECTION_MAX_BYTES)]);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Import" })).toBeEnabled();
    await pick([file("a.mbox", SELECTION_MAX_BYTES), file("b.eml", 1)]);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The selected files together are larger than 1.0 GB.",
    );
    expect(screen.getByRole("button", { name: "Import" })).toBeDisabled();
    expect(api.importFiles).not.toHaveBeenCalled();
  });

  it("splits a large mbox in the browser and sums the parts under the file name", async () => {
    const msg = (n: number) =>
      `From s${n}@x Mon\nSubject: ${n}\n\n${"b".repeat(9 * 1024 * 1024)}\n\n`;
    const big = new File([msg(1), msg(2), msg(3), msg(4)], "monize.mbox");
    expect(big.size).toBeGreaterThan(PART_MAX_BYTES);
    api.importFiles.mockImplementation(async (sent: File[]) =>
      result({
        files: sent.map((f) =>
          entry(f.name, { messages: 2, stored: 2, duplicates: 0, skipped: 0 }),
        ),
      }),
    );
    render(<MailboxImportCard />);
    await pick([big]);
    await importNow();
    // One part per request: the frontend buffers a request's body.
    expect(api.importFiles).toHaveBeenCalledTimes(2);
    const sent = api.importFiles.mock.calls.map((call) => call[0] as File[]);
    expect(sent.map((files) => files.map((f) => f.name))).toEqual([
      ["monize-1.mbox"],
      ["monize-2.mbox"],
    ]);
    expect(sent.flat().every((f) => f.size <= PART_MAX_BYTES)).toBe(true);
    expect(
      screen.getByText("monize.mbox: 4 stored, 0 duplicates, 0 skipped"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/were not sent/)).not.toBeInTheDocument();
  });

  it("says how many messages above 24 MB were not sent", async () => {
    const huge = new File(
      ["From a@b\n\n", "x".repeat(PART_MAX_BYTES + 10)],
      "huge.mbox",
    );
    render(<MailboxImportCard />);
    await pick([huge]);
    await importNow();
    expect(api.importFiles).not.toHaveBeenCalled();
    expect(
      screen.getByText(
        "huge.mbox: 1 messages larger than 24.0 MB were not sent.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Processed 0 waiting emails.")).toBeInTheDocument();
  });

  it("shows the preparing and sending progress and cancels between requests", async () => {
    let finishFirst: (value: EmailReceiptImportResult) => void = () => {};
    api.importFiles.mockImplementationOnce(
      () => new Promise((resolve) => (finishFirst = resolve)),
    );
    render(<MailboxImportCard />);
    await pick(Array.from({ length: 21 }, (_, i) => file(`m${i}.eml`)));
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Import" }));
    });
    expect(screen.getByText("Preparing files...")).toBeInTheDocument();
    await act(async () => {});
    expect(screen.getByText("Sending part 1 of 2")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await act(async () => {
      finishFirst(result({ files: [entry("m0.eml")] }));
    });
    await act(async () => {});
    expect(api.importFiles).toHaveBeenCalledTimes(1);
    expect(
      screen.getByText(
        "The import was cancelled after 1 of 2 parts. The emails already imported are kept.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/^m0\.eml: /)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Cancel" }),
    ).not.toBeInTheDocument();
  });

  it("keeps what was imported when a later request fails, and says it stopped", async () => {
    api.importFiles
      .mockResolvedValueOnce(result({ files: [entry("m0.eml")] }))
      .mockRejectedValueOnce({
        response: { status: 500, data: { message: "Server broke" } },
      });
    render(<MailboxImportCard />);
    await pick(Array.from({ length: 21 }, (_, i) => file(`m${i}.eml`)));
    await importNow();
    expect(screen.getByRole("alert")).toHaveTextContent("Server broke");
    expect(toast.error).toHaveBeenCalledWith("Server broke");
    expect(
      screen.getByText(/^The import stopped after 1 of 2 parts\./),
    ).toBeInTheDocument();
    expect(screen.getByText(/^m0\.eml: /)).toBeInTheDocument();
    expect(api.processBatch).not.toHaveBeenCalled();
    expect(screen.getByText("Selected: 21")).toBeInTheDocument();
  });

  it("shows the server message and a toast when the request fails", async () => {
    api.importFiles.mockRejectedValue({
      response: { data: { message: "File too large" } },
    });
    render(<MailboxImportCard />);
    await pick([file("a.mbox")]);
    await importNow();
    expect(screen.getByRole("alert")).toHaveTextContent("File too large");
    expect(toast.error).toHaveBeenCalledWith("File too large");
    expect(screen.queryByText(/waiting emails/)).not.toBeInTheDocument();
  });

  it("falls back to a translated message when the error has none", async () => {
    api.importFiles.mockRejectedValue({ response: {} });
    render(<MailboxImportCard />);
    await pick([file("a.mbox")]);
    await importNow();
    expect(screen.getByRole("alert")).toHaveTextContent("The import failed");
  });

  it("opens and closes the export guide", async () => {
    render(<MailboxImportCard />);
    const toggle = screen.getByRole("button", {
      name: "How to export emails from your provider",
    });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Gmail: one email")).not.toBeInTheDocument();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByText("Gmail: all emails with a label"),
    ).toBeInTheDocument();
    expect(screen.getByText("Gmail: one email")).toBeInTheDocument();
    expect(
      screen.getByText(/ImportExportTools NG, then export/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Upload the downloaded .zip file as it is/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Outlook writes .msg files/)).toBeInTheDocument();
    expect(screen.getByText("Outlook desktop")).toBeInTheDocument();
    expect(screen.getByText("Apple Mail")).toBeInTheDocument();
    expect(
      screen.getByText(/forwarding emails with a script loses/),
    ).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(screen.queryByText("Gmail: one email")).not.toBeInTheDocument();
  });
});
