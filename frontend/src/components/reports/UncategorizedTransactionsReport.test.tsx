import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@/test/render";
import { UncategorizedTransactionsReport } from "./UncategorizedTransactionsReport";

const mockExportToCsv = vi.fn();
vi.mock("@/lib/csv-export", () => ({
  exportToCsv: (...args: any[]) => mockExportToCsv(...args),
}));

const mockExportToPdf = vi.fn();
vi.mock("@/lib/pdf-export", () => ({
  exportToPdf: (...args: any[]) => mockExportToPdf(...args),
}));

vi.mock("@/components/ui/ExportDropdown", () => ({
  ExportDropdown: ({ onExportCsv, onExportPdf }: any) => (
    <div data-testid="export-dropdown">
      <button data-testid="export-csv" onClick={onExportCsv}>
        CSV
      </button>
      <button data-testid="export-pdf" onClick={onExportPdf}>
        PDF
      </button>
    </div>
  ),
}));

const mockPush = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}));

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({
      ...numberFormatMockDefaults(),
      formatCurrency: (n: number, currencyCode = 'CAD') =>
        currencyCode === 'CAD' ? `$${n.toFixed(2)}` : `${currencyCode} ${n.toFixed(2)}`,
      formatCurrencyCompact: (n: number) => `$${n.toFixed(0)}`,
      defaultCurrency: "CAD",
    }),
};
});

vi.mock('@/hooks/useDateFormat', () => ({
  useDateFormat: () => ({
    formatDate: (date: string) => `preferred-date:${date}`,
  }),
}));

const stableResolvedRange = { start: "2025-01-01", end: "2025-03-31" };

vi.mock("@/hooks/useDateRange", () => ({
  useDateRange: () => ({
    dateRange: "3m",
    setDateRange: vi.fn(),
    resolvedRange: stableResolvedRange,
    isValid: true,
  }),
}));

vi.mock("@/components/ui/DateRangeSelector", () => ({
  DateRangeSelector: () => <div data-testid="date-range-selector" />,
}));

const mockGetUncategorizedTransactions = vi.fn();

