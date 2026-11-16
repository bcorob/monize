import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, fireEvent, waitFor, within } from "@/test/render";
import { GemStrategyReport } from "./GemStrategyReport";
import { gemAction, gemHistory, gemReport } from "@/test/gem-fixtures";

vi.mock("recharts", async () =>
  (await import("@/test/recharts-mock")).rechartsMock(),
);

const mockPush = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}));

const mockGetReport = vi.fn();
const mockMarkExecuted = vi.fn();
const mockCreateStrategy = vi.fn();
const mockUpdateConfig = vi.fn();
const mockDeleteStrategy = vi.fn();
vi.mock("@/lib/gem-strategy", () => ({
  gemStrategyApi: {
    getReport: (...args: unknown[]) => mockGetReport(...args),
    markExecuted: (...args: unknown[]) => mockMarkExecuted(...args),
    createStrategy: (...args: unknown[]) => mockCreateStrategy(...args),
    updateConfig: (...args: unknown[]) => mockUpdateConfig(...args),
    deleteStrategy: (...args: unknown[]) => mockDeleteStrategy(...args),
  },
}));

const mockToastSuccess = vi.fn();
const mockToastError = vi.fn();
vi.mock("react-hot-toast", () => ({
  default: {
    success: (message: string) => mockToastSuccess(message),
    error: (message: string) => mockToastError(message),
  },
}));

vi.mock("@/lib/accounts", () => ({
  accountsApi: { getAll: vi.fn().mockResolvedValue([]) },
}));

vi.mock("@/lib/investments", () => ({
  investmentsApi: { getSecurities: vi.fn().mockResolvedValue([]) },
}));

