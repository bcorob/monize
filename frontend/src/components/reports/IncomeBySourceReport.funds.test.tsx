import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@/test/render";
import { IncomeBySourceReport } from "./IncomeBySourceReport";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("@/hooks/useNumberFormat", async () => {
  const { numberFormatMockDefaults } = await import("@/test/number-format-mock");
  return {
    useNumberFormat: () => ({
      ...numberFormatMockDefaults(),
      formatCurrencyCompact: (n: number) => `$${n.toFixed(2)}`,
      formatCurrency: (n: number) => `$${n.toFixed(2)}`,
      formatCurrencyAxis: (n: number) => `$${n}`,
      formatPercent: (n: number, d = 1) => `${n.toFixed(d)}%`,
      defaultCurrency: "CAD",
    }),
  };
});

vi.mock("@/hooks/useDateRange", () => ({
  useDateRange: () => ({
    dateRange: "1y",
    setDateRange: vi.fn(),
    startDate: "",
    setStartDate: vi.fn(),
    endDate: "",
    setEndDate: vi.fn(),
    resolvedRange: { start: "2024-01-01", end: "2025-01-01" },
    isValid: true,
  }),
}));

vi.mock("@/components/ui/DateRangeSelector", () => ({
  DateRangeSelector: () => <div data-testid="date-range-selector" />,
}));

vi.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: any) => <div>{children}</div>,
  PieChart: ({ children }: any) => <div>{children}</div>,
  Pie: () => null,
  Cell: () => null,
  Tooltip: () => null,
  BarChart: ({ children }: any) => <div>{children}</div>,
  Bar: () => null,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
}));

const mockGetIncomeBySource = vi.fn();
const mockGetIncomeVsExpenses = vi.fn();
vi.mock("@/lib/built-in-reports", () => ({
  builtInReportsApi: {
    getIncomeBySource: (...args: any[]) => mockGetIncomeBySource(...args),
    getIncomeVsExpenses: (...args: any[]) => mockGetIncomeVsExpenses(...args),
  },
}));

const mockGetAllAccounts = vi.fn();
vi.mock("@/lib/accounts", () => ({
  accountsApi: { getAll: (...args: any[]) => mockGetAllAccounts(...args) },
}));

const mockGetAllTags = vi.fn();
vi.mock("@/lib/tags", () => ({
  tagsApi: { getAll: (...args: any[]) => mockGetAllTags(...args) },
}));