vi.mock("@/lib/built-in-reports", () => ({
  builtInReportsApi: {
    getUncategorizedTransactions: (...args: any[]) =>
      mockGetUncategorizedTransactions(...args),
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

/**
 * The sort control for a column, addressed by POSITION rather than by label.
 * Since the phone layout landed, each column label names up to three nodes --
 * the phone sort chip, the column header, and (for the three captioned columns)
 * a caption in every body row -- so `getByText` matches more than one. Index is
 * the column order: date, payee, account, amount.
 *
 * The ROW is addressed by the class that identifies it rather than by index:
 * the two header rows are interchangeable to `[1]`, so a swap would leave this
 * silently tapping the phone strip instead, and an absent header (the report's
 * empty-state branch) would throw a `TypeError` naming nothing.
 */
const sortControl = (index: number) => {
  const columnHeaderRow = document.querySelector("thead tr.sm\\:table-row");
  if (!columnHeaderRow) throw new Error("no column header row is rendered");
  const control = columnHeaderRow.querySelectorAll("th")[index];
  if (!control) throw new Error(`no sort control at column ${index}`);
  return control;
};

describe("UncategorizedTransactionsReport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPush.mockClear();
  });

  it("shows loading state initially", () => {
    mockGetUncategorizedTransactions.mockReturnValue(new Promise(() => {}));
    render(<UncategorizedTransactionsReport />);
    expect(document.querySelector(".animate-pulse")).toBeTruthy();
  });

  it("renders all-categorized message when no uncategorized transactions", async () => {
    mockGetUncategorizedTransactions.mockResolvedValue({
      transactions: [],
      summary: {
        totalCount: 0,
        expenseCount: 0,
        expenseTotal: 0,
        incomeCount: 0,
        incomeTotal: 0,
      },
    });
    render(<UncategorizedTransactionsReport />);
    await waitFor(() => {
      expect(
        screen.getByText(/All transactions are categorized/),
      ).toBeInTheDocument();
    });
  });

  it("renders transaction table with data", async () => {
    mockGetUncategorizedTransactions.mockResolvedValue({
      transactions: [
        {
          id: "tx-1",
          transactionDate: "2025-02-15",
          payeeName: "Unknown Store",
          description: "Card payment",
          accountName: "Chequing",
          accountId: "acc-1",
          amount: -50.0,
        },
      ],
      summary: {
        totalCount: 1,
        expenseCount: 1,
        expenseTotal: 50,
        incomeCount: 0,
        incomeTotal: 0,
      },
    });
    render(<UncategorizedTransactionsReport />);
    await waitFor(() => {
      expect(screen.getByText("Unknown Store")).toBeInTheDocument();
    });
    expect(screen.getByText("Total Uncategorized")).toBeInTheDocument();
    expect(screen.getByText("preferred-date:2025-02-15")).toBeInTheDocument();
  });

  it("renders summary cards", async () => {
    mockGetUncategorizedTransactions.mockResolvedValue({
      transactions: [],
      summary: {
        totalCount: 5,
        expenseCount: 3,
        expenseTotal: 150,
        incomeCount: 2,
        incomeTotal: 500,
      },
    });
    render(<UncategorizedTransactionsReport />);
    await waitFor(() => {
      expect(screen.getByText("Total Uncategorized")).toBeInTheDocument();
    });
    expect(screen.getByText("Uncategorized Expenses")).toBeInTheDocument();
    expect(screen.getByText("Uncategorized Income")).toBeInTheDocument();
  });

  it("formats rows, summary totals, CSV, and PDF in the response currency", async () => {
    mockGetUncategorizedTransactions.mockResolvedValue({
      transactions: [
        {
          id: "tx-first",
          transactionDate: "2025-02-15",
          payeeName: "First Store",
          description: "",
          accountName: "Primary Account",
          accountId: "acc-primary",
          amount: -50,
          currencyCode: "EUR",
        },
        {
          id: "tx-eur",
          transactionDate: "2025-02-16",
          payeeName: "Euro Store",
          description: "",
          accountName: "EUR Account",
          accountId: "acc-eur",
          amount: 200,
          currencyCode: "EUR",
        },
      ],
      summary: {
        totalCount: 2,
        expenseCount: 1,
        expenseTotal: 50,
        incomeCount: 1,
        incomeTotal: 200,
        currencyCode: "EUR",
      },
    });

    render(<UncategorizedTransactionsReport />);

    await waitFor(() => expect(screen.getByText("Euro Store")).toBeInTheDocument());
    expect(screen.getAllByText("EUR -50.00")).toHaveLength(1);
    expect(screen.getAllByText("EUR 200.00")).toHaveLength(2);
    expect(screen.getByText("EUR 50.00")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("export-csv"));
    // The CSV amount column is a DATA surface: raw numbers, never the response
    // currency's formatted string. `csv-export.ts`'s injection guard
    // tab-prefixes a `-`-leading value its `NUMERIC_VALUE` test cannot read as
    // a number, and a currency written in letters (`zl`, `kr`, `CHF`, `R$`)
    // falls outside that class -- so Excel stores the cell as text and the
    // column stops adding up. That is issue #1134, and this expectation
    // previously asserted the defect.
    expect(mockExportToCsv.mock.calls[0][2].map((row: unknown[]) => row[4])).toEqual([200, -50]);
    for (const row of mockExportToCsv.mock.calls[0][2]) {
      expect(typeof row[4]).toBe("number");
    }
    // ...and the CSV date column is ISO, not the reader's preferred format.
    expect(mockExportToCsv.mock.calls[0][2].map((row: unknown[]) => row[0])).toEqual([
      "2025-02-16",
      "2025-02-15",
    ]);

    await act(async () => {
      fireEvent.click(screen.getByTestId("export-pdf"));
    });
    await waitFor(() => expect(mockExportToPdf).toHaveBeenCalledTimes(1));
    // The PDF is the READING surface, so it keeps the currency-labelled
    // amounts and the reader's own date format.
    expect(mockExportToPdf.mock.calls[0][0].tableData.rows.map((row: unknown[]) => row[4])).toEqual([
      "EUR 200.00",
      "EUR -50.00",
    ]);
    expect(mockExportToPdf.mock.calls[0][0].tableData.rows.map((row: unknown[]) => row[0])).toEqual([
      "preferred-date:2025-02-16",
      "preferred-date:2025-02-15",
    ]);
  });

  it("filters transactions by expense type", async () => {
    mockGetUncategorizedTransactions.mockResolvedValue({
      transactions: [
        {
          id: "tx-1",
          transactionDate: "2025-02-15",
          payeeName: "Store A",
          description: "",
          accountName: "Chequing",
          accountId: "acc-1",
          amount: -50,
        },
        {
          id: "tx-2",
          transactionDate: "2025-02-16",
          payeeName: "Employer",
          description: "",
          accountName: "Chequing",
          accountId: "acc-1",
          amount: 200,
        },
      ],
      summary: {
        totalCount: 2,
        expenseCount: 1,
        expenseTotal: 50,
        incomeCount: 1,
        incomeTotal: 200,
      },
    });
    render(<UncategorizedTransactionsReport />);
    await waitFor(() => {
      expect(screen.getByText("Store A")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("Expenses"));
    expect(screen.getByText("Store A")).toBeInTheDocument();
    expect(screen.queryByText("Employer")).not.toBeInTheDocument();
  });

  it("filters transactions by income type", async () => {
    mockGetUncategorizedTransactions.mockResolvedValue({
      transactions: [
        {
          id: "tx-1",
          transactionDate: "2025-02-15",
          payeeName: "Store A",
          description: "",
          accountName: "Chequing",
          accountId: "acc-1",
          amount: -50,
        },
        {
          id: "tx-2",
          transactionDate: "2025-02-16",
          payeeName: "Employer",
          description: "",
          accountName: "Chequing",
          accountId: "acc-1",
          amount: 200,
        },
      ],
      summary: {
        totalCount: 2,
        expenseCount: 1,
        expenseTotal: 50,
        incomeCount: 1,
        incomeTotal: 200,
      },
    });
    render(<UncategorizedTransactionsReport />);
    await waitFor(() => {
      expect(screen.getByText("Store A")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("Income"));
    expect(screen.queryByText("Store A")).not.toBeInTheDocument();
    expect(screen.getByText("Employer")).toBeInTheDocument();
  });

  it("sorts transactions by clicking column headers", async () => {
    mockGetUncategorizedTransactions.mockResolvedValue({
      transactions: [
        {
          id: "tx-1",
          transactionDate: "2025-02-15",
          payeeName: "Alpha",
          description: "",
          accountName: "Chequing",
          accountId: "acc-1",
          amount: -50,
        },
        {
          id: "tx-2",
          transactionDate: "2025-02-16",
          payeeName: "Beta",
          description: "",
          accountName: "Savings",
          accountId: "acc-2",
          amount: -100,
        },
      ],
      summary: {
        totalCount: 2,
        expenseCount: 2,
        expenseTotal: 150,
        incomeCount: 0,
        incomeTotal: 0,
      },
    });
    render(<UncategorizedTransactionsReport />);
    await waitFor(() => {
      expect(screen.getByText("Alpha")).toBeInTheDocument();
    });
    const payeeHeader = sortControl(1);
    fireEvent.click(payeeHeader);
    fireEvent.click(payeeHeader);
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.getByText("Beta")).toBeInTheDocument();
  });

  it("sorts by amount column", async () => {
    mockGetUncategorizedTransactions.mockResolvedValue({
      transactions: [
        {
          id: "tx-1",
          transactionDate: "2025-02-15",
          payeeName: "Store A",
          description: "",
          accountName: "Chequing",
          accountId: "acc-1",
          amount: -50,
        },
        {
          id: "tx-2",
          transactionDate: "2025-02-16",
          payeeName: "Store B",
          description: "",
          accountName: "Chequing",
          accountId: "acc-1",
          amount: -100,
        },
      ],
      summary: {
        totalCount: 2,
        expenseCount: 2,
        expenseTotal: 150,
        incomeCount: 0,
        incomeTotal: 0,
      },
    });
    render(<UncategorizedTransactionsReport />);
    await waitFor(() => {
      expect(screen.getByText("Store A")).toBeInTheDocument();
    });
    fireEvent.click(sortControl(3));
    expect(screen.getByText("Store B")).toBeInTheDocument();
  });

  it("navigates to transactions with uncategorized and account filters on row click", async () => {
    mockGetUncategorizedTransactions.mockResolvedValue({
      transactions: [
        {
          id: "tx-1",
          transactionDate: "2025-02-15",
          payeeName: "Store A",
          description: "desc",
          accountName: "Chequing",
          accountId: "acc-1",
          amount: -50,
        },
      ],
      summary: {
        totalCount: 1,
        expenseCount: 1,
        expenseTotal: 50,
        incomeCount: 0,
        incomeTotal: 0,
      },
    });
    render(<UncategorizedTransactionsReport />);
    await waitFor(() => {
      expect(screen.getByText("Store A")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("Store A"));
    expect(mockPush).toHaveBeenCalledWith(
      "/transactions?categoryIds=uncategorized&accountIds=acc-1&search=payee%3A%3D%22Store+A%22"
    );
  });

  // The row is the click target, so it has to be reachable and operable from
  // the keyboard as well (WCAG 2.1.1). Before the fix this row was a
  // `cursor-pointer` `<tr>` with an `onClick` and no `tabIndex` and no
  // `onKeyDown` -- the whole suite was green over a row no keyboard user could
  // use, so this case is what fails on that shape.
  it("activates a transaction row from the keyboard", async () => {
    mockGetUncategorizedTransactions.mockResolvedValue({
      transactions: [
        {
          id: "tx-1",
          transactionDate: "2025-02-15",
          payeeName: "Store A",
          description: "",
          accountName: "Chequing",
          accountId: "acc-1",
          amount: -50,
        },
      ],
      summary: {
        totalCount: 1,
        expenseCount: 1,
        expenseTotal: 50,
        incomeCount: 0,
        incomeTotal: 0,
      },
    });
    render(<UncategorizedTransactionsReport />);
    await waitFor(() => {
      expect(screen.getByText("Store A")).toBeInTheDocument();
    });
    const row = screen.getByText("Store A").closest("tr") as HTMLElement;
    expect(row).toHaveAttribute("tabindex", "0");

    const expected =
      "/transactions?categoryIds=uncategorized&accountIds=acc-1&search=payee%3A%3D%22Store+A%22";
    fireEvent.keyDown(row, { key: "Enter" });
    expect(mockPush).toHaveBeenCalledWith(expected);

    mockPush.mockClear();
    fireEvent.keyDown(row, { key: " " });
    expect(mockPush).toHaveBeenCalledWith(expected);

    // A key the row does not claim stays the browser's.
    mockPush.mockClear();
    fireEvent.keyDown(row, { key: "a" });
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("navigates using description when payeeName is null", async () => {
    mockGetUncategorizedTransactions.mockResolvedValue({
      transactions: [
        {
          id: "tx-1",
          transactionDate: "2025-02-15",
          payeeName: null,
          description: "Wire transfer",
          accountName: "Chequing",
          accountId: "acc-1",
          amount: -75,
        },
      ],
      summary: {
        totalCount: 1,
        expenseCount: 1,
        expenseTotal: 75,
        incomeCount: 0,
        incomeTotal: 0,
      },
    });
    render(<UncategorizedTransactionsReport />);
    await waitFor(() => {
      expect(screen.getByText("Wire transfer")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("Wire transfer"));
    expect(mockPush).toHaveBeenCalledWith(
      "/transactions?categoryIds=uncategorized&accountIds=acc-1&search=memo%3A%22Wire+transfer%22"
    );
  });

  it("navigates without search param when payeeName and description are null", async () => {
    mockGetUncategorizedTransactions.mockResolvedValue({
      transactions: [
        {
          id: "tx-1",
          transactionDate: "2025-02-15",
          payeeName: null,
          description: null,
          accountName: "Chequing",
          accountId: "acc-1",
          amount: 25,
        },
      ],
      summary: {
        totalCount: 1,
        expenseCount: 0,
        expenseTotal: 0,
        incomeCount: 1,
        incomeTotal: 25,
      },
    });
    render(<UncategorizedTransactionsReport />);
    await waitFor(() => {
      const unknowns = screen.getAllByText("Unknown");
      expect(unknowns.length).toBeGreaterThanOrEqual(1);
    });
    fireEvent.click(screen.getAllByText("Unknown")[0]);
    expect(mockPush).toHaveBeenCalledWith(
      "/transactions?categoryIds=uncategorized&accountIds=acc-1"
    );
  });

  it("renders transaction without payeeName", async () => {
    mockGetUncategorizedTransactions.mockResolvedValue({
      transactions: [
        {
          id: "tx-1",
          transactionDate: "2025-02-15",
          payeeName: null,
          description: null,
          accountName: null,
          accountId: "acc-1",
          amount: 25,
        },
      ],
      summary: {
        totalCount: 1,
        expenseCount: 0,
        expenseTotal: 0,
        incomeCount: 1,
        incomeTotal: 25,
      },
    });
    render(<UncategorizedTransactionsReport />);
    await waitFor(() => {
      const unknowns = screen.getAllByText("Unknown");
      expect(unknowns.length).toBeGreaterThanOrEqual(1);
    });
  });

  it("shows truncation message when more than 100 transactions", async () => {
    const transactions = Array.from({ length: 105 }, (_, i) => ({
      id: `tx-${i}`,
      transactionDate: "2025-02-15",
      payeeName: `Payee ${i}`,
      description: "",
      accountName: "Chequing",
      accountId: "acc-1",
      amount: -10,
    }));
    mockGetUncategorizedTransactions.mockResolvedValue({
      transactions,
      summary: {
        totalCount: 105,
        expenseCount: 105,
        expenseTotal: 1050,
        incomeCount: 0,
        incomeTotal: 0,
      },
    });
    render(<UncategorizedTransactionsReport />);
    await waitFor(() => {
      expect(
        screen.getByText(/Showing first 100 of 105 transactions/),
      ).toBeInTheDocument();
    });
  });

  it("surfaces a retryable error state when the API fails", async () => {
    mockGetUncategorizedTransactions.mockRejectedValue(
      new Error("Network error"),
    );
    render(<UncategorizedTransactionsReport />);
    await waitFor(() => {
      expect(screen.getByText(/failed to load report data/i)).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
  });

  it("sorts by account column", async () => {
    mockGetUncategorizedTransactions.mockResolvedValue({
      transactions: [
        {
          id: "tx-1",
          transactionDate: "2025-02-15",
          payeeName: "Store A",
          description: "",
          accountName: "Zeta Account",
          accountId: "acc-1",
          amount: -50,
        },
        {
          id: "tx-2",
          transactionDate: "2025-02-16",
          payeeName: "Store B",
          description: "",
          accountName: "Alpha Account",
          accountId: "acc-2",
          amount: -100,
        },
      ],
      summary: {
        totalCount: 2,
        expenseCount: 2,
        expenseTotal: 150,
        incomeCount: 0,
        incomeTotal: 0,
      },
    });
    render(<UncategorizedTransactionsReport />);
    await waitFor(() => {
      expect(screen.getByText("Store A")).toBeInTheDocument();
    });
    fireEvent.click(sortControl(2));
    expect(screen.getByText("Zeta Account")).toBeInTheDocument();
    expect(screen.getByText("Alpha Account")).toBeInTheDocument();
  });

  it("exports CSV with the current transaction data", async () => {
    mockGetUncategorizedTransactions.mockResolvedValue({
      transactions: [
        {
          id: "tx-1",
          transactionDate: "2025-02-15",
          payeeName: "Store A",
          description: "Coffee",
          accountName: "Chequing",
          accountId: "acc-1",
          amount: -50,
          currencyCode: "EUR",
        },
      ],
      summary: {
        totalCount: 1,
        expenseCount: 1,
        expenseTotal: 50,
        incomeCount: 0,
        incomeTotal: 0,
      },
    });
    render(<UncategorizedTransactionsReport />);
    await waitFor(() => {
      expect(screen.getByTestId("export-csv")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("export-csv"));
    expect(mockExportToCsv).toHaveBeenCalledWith(
      "uncategorized-transactions",
      expect.arrayContaining(["Date", "Payee", "Description", "Account", "Amount"]),
      expect.any(Array),
    );
    // A CSV is machine-read, so the date is ISO and NOT the reader's preferred
    // format: two readers exporting the same rows must get one file, and
    // `preferred-date:...` here would mean a localized, ambiguous,
    // lexicographically-unsortable date column.
    expect(mockExportToCsv.mock.calls[0][2][0][0]).toBe("2025-02-15");
    // ...and the amount is a NUMBER, not a formatted string. `csv-export.ts`'s
    // injection guard tab-prefixes a `-`-leading value it cannot read as a
    // number, and a currency whose narrow symbol is written in letters (`zl`,
    // `kr`, `CHF`, `R$`) is exactly that -- which makes Excel store the cell as
    // text and the column stop adding up (issue #1134).
    expect(mockExportToCsv.mock.calls[0][2][0][4]).toBe(-50);
    expect(typeof mockExportToCsv.mock.calls[0][2][0][4]).toBe("number");
  });

  it("exports PDF with the current transaction data", async () => {
    mockGetUncategorizedTransactions.mockResolvedValue({
      transactions: [
        {
          id: "tx-1",
          transactionDate: "2025-02-15",
          payeeName: null,
          description: null,
          accountName: null,
          accountId: "acc-1",
          amount: -50,
          currencyCode: "EUR",
        },
      ],
      summary: {
        totalCount: 1,
        expenseCount: 1,
        expenseTotal: 50,
        incomeCount: 0,
        incomeTotal: 0,
      },
    });
    render(<UncategorizedTransactionsReport />);
    await waitFor(() => {
      expect(screen.getByTestId("export-pdf")).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("export-pdf"));
    });
    await waitFor(() => {
      expect(mockExportToPdf).toHaveBeenCalledTimes(1);
    });
    expect(mockExportToPdf).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Uncategorized Transactions",
        filename: "uncategorized-transactions",
        tableData: expect.objectContaining({
          headers: expect.any(Array),
          rows: expect.any(Array),
        }),
      }),
    );
    // The other half of the CSV split: a PDF is a READING surface, so both the
    // date and the amount carry the reader's own formats here.
    expect(mockExportToPdf.mock.calls[0][0].tableData.rows[0][0]).toBe(
      "preferred-date:2025-02-15",
    );
    expect(mockExportToPdf.mock.calls[0][0].tableData.rows[0][4]).toBe(
      "EUR -50.00",
    );
  });

  it("marks null summary totals as subtotals and keeps an unconverted row in its own currency", async () => {
    mockGetUncategorizedTransactions.mockResolvedValue({
      transactions: [
        {
          id: "tx-cad",
          transactionDate: "2025-02-15",
          payeeName: "Local Store",
          description: "",
          accountName: "Chequing",
          accountId: "acc-1",
          amount: -50,
          currencyCode: "CAD",
        },
        {
          id: "tx-jpy",
          transactionDate: "2025-02-16",
          payeeName: "Tokyo Store",
          description: "",
          accountName: "Yen Account",
          accountId: "acc-2",
          amount: -5000,
          currencyCode: "JPY",
        },
      ],
      summary: {
        totalCount: 2,
        expenseCount: 2,
        expenseTotal: null,
        knownExpenseTotal: 50,
        incomeCount: 0,
        incomeTotal: null,
        knownIncomeTotal: 0,
        currencyCode: "CAD",
      },
      currency: "CAD",
      missingCurrencies: ["JPY"],
      excludedCount: 1,
    });
    render(<UncategorizedTransactionsReport />);
    await waitFor(() => expect(screen.getByText("Tokyo Store")).toBeInTheDocument());
    const markers = screen.getAllByTestId("partial-total");
    // Expense and income totals are both withheld; each is marked.
    expect(markers).toHaveLength(2);
    expect(markers[0]).toHaveTextContent("$50.00");
    expect(markers[1]).toHaveTextContent("$0.00");
    // The row keeps its own currency; it is never relabelled as CAD.
    expect(screen.getByText("JPY -5000.00")).toBeInTheDocument();
    expect(screen.getByText("$-50.00")).toBeInTheDocument();
  });

  // The toolbar holds the date controls, so it stays mounted while the report
  // reloads and after a failed load: an early return for either state would
  // unmount it, and the focus of whoever is using it.
  it('keeps the toolbar mounted while loading and after a failed load', async () => {
    let fail!: (error: Error) => void;
    mockGetUncategorizedTransactions.mockReturnValue(
      new Promise((_resolve, reject) => {
        fail = reject;
      }),
    );
    render(<UncategorizedTransactionsReport />);
    const toolbar = screen.getByTestId('date-range-selector');
    expect(document.querySelector('.animate-pulse')).toBeTruthy();

    await act(async () => {
      fail(new Error('boom'));
    });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Try Again' })).toBeInTheDocument();
    });
    expect(screen.getByTestId('date-range-selector')).toBe(toolbar);
  });

});
