import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@/test/render";
import { SpendingByCategoryReport } from "./SpendingByCategoryReport";

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

vi.mock("@/lib/chart-colours", () => ({
  CHART_COLOURS: ["#22c55e", "#3b82f6", "#8b5cf6"],
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

const mockGetSpendingByCategory = vi.fn();
const mockGetIncomeVsExpenses = vi.fn();
vi.mock("@/lib/built-in-reports", () => ({
  builtInReportsApi: {
    getSpendingByCategory: (...args: any[]) => mockGetSpendingByCategory(...args),
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

const SPENDING = (over: Record<string, unknown> = {}) => ({
  data: [{ categoryId: "cat-1", categoryName: "Groceries", total: 8486, color: "" }],
  totalSpending: 8486,
  knownSpending: 8486,
  currency: "CAD",
  missingCurrencies: [],
  excludedCount: 0,
  ...over,
});

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

const funding = (buckets: unknown[], over: Record<string, unknown> = {}) => ({
  data: [],
  totals: { income: 3279, expenses: 8486, net: -5207, knownIncome: 3279, knownExpenses: 8486, knownNet: -5207 },
  currency: "CAD",
  missingCurrencies: [],
  excludedCount: 0,
  tagKey: "scope",
  buckets,
  ...over,
});

async function renderReport() {
  await act(async () => {
    render(<SpendingByCategoryReport />);
  });
  await waitFor(() => expect(screen.getAllByText("Groceries").length).toBeGreaterThan(0));
}

async function chooseScopeHousehold() {
  await act(async () => {
    fireEvent.change(screen.getByLabelText("Break down by tag key"), { target: { value: "scope" } });
  });
  await act(async () => {
    fireEvent.change(screen.getByLabelText("Tag value"), { target: { value: "household" } });
  });
}

const turnSwitchOn = async () => {
  await act(async () => {
    fireEvent.click(screen.getByRole("switch", { name: "Include tagged transfers" }));
  });
};

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const WINDOW = { startDate: "2024-01-01", endDate: "2025-01-01" };

describe("SpendingByCategoryReport funding view", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    mockGetSpendingByCategory.mockResolvedValue(SPENDING());
    mockGetAllAccounts.mockResolvedValue([]);
    mockGetAllTags.mockResolvedValue([
      { id: "t1", name: "scope:household" },
      { id: "t2", name: "scope:stall" },
    ]);
  });

  it("is today's request with no tag key: no filter params, no funding call, no strip", async () => {
    mockGetAllTags.mockResolvedValue([]);
    await renderReport();
    expect(mockGetSpendingByCategory).toHaveBeenCalledWith(WINDOW);
    expect(mockGetIncomeVsExpenses).not.toHaveBeenCalled();
    expect(screen.queryByTestId("tagged-funds-strip")).not.toBeInTheDocument();
  });

  it("keeps 'All values' and never selects a value for the user: an empty value is no tag filter", async () => {
    mockGetAllTags.mockResolvedValue([{ id: "t1", name: "scope:household" }]);
    await renderReport();
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Break down by tag key"), { target: { value: "scope" } });
    });
    const select = screen.getByLabelText("Tag value");
    expect(select).toHaveValue("");
    expect(Array.from(select.querySelectorAll("option")).map((o) => o.textContent)).toEqual([
      "All values",
      "household",
    ]);
    expect(mockGetSpendingByCategory.mock.calls.at(-1)?.[0]).not.toHaveProperty("tagValue");
  });

  it("sends no filter for a key alone", async () => {
    await renderReport();
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Break down by tag key"), { target: { value: "scope" } });
    });
    expect(mockGetSpendingByCategory).toHaveBeenLastCalledWith(WINDOW);
  });

  it("filters the report to the value, with no strip and no funding call while the switch is off", async () => {
    await renderReport();
    await chooseScopeHousehold();
    await waitFor(() =>
      expect(mockGetSpendingByCategory).toHaveBeenLastCalledWith({
        ...WINDOW,
        tagKey: "scope",
        tagValue: "household",
      }),
    );
    expect(mockGetIncomeVsExpenses).not.toHaveBeenCalled();
    expect(screen.queryByTestId("tagged-funds-strip")).not.toBeInTheDocument();
  });

  it("drops the filter again when the key is cleared", async () => {
    await renderReport();
    await chooseScopeHousehold();
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Break down by tag key"), { target: { value: "" } });
    });
    await waitFor(() => expect(mockGetSpendingByCategory).toHaveBeenLastCalledWith(WINDOW));
  });

  it("shows Available funds, Spent and Balance: 3,279 + 4,516 against 8,486 is -691, -8.86%", async () => {
    mockGetIncomeVsExpenses.mockResolvedValue(funding([bucket()]));
    await renderReport();
    await chooseScopeHousehold();
    await turnSwitchOn();

    await waitFor(() => expect(screen.getByTestId("tagged-funds-strip")).toHaveTextContent("Available funds"));
    expect(mockGetIncomeVsExpenses).toHaveBeenCalledWith({
      ...WINDOW,
      bucket: "month",
      tagKey: "scope",
    });
    const strip = screen.getByTestId("tagged-funds-strip");
    expect(strip).toHaveTextContent("$3279.00");
    expect(strip).toHaveTextContent("Tagged transfers: household");
    expect(strip).toHaveTextContent("$4516.00");
    expect(strip).toHaveTextContent("$7795.00");
    expect(strip).toHaveTextContent("Spent");
    expect(strip).toHaveTextContent("$8486.00");
    expect(strip).toHaveTextContent("$-691.00");
    expect(strip).toHaveTextContent("-8.86%");
  });

  it("marks Balance partial and withholds the percentage when spending lost a rate", async () => {
    mockGetSpendingByCategory.mockResolvedValue(
      SPENDING({ totalSpending: null, missingCurrencies: ["EUR"], excludedCount: 1 }),
    );
    mockGetIncomeVsExpenses.mockResolvedValue(funding([bucket()]));
    await renderReport();
    await chooseScopeHousehold();
    await turnSwitchOn();
    await waitFor(() => expect(screen.getByTestId("tagged-funds-strip")).toHaveTextContent("Available funds"));
    const strip = screen.getByTestId("tagged-funds-strip");
    expect(strip.querySelectorAll('[data-testid="partial-total"]').length).toBeGreaterThan(0);
    expect(strip).not.toHaveTextContent("-8.86%");
    expect(strip).toHaveTextContent("\u2014");
  });

  it("treats a value with no bucket as known-zero tagged transfers", async () => {
    mockGetIncomeVsExpenses.mockResolvedValue(funding([bucket({ value: "stall" })]));
    await renderReport();
    await chooseScopeHousehold();
    await turnSwitchOn();
    await waitFor(() => expect(screen.getByTestId("tagged-funds-strip")).toHaveTextContent("Available funds"));
    // 3,279 income + 0 tagged against 8,486 spent.
    expect(screen.getByTestId("tagged-funds-strip")).toHaveTextContent("$3279.00");
    expect(screen.getByTestId("tagged-funds-strip")).toHaveTextContent("$-5207.00");
  });

  it("says so when the funding request fails, leaving the report in place", async () => {
    mockGetIncomeVsExpenses.mockRejectedValue(new Error("boom"));
    await renderReport();
    await chooseScopeHousehold();
    await turnSwitchOn();
    await waitFor(() =>
      expect(screen.getByText("The tagged transfer figures could not be loaded.")).toBeInTheDocument(),
    );
    expect(screen.getAllByText("Groceries").length).toBeGreaterThan(0);
  });

  it("sends the account filter to the report and to the funding fetch", async () => {
    mockGetAllAccounts.mockResolvedValue([
      { id: ACCOUNT, name: "Checking", accountType: "CHEQUING", isClosed: false },
    ]);
    window.localStorage.setItem(
      "monize-reports-spending-by-category-accounts",
      JSON.stringify([ACCOUNT]),
    );
    mockGetIncomeVsExpenses.mockResolvedValue(funding([bucket()]));
    await renderReport();
    expect(mockGetSpendingByCategory).toHaveBeenLastCalledWith({ ...WINDOW, accountIds: [ACCOUNT] });
    await chooseScopeHousehold();
    await turnSwitchOn();
    await waitFor(() => expect(mockGetIncomeVsExpenses).toHaveBeenCalled());
    expect(mockGetIncomeVsExpenses).toHaveBeenLastCalledWith({
      ...WINDOW,
      bucket: "month",
      tagKey: "scope",
      accountIds: [ACCOUNT],
    });
    expect(mockGetSpendingByCategory).toHaveBeenLastCalledWith({
      ...WINDOW,
      accountIds: [ACCOUNT],
      tagKey: "scope",
      tagValue: "household",
    });
  });
});