vi.mock("@/lib/logger", () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

const INCOME = {
  data: [
    { categoryId: "cat-1", categoryName: "Salary", total: 3279, color: "" },
  ],
  totalIncome: 3279,
};

const bucket = (over: Record<string, unknown> = {}) => ({
  value: "household",
  isUntagged: false,
  data: [],
  totals: { income: 0, expenses: 0, net: 0, knownIncome: 0, knownExpenses: 0, knownNet: 0 },
  taggedInflows: 4516,
  taggedOutflows: 0,
  missingCurrencies: [],
  excludedCount: 0,
  ...over,
});

const funding = (buckets: unknown[]) => ({
  data: [],
  totals: { income: 3279, expenses: 0, net: 3279, knownIncome: 3279, knownExpenses: 0, knownNet: 3279 },
  currency: "CAD",
  missingCurrencies: [],
  excludedCount: 0,
  tagKey: "scope",
  buckets,
});

async function renderReport() {
  await act(async () => {
    render(<IncomeBySourceReport />);
  });
  await waitFor(() => expect(screen.getByText("Salary")).toBeInTheDocument());
}

async function chooseScopeHousehold() {
  await act(async () => {
    fireEvent.change(screen.getByLabelText("Break down by tag key"), {
      target: { value: "scope" },
    });
  });
  await act(async () => {
    fireEvent.change(screen.getByLabelText("Tag value"), {
      target: { value: "household" },
    });
  });
}

const turnSwitchOn = async () => {
  await act(async () => {
    fireEvent.click(screen.getByRole("switch", { name: "Include tagged transfers" }));
  });
};

describe("IncomeBySourceReport funding view", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    mockGetIncomeBySource.mockResolvedValue(INCOME);
    mockGetAllAccounts.mockResolvedValue([]);
    mockGetAllTags.mockResolvedValue([
      { id: "t1", name: "scope:household" },
      { id: "t2", name: "scope:stall" },
      { id: "t3", name: "plain" },
    ]);
  });

  it("is today's report with no tag key: no extra call, no strip, no account scope sent", async () => {
    mockGetAllTags.mockResolvedValue([]);
    await renderReport();
    expect(mockGetIncomeBySource).toHaveBeenCalledWith({
      startDate: "2024-01-01",
      endDate: "2025-01-01",
    });
    expect(mockGetIncomeVsExpenses).not.toHaveBeenCalled();
    expect(screen.queryByTestId("tagged-funds-strip")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Break down by tag key")).not.toBeInTheDocument();
    expect(screen.queryByText("Available funds")).not.toBeInTheDocument();
  });

  it("offers the values of the key and no untagged choice", async () => {
    await renderReport();
    await chooseScopeHousehold();
    const options = Array.from(
      screen.getByLabelText("Tag value").querySelectorAll("option"),
    ).map((o) => o.textContent);
    // The empty choice shows nothing here, so it never reads "All values".
    expect(options).toEqual(["Select a value", "household", "stall"]);
  });

  it("selects the only value of a key, so the switch is offered at once", async () => {
    mockGetAllTags.mockResolvedValue([
      { id: "t1", name: "scope:household" },
      { id: "t2", name: "plain" },
    ]);
    await renderReport();
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Break down by tag key"), {
        target: { value: "scope" },
      });
    });
    expect(screen.getByLabelText("Tag value")).toHaveValue("household");
    expect(
      screen.getByRole("switch", { name: "Include tagged transfers" }),
    ).toBeInTheDocument();
  });

  it("leaves a key with several values unselected", async () => {
    await renderReport();
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Break down by tag key"), {
        target: { value: "scope" },
      });
    });
    expect(screen.getByLabelText("Tag value")).toHaveValue("");
    expect(
      screen.queryByRole("switch", { name: "Include tagged transfers" }),
    ).not.toBeInTheDocument();
  });

  it("changes nothing while the switch is off, even with a key and a value chosen", async () => {
    await renderReport();
    await chooseScopeHousehold();
    expect(mockGetIncomeVsExpenses).not.toHaveBeenCalled();
    expect(screen.queryByTestId("tagged-funds-strip")).not.toBeInTheDocument();
    expect(screen.queryByText(/Tagged transfers:/)).not.toBeInTheDocument();
  });

  it("shows the tagged entry and Available funds with the switch on, leaving income and shares alone", async () => {
    mockGetIncomeVsExpenses.mockResolvedValue(funding([bucket()]));
    await renderReport();
    await chooseScopeHousehold();
    await turnSwitchOn();

    await waitFor(() => expect(screen.getByTestId("tagged-funds-strip")).toBeInTheDocument());
    expect(mockGetIncomeVsExpenses).toHaveBeenCalledWith({
      startDate: "2024-01-01",
      endDate: "2025-01-01",
      bucket: "month",
      tagKey: "scope",
    });
    const strip = screen.getByTestId("tagged-funds-strip");
    // 3,279 income + 4,516 tagged = 7,795 available.
    expect(strip).toHaveTextContent("Available funds");
    expect(strip).toHaveTextContent("$7795.00");
    expect(strip).toHaveTextContent("$4516.00");
    // The legend carries the extra, visibly-not-income entry...
    expect(screen.getAllByText("Tagged transfers: household").length).toBeGreaterThan(0);
    expect(screen.getByText("$4516.00 (Not income)")).toBeInTheDocument();
    // ...Salary is still 100% of INCOME and Total Income is unchanged.
    expect(screen.getByText("$3279.00 (100.0%)")).toBeInTheDocument();
    expect(screen.getByText("Total Income")).toBeInTheDocument();
    expect(screen.queryByText("$7795.00", { selector: "div" })).toBeNull();
  });

  it("nets tagged outflows off the entry", async () => {
    mockGetIncomeVsExpenses.mockResolvedValue(
      funding([bucket({ taggedInflows: 4516, taggedOutflows: 600 })]),
    );
    await renderReport();
    await chooseScopeHousehold();
    await turnSwitchOn();
    await waitFor(() => expect(screen.getByTestId("tagged-funds-strip")).toHaveTextContent("$7195.00"));
    expect(screen.getByTestId("tagged-funds-strip")).toHaveTextContent("$3916.00");
  });

  it.each([
    ["balanced flows", bucket({ taggedInflows: 500, taggedOutflows: 500 })],
    ["net outflow", bucket({ taggedInflows: 0, taggedOutflows: 1000 })],
  ])("shows nothing and says so for %s", async (_name, b) => {
    mockGetIncomeVsExpenses.mockResolvedValue(funding([b]));
    await renderReport();
    await chooseScopeHousehold();
    await turnSwitchOn();
    await waitFor(() =>
      expect(
        screen.getByText("No net tagged inflow for this value in this period."),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByText("Available funds")).not.toBeInTheDocument();
    expect(screen.queryByText(/Tagged transfers:/)).not.toBeInTheDocument();
  });

  it("treats a value with no bucket as a known zero", async () => {
    mockGetIncomeVsExpenses.mockResolvedValue(funding([bucket({ value: "stall" })]));
    await renderReport();
    await chooseScopeHousehold();
    await turnSwitchOn();
    await waitFor(() =>
      expect(
        screen.getByText("No net tagged inflow for this value in this period."),
      ).toBeInTheDocument(),
    );
  });

  it("never reads the untagged bucket as a value", async () => {
    mockGetIncomeVsExpenses.mockResolvedValue(
      funding([bucket({ value: "household", isUntagged: true })]),
    );
    await renderReport();
    await chooseScopeHousehold();
    await turnSwitchOn();
    await waitFor(() =>
      expect(
        screen.getByText("No net tagged inflow for this value in this period."),
      ).toBeInTheDocument(),
    );
  });

  it("marks Available funds partial when the bucket lost a rate", async () => {
    mockGetIncomeVsExpenses.mockResolvedValue(
      funding([bucket({ missingCurrencies: ["EUR"], excludedCount: 1 })]),
    );
    await renderReport();
    await chooseScopeHousehold();
    await turnSwitchOn();
    await waitFor(() => expect(screen.getAllByTestId("partial-total").length).toBeGreaterThan(0));
  });

  it("says so when the funding request fails", async () => {
    mockGetIncomeVsExpenses.mockRejectedValue(new Error("boom"));
    await renderReport();
    await chooseScopeHousehold();
    await turnSwitchOn();
    await waitFor(() =>
      expect(
        screen.getByText("The tagged transfer figures could not be loaded."),
      ).toBeInTheDocument(),
    );
  });

  it("sends the account filter to the report and to the funding fetch", async () => {
    mockGetAllAccounts.mockResolvedValue([
      { id: "11111111-1111-4111-8111-111111111111", name: "Checking", accountType: "CHEQUING", isClosed: false },
    ]);
    window.localStorage.setItem(
      "monize-reports-income-by-source-accounts",
      JSON.stringify(["11111111-1111-4111-8111-111111111111"]),
    );
    mockGetIncomeVsExpenses.mockResolvedValue(funding([bucket()]));
    await renderReport();
    expect(mockGetIncomeBySource).toHaveBeenLastCalledWith({
      startDate: "2024-01-01",
      endDate: "2025-01-01",
      accountIds: ["11111111-1111-4111-8111-111111111111"],
    });
    await chooseScopeHousehold();
    await turnSwitchOn();
    await waitFor(() => expect(mockGetIncomeVsExpenses).toHaveBeenCalled());
    expect(mockGetIncomeVsExpenses).toHaveBeenLastCalledWith({
      startDate: "2024-01-01",
      endDate: "2025-01-01",
      bucket: "month",
      tagKey: "scope",
      accountIds: ["11111111-1111-4111-8111-111111111111"],
    });
  });
});