vi.mock("@/lib/logger", () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

async function renderReport() {
  let result: ReturnType<typeof render>;
  await act(async () => {
    result = render(<GemStrategyReport />);
  });
  return result!;
}

describe("GemStrategyReport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetReport.mockResolvedValue(gemReport());
  });

  it("answers the four questions on the overview tab", async () => {
    await renderReport();

    // 1. What is the signal?
    expect(
      screen.getByRole("heading", { level: 1, name: "GEM" }),
    ).toBeInTheDocument();
    expect(screen.getByText("RISK-ON")).toBeInTheDocument();
    expect(
      screen.getByText("100% iShares MSCI EM IMI ETF"),
    ).toBeInTheDocument();

    // 2. Why this instrument?
    expect(
      screen.getByText("Stay in equities, or move to bonds?"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Staying in equities — which market?"),
    ).toBeInTheDocument();
    expect(screen.getByText("EMIM leads SPY by 14.45 pp.")).toBeInTheDocument();

    // 3. Is my portfolio aligned?
    expect(
      screen.getAllByText("In the target instrument").length,
    ).toBeGreaterThan(0);
    expect(
      screen.getByRole("progressbar", { name: "In the target instrument" }),
    ).toHaveAttribute("aria-valuenow", "64");

    // 4. What should I do?
    expect(
      screen.getByRole("heading", { name: /What should I do\?/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Mark as executed/ }),
    ).toBeInTheDocument();

    // The report footer carries the caveats and provenance.
    expect(
      screen.getByText(/Past results do not guarantee/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "example.test/gem" }),
    ).toBeInTheDocument();
  });

  it("requests the 1Y range first and refetches when the range changes", async () => {
    await renderReport();
    // The first read leaves the scenario to the server.
    expect(mockGetReport).toHaveBeenCalledWith("1Y", undefined);

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "MAX", pressed: false }),
      );
    });
    // ...and every read after it names the scenario that came back. An unset
    // selection means "whichever the server picks", and asking that a second
    // time is a different question: if the report on screen has since been
    // deleted, the range change would silently move the user to another one.
    expect(mockGetReport).toHaveBeenLastCalledWith("MAX", "strategy-1");
    expect(screen.getByRole("button", { name: "MAX" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("shows a retryable error when the report cannot be loaded", async () => {
    mockGetReport.mockRejectedValue(new Error("boom"));
    await renderReport();
    await act(async () => {});
    await waitFor(() =>
      expect(
        screen.getByText("The GEM strategy report could not be loaded."),
      ).toBeInTheDocument(),
    );

    mockGetReport.mockResolvedValue(gemReport());
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Try Again" }));
    });
    expect(screen.getByText("RISK-ON")).toBeInTheDocument();
  });

  it("marks the operation as executed and reloads the report", async () => {
    mockMarkExecuted.mockResolvedValue(
      gemReport({ action: gemAction({ executed: true }) }),
    );
    await renderReport();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Mark as executed/ }));
    });

    // The scenario is named, not left to the server to pick again: the id and
    // the signal have to describe the same report.
    expect(mockMarkExecuted).toHaveBeenCalledWith(
      "signal-1",
      "1Y",
      "strategy-1",
    );
    expect(mockToastSuccess).toHaveBeenCalledWith(
      "Operation marked as executed.",
    );
    // The call answers with the refreshed report, so there is nothing left to
    // fetch -- re-reading it was a round trip that could only return the same.
    expect(mockGetReport).toHaveBeenCalledTimes(1);
    // The fixture's accounts still hold the wrong instrument, so the card
    // reports both facts rather than hiding the live instruction behind a tick.
    expect(
      screen.getByText(
        /You marked this as done, but these accounts still do not match/,
      ),
    ).toBeInTheDocument();
  });

  it("surfaces a failure to mark the operation as executed", async () => {
    mockMarkExecuted.mockRejectedValue(new Error("nope"));
    await renderReport();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Mark as executed/ }));
    });
    await act(async () => {});

    expect(mockToastError).toHaveBeenCalledWith(
      "Could not mark the operation as executed.",
    );
  });

  it("sends the user to the investments page to enter the trades", async () => {
    await renderReport();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Add transactions/ }));
    });
    expect(mockPush).toHaveBeenCalledWith("/investments");
  });

  it('switches tabs, including from the "see full history" link', async () => {
    // More rows than the overview shows, so the "see full history" link appears.
    mockGetReport.mockResolvedValue(
      gemReport({
        history: [
          ...gemHistory(),
          ...gemHistory().map((entry, index) => ({
            ...entry,
            id: `${entry.id}-older`,
            evaluatedOn: `2025-0${index + 1}-01`,
          })),
        ],
      }),
    );
    await renderReport();

    await act(async () => {
      fireEvent.click(screen.getByRole("tab", { name: "My portfolio" }));
    });
    expect(screen.getByRole("tab", { name: "My portfolio" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByText("Strategy position")).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("tab", { name: "Backtest" }));
    });
    expect(screen.getByText("Annualized return")).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("tab", { name: "Settings" }));
    });
    expect(screen.getByText("Strategy configuration")).toBeInTheDocument();
    // The tab is editable: assigning the roles is what starts a strategy.
    expect(
      screen.getByRole("button", { name: "Save configuration" }),
    ).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("tab", { name: "Overview" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /See full history/ }));
    });
    expect(screen.getByRole("tab", { name: "Signals" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("opens the settings tab from the header button", async () => {
    await renderReport();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Edit settings/ }));
    });
    expect(screen.getByRole("tab", { name: "Settings" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("renders the first-run state without inventing values", async () => {
    mockGetReport.mockResolvedValue(
      gemReport({
        signal: null,
        position: null,
        action: null,
        performance: null,
        history: [],
        backtest: null,
        warnings: [{ code: "FIRST_RUN" }, { code: "NO_ACCOUNT" }],
      }),
    );
    await renderReport();

    expect(screen.getByText("No signal yet")).toBeInTheDocument();
    expect(screen.getByText("No account assigned")).toBeInTheDocument();
    // A missing signal is the earlier state and keeps its own copy.
    expect(screen.getByText("Nothing to transfer")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Nothing moves until the strategy produces its first signal.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("No price history")).toBeInTheDocument();
    expect(screen.getByText("No evaluations yet")).toBeInTheDocument();
    expect(
      screen.getByText("There is no signal to act on yet."),
    ).toBeInTheDocument();
    // The first-run notice is explained once, in the banner.
    expect(
      screen.getByText(/has not been evaluated yet —/),
    ).toBeInTheDocument();
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });

  it("reports stale prices and unmapped roles above the cards", async () => {
    mockGetReport.mockResolvedValue(
      gemReport({
        warnings: [
          { code: "STALE_PRICES", roles: ["EX_US_EQUITY"] },
          { code: "UNMAPPED_ROLE", roles: ["SAFE"] },
        ],
      }),
    );
    await renderReport();

    expect(
      screen.getByText(/prices behind this report are not current/),
    ).toBeInTheDocument();
    // The warning names the instrument whose price is behind, not a date the
    // user then has to match to a role themselves. Scoped to the banner: the
    // role is named again by the assets card further down the page.
    expect(
      within(screen.getAllByRole("status")[0]).getByText(
        /Developed markets ex-US/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/No instrument is assigned to:/),
    ).toBeInTheDocument();
  });

  /**
   * The report on screen and the scenario selected can drift apart, because
   * the loader keeps the previous report visible while the next one arrives.
   * That is the right thing to look at and the wrong thing to act on: between
   * picking scenario B and B's report landing, the page still shows A -- A's
   * signal id on the button, A's settings in the form. Every one of these
   * proved reproducible against the unkeyed state.
   */
  describe("a selection the rendered report does not describe", () => {
    /** A promise the test resolves when it chooses. */
    const deferred = <T,>() => {
      let settle: (value: T) => void = () => {};
      const promise = new Promise<T>((resolve) => {
        settle = resolve;
      });
      return { promise, settle };
    };

    const switchRange = async (label: string) => {
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: label }));
      });
    };

    /**
     * Invariant: the page's selection is whatever the report it is showing
     * actually describes.
     * Canonical adversarial input: the server answering a different question
     * from the one asked (testing contract, asynchronous / ownership).
     * Minimal mutation: drop `keyForResult` from the `useReportData` options,
     * so the fallback report is stamped with the key it was requested under.
     * Test that fails under it: this one -- the mutation goes out naming the
     * scenario that no longer exists.
     */
    it("moves the selection onto the scenario the server fell back to", async () => {
      // Two scenarios, B selected.
      const withBoth = (id: string) => {
        const report = gemReport();
        report.strategy = { ...report.strategy, id, name: id };
        report.strategies = [
          { id: "strategy-1", name: "strategy-1" },
          { id: "strategy-2", name: "strategy-2" },
        ];
        return report;
      };
      mockGetReport.mockResolvedValue(withBoth("strategy-2"));
      await renderReport();
      // The first read settles the selection on what came back, so the page is
      // now explicitly on B rather than on "whichever the server picks".
      expect(mockGetReport).toHaveBeenCalledWith("1Y", undefined);

      // B is deleted elsewhere, so the next read asks for B and gets A.
      const loadsBefore = mockGetReport.mock.calls.length;
      mockGetReport.mockResolvedValue(withBoth("strategy-1"));
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: "3M", pressed: false }),
        );
      });
      await act(async () => {});

      // The range change asked for the scenario that is gone...
      expect(mockGetReport).toHaveBeenCalledWith("3M", "strategy-2");
      // ...and the fallback it got is on screen, with the selection moved onto
      // it: one read for the range change, and no second one chasing B.
      expect(mockGetReport.mock.calls.length).toBe(loadsBefore + 1);

      // And the action it offers names A, not the B that was asked for. Sent
      // as A's signal under B's id the server refuses the pair outright.
      mockMarkExecuted.mockResolvedValue(withBoth("strategy-1"));
      await act(async () => {
        fireEvent.click(
          screen.getAllByRole("button", { name: /Mark as executed/ })[0],
        );
      });
      expect(mockMarkExecuted).toHaveBeenCalledWith(
        "signal-1",
        "3M",
        "strategy-1",
      );
    });

    it("switches to the scenario picked from the switcher", async () => {
      const withBoth = (id: string) => {
        const report = gemReport();
        report.strategy = { ...report.strategy, id, name: id };
        report.strategies = [
          { id: "strategy-1", name: "Aggressive" },
          { id: "strategy-2", name: "Conservative" },
        ];
        return report;
      };
      mockGetReport.mockResolvedValue(withBoth("strategy-1"));
      await renderReport();

      mockGetReport.mockResolvedValue(withBoth("strategy-2"));
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Switch scenario" }));
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("menuitem", { name: "Conservative" }));
      });
      await act(async () => {});

      expect(mockGetReport).toHaveBeenLastCalledWith("1Y", "strategy-2");
    });

    it("will not mark a signal while the newly selected range is still loading", async () => {
      await renderReport();
      const pending = deferred<unknown>();
      mockGetReport.mockReturnValue(pending.promise);

      await switchRange("3M");

      // A is still on screen, B is in flight: the action is not available.
      const button = screen.getAllByRole("button", {
        name: /Mark as executed/,
      })[0];
      await act(async () => {
        fireEvent.click(button);
      });
      expect(mockMarkExecuted).not.toHaveBeenCalled();

      await act(async () => {
        pending.settle(gemReport());
      });
      // ...and it comes back once the two agree again.
      await waitFor(() =>
        expect(
          screen.getAllByRole("button", { name: /Mark as executed/ })[0],
        ).not.toBeDisabled(),
      );
    });

    it("discards a mutation response produced for a range the user has left", async () => {
      await renderReport();

      // A slow mark-executed for 1Y, then the user moves to 3M mid-flight.
      const slowMutation = deferred<unknown>();
      mockMarkExecuted.mockReturnValue(slowMutation.promise);
      const button = screen.getAllByRole("button", {
        name: /Mark as executed/,
      })[0];
      await act(async () => {
        fireEvent.click(button);
      });
      expect(mockMarkExecuted).toHaveBeenCalledTimes(1);

      const threeMonth = gemReport();
      threeMonth.performance = { ...threeMonth.performance!, range: "3M" };
      mockGetReport.mockResolvedValue(threeMonth);
      await switchRange("3M");

      // The 1Y response now lands. It describes a range nobody is looking at.
      const oneYear = gemReport();
      oneYear.performance = { ...oneYear.performance!, range: "1Y" };
      await act(async () => {
        slowMutation.settle(oneYear);
      });

      expect(screen.getByRole("button", { name: "3M" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    });

    it("does not leave a failed load looking like the new selection", async () => {
      await renderReport();
      mockGetReport.mockRejectedValue(new Error("boom"));

      await switchRange("3M");

      // The old report must not stay on screen as though it were the new
      // range's; the shared error presentation takes over instead.
      await waitFor(() =>
        expect(
          screen.queryByRole("button", { name: /Mark as executed/ }),
        ).not.toBeInTheDocument(),
      );
    });

    /**
     * Invariant: a create or delete response is adopted as the new selection,
     * and does not trigger a fetch of what it already contains.
     * Canonical adversarial input: a mutation whose response *moves* the
     * request key (testing contract, asynchronous operations).
     * Minimal mutation: stamp the response with the outgoing key, or match it
     * against the outgoing key instead of declaring the new one.
     * Test that fails under either: this one -- the first drops the report,
     * the second refetches it.
     */
    it("adopts a new scenario without refetching what it already returned", async () => {
      await renderReport();
      const loadsBefore = mockGetReport.mock.calls.length;

      const created = gemReport();
      created.strategy = { ...created.strategy, id: "strategy-2" };
      mockCreateStrategy.mockResolvedValue(created);
      // Any later fetch would answer with the *old* scenario, so if one runs
      // the assertions below fail rather than passing by coincidence.
      mockGetReport.mockResolvedValue(gemReport());

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "New scenario" }));
      });
      await act(async () => {
        fireEvent.change(screen.getByLabelText("Scenario name"), {
          target: { value: "IKZE quarterly" },
        });
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Create" }));
      });

      // The response is on screen -- the settings tab it opens is rendered,
      // which only happens for data the page accepted...
      await waitFor(() =>
        expect(
          screen.getByLabelText("Evaluation frequency"),
        ).toBeInTheDocument(),
      );
      // ...and no read was issued for a report the mutation already returned.
      expect(mockGetReport.mock.calls.length).toBe(loadsBefore);
    });

    /**
     * Invariant: changing the request key while a keyed form is dirty asks
     * first.
     * Canonical adversarial input: stale response + dirty form (testing
     * contract, combinations).
     * Minimal mutation: call `setTab` / `setStrategyId` directly instead of
     * through `guarded`. Test that fails under it: the first of these.
     */
    it("asks before a tab change discards unsaved settings", async () => {
      await renderReport();
      await act(async () => {
        fireEvent.click(screen.getByRole("tab", { name: /Settings/i }));
      });
      await waitFor(() =>
        expect(
          screen.getByLabelText("Evaluation frequency"),
        ).toBeInTheDocument(),
      );

      // Dirty the form.
      await act(async () => {
        fireEvent.change(screen.getByLabelText("Evaluation frequency"), {
          target: { value: "QUARTERLY" },
        });
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("tab", { name: /Overview/i }));
      });

      // The navigation is held, not performed.
      expect(
        screen.getByRole("heading", { name: "Unsaved Changes" }),
      ).toBeInTheDocument();
      expect(screen.getByLabelText("Evaluation frequency")).toBeInTheDocument();
    });

    it("keeps the form and the edit when the user cancels", async () => {
      await renderReport();
      await act(async () => {
        fireEvent.click(screen.getByRole("tab", { name: /Settings/i }));
      });
      await waitFor(() =>
        expect(
          screen.getByLabelText("Evaluation frequency"),
        ).toBeInTheDocument(),
      );
      await act(async () => {
        fireEvent.change(screen.getByLabelText("Evaluation frequency"), {
          target: { value: "QUARTERLY" },
        });
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("tab", { name: /Overview/i }));
      });

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /Cancel/i }));
      });

      const field = screen.getByLabelText(
        "Evaluation frequency",
      ) as HTMLSelectElement;
      expect(field).toBeInTheDocument();
      expect(field.value).toBe("QUARTERLY");
    });

    it("performs the navigation once the edits are discarded", async () => {
      await renderReport();
      await act(async () => {
        fireEvent.click(screen.getByRole("tab", { name: /Settings/i }));
      });
      await waitFor(() =>
        expect(
          screen.getByLabelText("Evaluation frequency"),
        ).toBeInTheDocument(),
      );
      await act(async () => {
        fireEvent.change(screen.getByLabelText("Evaluation frequency"), {
          target: { value: "QUARTERLY" },
        });
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("tab", { name: /Overview/i }));
      });

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /Discard/i }));
      });

      expect(
        screen.queryByLabelText("Evaluation frequency"),
      ).not.toBeInTheDocument();
    });

    /**
     * Invariant: a successful save clears the dirty state.
     * Canonical adversarial input: stale response + dirty form -- here the
     * form after its own save.
     * Minimal mutation: drop the `reset(values)` in `GemSettingsForm.onSubmit`.
     * Test that fails under it: this one -- the dialog appears after saving.
     */
    it("stops asking once the edits have been saved", async () => {
      mockUpdateConfig.mockResolvedValue(gemReport());
      await renderReport();
      await act(async () => {
        fireEvent.click(screen.getByRole("tab", { name: /Settings/i }));
      });
      await waitFor(() =>
        expect(
          screen.getByLabelText("Evaluation frequency"),
        ).toBeInTheDocument(),
      );
      await act(async () => {
        fireEvent.change(screen.getByLabelText("Evaluation frequency"), {
          target: { value: "QUARTERLY" },
        });
      });

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /^Save/ }));
      });
      await act(async () => {});

      // The edits are written, so there is nothing left to discard. Without
      // the reset the form stayed dirty for good and the guard asked on every
      // navigation from then on, offering to discard changes already saved.
      await act(async () => {
        fireEvent.click(screen.getByRole("tab", { name: /Overview/i }));
      });
      expect(
        screen.queryByRole("heading", { name: "Unsaved Changes" }),
      ).not.toBeInTheDocument();
    });

    /**
     * Invariant: a mutation's response is adopted whenever the selection it
     * was produced for is still the one on screen -- and the default
     * scenario, which nobody selected, is one of those selections.
     *
     * Canonical adversarial input: a request key whose two halves are built
     * from different sources (testing contract, asynchronous).
     *
     * Minimal mutation: build the save's origin key from the report's own
     * contents (`${range}|${data.strategy.id}`) instead of from the hook's
     * `dataKey`. The page's key is `${range}|${strategyId ?? ""}` and
     * `strategyId` is unset until the switcher is used, so the two never
     * matched on the single-scenario path and every save was discarded.
     */
    it("shows the saved configuration on the scenario nobody selected", async () => {
      const saved = gemReport();
      saved.strategy = { ...saved.strategy, cadence: "QUARTERLY" };
      mockUpdateConfig.mockResolvedValue(saved);
      await renderReport();
      // The header describes the configuration the report was loaded with.
      expect(
        screen.getByText("Evaluation frequency: monthly"),
      ).toBeInTheDocument();

      await act(async () => {
        fireEvent.click(screen.getByRole("tab", { name: /Settings/i }));
      });
      await waitFor(() =>
        expect(
          screen.getByLabelText("Evaluation frequency"),
        ).toBeInTheDocument(),
      );
      await act(async () => {
        fireEvent.change(screen.getByLabelText("Evaluation frequency"), {
          target: { value: "QUARTERLY" },
        });
      });
      // Any refetch would answer with the pre-save report, so the assertion
      // below cannot pass by a second read happening to run.
      mockGetReport.mockResolvedValue(gemReport());

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /^Save/ }));
      });
      await act(async () => {});

      // The save returns the re-evaluated strategy and the page takes it.
      // Discarding it left the user looking at the configuration they had
      // just replaced, with nothing scheduled to correct it.
      await waitFor(() =>
        expect(
          screen.getByText("Evaluation frequency: quarterly"),
        ).toBeInTheDocument(),
      );
    });

    /**
     * The dialog's own Save, which shares its label with the form's. The
     * dialog is rendered last, so it is the later of the two.
     */
    const dialogSave = () =>
      screen.getAllByRole("button", { name: /^Save/ }).at(-1) as HTMLElement;

    /**
     * Invariant: "Save" answers the dialog and then does the thing the user
     * asked for.
     * Canonical adversarial input: stale response + dirty form.
     * Minimal mutation: drop the navigation instead of holding it in
     * `navigateAfterSave`.
     * Test that fails under it: the first of the two below -- the page stays
     * on Settings.
     */
    it("carries out the navigation once the edits are saved", async () => {
      mockUpdateConfig.mockResolvedValue(gemReport());
      await renderReport();
      await act(async () => {
        fireEvent.click(screen.getByRole("tab", { name: /Settings/i }));
      });
      await waitFor(() =>
        expect(
          screen.getByLabelText("Evaluation frequency"),
        ).toBeInTheDocument(),
      );
      await act(async () => {
        fireEvent.change(screen.getByLabelText("Evaluation frequency"), {
          target: { value: "QUARTERLY" },
        });
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("tab", { name: /Overview/i }));
      });

      await act(async () => {
        fireEvent.click(dialogSave());
      });
      await act(async () => {});

      // The dialog offers three answers and this was "save and carry on".
      // Saving and staying put is not one of them: the user still has to ask
      // for the tab a second time.
      expect(
        screen.queryByRole("heading", { name: "Unsaved Changes" }),
      ).not.toBeInTheDocument();
      await waitFor(() =>
        expect(
          screen.queryByLabelText("Evaluation frequency"),
        ).not.toBeInTheDocument(),
      );
    });

    it("stays on the form when the save it was waiting for is refused", async () => {
      mockUpdateConfig.mockRejectedValue(new Error("nope"));
      await renderReport();
      await act(async () => {
        fireEvent.click(screen.getByRole("tab", { name: /Settings/i }));
      });
      await waitFor(() =>
        expect(
          screen.getByLabelText("Evaluation frequency"),
        ).toBeInTheDocument(),
      );
      await act(async () => {
        fireEvent.change(screen.getByLabelText("Evaluation frequency"), {
          target: { value: "QUARTERLY" },
        });
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("tab", { name: /Overview/i }));
      });
      await act(async () => {
        fireEvent.click(dialogSave());
      });
      await act(async () => {});

      // Navigating on a refused save would discard exactly the edits the
      // dialog exists to protect.
      const field = screen.getByLabelText(
        "Evaluation frequency",
      ) as HTMLSelectElement;
      expect(field).toBeInTheDocument();
      expect(field.value).toBe("QUARTERLY");
    });

    it("asks before creating a scenario would discard unsaved settings", async () => {
      await renderReport();
      await act(async () => {
        fireEvent.click(screen.getByRole("tab", { name: /Settings/i }));
      });
      await waitFor(() =>
        expect(
          screen.getByLabelText("Evaluation frequency"),
        ).toBeInTheDocument(),
      );
      await act(async () => {
        fireEvent.change(screen.getByLabelText("Evaluation frequency"), {
          target: { value: "QUARTERLY" },
        });
      });

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "New scenario" }));
      });
      await act(async () => {
        fireEvent.change(screen.getByLabelText("Scenario name"), {
          target: { value: "IKZE quarterly" },
        });
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Create" }));
      });

      // Creating switches to the new scenario's settings, which unmounts this
      // form -- the same loss as a tab change, and it was not guarded.
      expect(
        screen.getByRole("heading", { name: "Unsaved Changes" }),
      ).toBeInTheDocument();
      expect(mockCreateStrategy).not.toHaveBeenCalled();
    });

    /**
     * Invariant: the page stays busy until every mutation in flight has
     * finished, including one another mutation started.
     * Canonical adversarial input: two overlapping asynchronous operations
     * sharing one piece of state (testing contract, concurrency).
     * Minimal mutation: make the busy state a boolean again -- `setIsSaving`
     * in place of the begin/end pair.
     * Test that fails under it: this one. The settings form's `finally` runs
     * straight after `onSaved` started the create, so the boolean went false
     * with the create still on the wire and the controls came back live.
     */
    it("stays busy until the scenario the save deferred has been created", async () => {
      const pendingCreate = deferred<unknown>();
      mockUpdateConfig.mockResolvedValue(gemReport());
      mockCreateStrategy.mockReturnValue(pendingCreate.promise);

      await renderReport();
      await act(async () => {
        fireEvent.click(screen.getByRole("tab", { name: /Settings/i }));
      });
      await waitFor(() =>
        expect(
          screen.getByLabelText("Evaluation frequency"),
        ).toBeInTheDocument(),
      );
      await act(async () => {
        fireEvent.change(screen.getByLabelText("Evaluation frequency"), {
          target: { value: "QUARTERLY" },
        });
      });

      // Ask to create a scenario, which the dirty form defers behind the
      // dialog, then answer "Save".
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "New scenario" }));
      });
      await act(async () => {
        fireEvent.change(screen.getByLabelText("Scenario name"), {
          target: { value: "IKZE quarterly" },
        });
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Create" }));
      });
      await act(async () => {
        fireEvent.click(dialogSave());
      });
      await act(async () => {});

      // The settings save has resolved and started the create, which has not.
      expect(mockCreateStrategy).toHaveBeenCalledTimes(1);
      expect(
        screen.getByRole("button", { name: "New scenario" }),
      ).toBeDisabled();

      await act(async () => {
        pendingCreate.settle(gemReport());
      });

      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "New scenario" }),
        ).not.toBeDisabled(),
      );
    });

    /**
     * Invariant: an action staged behind the unsaved-changes dialog only ever
     * runs for the save it was staged for.
     * Canonical adversarial input: a rejected command followed by a valid one
     * (testing contract, concurrency / ownership).
     * Minimal mutation: go back to `handleSubmit(onSubmit)` with no invalid
     * branch, so the form refuses silently and nothing disarms.
     * Test that fails under it: this one -- the scenario is deleted by a save
     * the user made minutes later for an unrelated reason.
     */
    it("drops a deferred delete when the form refuses to submit", async () => {
      // The delete control only appears with a second scenario to fall back
      // to, so the fixture has to carry one.
      const twoScenarios = gemReport();
      twoScenarios.strategies = [
        { id: "strategy-1", name: "GEM" },
        { id: "strategy-2", name: "IKZE" },
      ];
      mockGetReport.mockResolvedValue(twoScenarios);
      mockUpdateConfig.mockResolvedValue(twoScenarios);
      mockDeleteStrategy.mockResolvedValue(twoScenarios);
      await renderReport();
      await act(async () => {
        fireEvent.click(screen.getByRole("tab", { name: /Settings/i }));
      });
      await waitFor(() =>
        expect(
          screen.getByLabelText("Evaluation frequency"),
        ).toBeInTheDocument(),
      );

      // Dirty the form and then make it invalid: the momentum window is
      // required and bounded, so an empty one cannot be saved.
      await act(async () => {
        fireEvent.change(screen.getByLabelText("Evaluation frequency"), {
          target: { value: "QUARTERLY" },
        });
      });
      await act(async () => {
        fireEvent.change(screen.getByLabelText("Momentum window (months)"), {
          target: { value: "" },
        });
      });

      // Ask to delete the scenario; the dirty form defers it behind the
      // dialog, and the user answers "Save".
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: "Delete scenario" }),
        );
      });
      await act(async () => {
        const confirm = screen
          .getAllByRole("button", { name: /^Delete/ })
          .at(-1) as HTMLElement;
        fireEvent.click(confirm);
      });
      await act(async () => {
        fireEvent.click(dialogSave());
      });
      await act(async () => {});

      // The save never reached the server, so nothing was deleted...
      expect(mockUpdateConfig).not.toHaveBeenCalled();
      expect(mockDeleteStrategy).not.toHaveBeenCalled();
      // ...and the edits are still on screen to be corrected.
      expect(screen.getByLabelText("Evaluation frequency")).toBeInTheDocument();

      // Correct the field and save for real. The delete must not ride along.
      await act(async () => {
        fireEvent.change(screen.getByLabelText("Momentum window (months)"), {
          target: { value: "6" },
        });
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /^Save/ }));
      });
      await act(async () => {});

      expect(mockUpdateConfig).toHaveBeenCalledTimes(1);
      expect(mockDeleteStrategy).not.toHaveBeenCalled();
    });

    it("drops a deferred tab change when the form refuses to submit", async () => {
      // The same rule for the harmless half: a navigation the user was never
      // told happened is still a navigation they did not ask for now.
      mockUpdateConfig.mockResolvedValue(gemReport());
      await renderReport();
      await act(async () => {
        fireEvent.click(screen.getByRole("tab", { name: /Settings/i }));
      });
      await waitFor(() =>
        expect(
          screen.getByLabelText("Evaluation frequency"),
        ).toBeInTheDocument(),
      );
      await act(async () => {
        fireEvent.change(screen.getByLabelText("Evaluation frequency"), {
          target: { value: "QUARTERLY" },
        });
      });
      await act(async () => {
        fireEvent.change(screen.getByLabelText("Momentum window (months)"), {
          target: { value: "" },
        });
      });

      await act(async () => {
        fireEvent.click(screen.getByRole("tab", { name: /Overview/i }));
      });
      await act(async () => {
        fireEvent.click(dialogSave());
      });
      await act(async () => {});

      // Still on Settings, with the errors visible.
      expect(screen.getByLabelText("Evaluation frequency")).toBeInTheDocument();

      await act(async () => {
        fireEvent.change(screen.getByLabelText("Momentum window (months)"), {
          target: { value: "6" },
        });
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /^Save/ }));
      });
      await act(async () => {});

      // The save succeeded and the page stayed put: the tab change belonged to
      // a dialog the user answered a while ago and never got to complete.
      expect(mockUpdateConfig).toHaveBeenCalledTimes(1);
      expect(screen.getByLabelText("Evaluation frequency")).toBeInTheDocument();
    });

    it("creates the scenario with the name it was given once the edits are discarded", async () => {
      mockCreateStrategy.mockResolvedValue(gemReport());
      await renderReport();
      await act(async () => {
        fireEvent.click(screen.getByRole("tab", { name: /Settings/i }));
      });
      await waitFor(() =>
        expect(
          screen.getByLabelText("Evaluation frequency"),
        ).toBeInTheDocument(),
      );
      await act(async () => {
        fireEvent.change(screen.getByLabelText("Evaluation frequency"), {
          target: { value: "QUARTERLY" },
        });
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "New scenario" }));
      });
      await act(async () => {
        fireEvent.change(screen.getByLabelText("Scenario name"), {
          target: { value: "IKZE quarterly" },
        });
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Create" }));
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /Discard/i }));
      });
      await act(async () => {});

      // The typed name travels with the held action; asking again for it
      // would be the deferral losing the user's input.
      expect(mockCreateStrategy).toHaveBeenCalledWith(
        "IKZE quarterly",
        expect.anything(),
      );
    });

    it("lets a clean form change tab without asking", async () => {
      await renderReport();
      await act(async () => {
        fireEvent.click(screen.getByRole("tab", { name: /Settings/i }));
      });
      await waitFor(() =>
        expect(
          screen.getByLabelText("Evaluation frequency"),
        ).toBeInTheDocument(),
      );

      await act(async () => {
        fireEvent.click(screen.getByRole("tab", { name: /Overview/i }));
      });

      expect(
        screen.queryByRole("heading", { name: "Unsaved Changes" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByLabelText("Evaluation frequency"),
      ).not.toBeInTheDocument();
    });

    it("takes the settings form away while a newer report is loading", async () => {
      await renderReport();

      // Start a load, then open the settings tab while it is still in flight.
      const pending = deferred<unknown>();
      mockGetReport.mockReturnValue(pending.promise);
      await switchRange("3M");
      await act(async () => {
        fireEvent.click(screen.getByRole("tab", { name: /Settings/i }));
      });

      // Nothing to interact with while what is rendered is not what is
      // selected. Leaving the form mounted kept the previous scenario's
      // pickers, its one-click fill and its save all live, so a submit sent
      // the id of the scenario the user had just left.
      expect(
        screen.queryByLabelText("Evaluation frequency"),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: /^Save$/ }),
      ).not.toBeInTheDocument();

      await act(async () => {
        pending.settle(gemReport());
      });
      await waitFor(() =>
        expect(
          screen.getByLabelText("Evaluation frequency"),
        ).toBeInTheDocument(),
      );
    });

    /**
     * Invariant: stale data may stay on screen only while the pixels and
     * assistive technology both say it is stale.
     * Canonical adversarial input: A shown, B selected and loading (testing
     * contract, asynchronous).
     * Minimal mutation: drop `aria-busy` and the opacity from `panelProps`.
     * Test that fails under it: this one. Mutations were already disabled, so
     * nothing else in this file noticed that the signal, portfolio, transfer,
     * allocation and history carried no stale marking at all.
     */
    it("marks the report body stale while a newer selection is loading", async () => {
      await renderReport();

      const panel = () => screen.getByRole("tabpanel");
      expect(panel()).toHaveAttribute("aria-busy", "false");
      expect(
        screen.queryByTestId("gem-stale-indicator"),
      ).not.toBeInTheDocument();

      const pending = deferred<unknown>();
      mockGetReport.mockReturnValue(pending.promise);
      await switchRange("3M");

      // The previous selection's figures are still there -- keeping them is the
      // better read -- and they are marked as not being the current ones.
      expect(panel()).toHaveAttribute("aria-busy", "true");
      expect(panel().className).toContain("opacity-60");
      expect(screen.getByTestId("gem-stale-indicator")).toHaveAttribute(
        "role",
        "status",
      );

      await act(async () => {
        pending.settle(gemReport());
      });
      await waitFor(() =>
        expect(screen.getByRole("tabpanel")).toHaveAttribute(
          "aria-busy",
          "false",
        ),
      );
      expect(
        screen.queryByTestId("gem-stale-indicator"),
      ).not.toBeInTheDocument();
    });

    /**
     * Invariant: "Discard" discards.
     * Canonical adversarial input: a dirty keyed form whose guarded action is a
     * no-op -- the header's "Edit settings" while the Settings tab is already
     * open (testing contract, combinations).
     * Minimal mutation: drop the `settingsResetNonce` bump from `onDiscard`.
     * Test that fails under it: this one. Clearing `settingsDirty` alone left
     * the edits in a form that was never reset, so react-hook-form stayed dirty
     * with no transition left to report, the guard never re-armed, and the next
     * switch unmounted a dirty form with no prompt.
     */
    it("discards the edits when the guarded action changes nothing", async () => {
      await renderReport();
      await act(async () => {
        fireEvent.click(screen.getByRole("tab", { name: /Settings/i }));
      });
      await waitFor(() =>
        expect(
          screen.getByLabelText("Evaluation frequency"),
        ).toBeInTheDocument(),
      );
      await act(async () => {
        fireEvent.change(screen.getByLabelText("Evaluation frequency"), {
          target: { value: "QUARTERLY" },
        });
      });

      // The header's "Edit settings" while already on Settings: guarded, and
      // its action is a no-op, so nothing unmounts the form for us.
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /Edit settings/i }));
      });
      expect(
        screen.getByRole("heading", { name: "Unsaved Changes" }),
      ).toBeInTheDocument();
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /Discard/i }));
      });

      // The edit is gone, not merely unguarded.
      const field = () =>
        screen.getByLabelText("Evaluation frequency") as HTMLSelectElement;
      expect(field().value).toBe("MONTHLY");

      // And the guard is armed again rather than spent: dirtying the form once
      // more still asks before a tab change.
      await act(async () => {
        fireEvent.change(field(), { target: { value: "QUARTERLY" } });
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("tab", { name: /Overview/i }));
      });
      expect(
        screen.getByRole("heading", { name: "Unsaved Changes" }),
      ).toBeInTheDocument();
    });

    it("leaves the form clean, so the next tab change does not ask", async () => {
      // Coverage rather than a pin: the previous test is what fails when the
      // discard stops discarding. This states the other half of the outcome --
      // a discarded form is clean, so it changes tab without a prompt.
      await renderReport();
      await act(async () => {
        fireEvent.click(screen.getByRole("tab", { name: /Settings/i }));
      });
      await waitFor(() =>
        expect(
          screen.getByLabelText("Evaluation frequency"),
        ).toBeInTheDocument(),
      );
      await act(async () => {
        fireEvent.change(screen.getByLabelText("Evaluation frequency"), {
          target: { value: "QUARTERLY" },
        });
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /Edit settings/i }));
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /Discard/i }));
      });

      // A clean form changes tab without asking, which is the other half of the
      // same claim: the discard left it clean rather than merely unguarded.
      await act(async () => {
        fireEvent.click(screen.getByRole("tab", { name: /Overview/i }));
      });
      expect(
        screen.queryByRole("heading", { name: "Unsaved Changes" }),
      ).not.toBeInTheDocument();
    });
  });
});
