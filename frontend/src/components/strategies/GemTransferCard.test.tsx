import { describe, it, expect } from "vitest";
import { render, screen } from "@/test/render";
import { GemTransferCard } from "./GemTransferCard";
import { gemAction, gemReport } from "@/test/gem-fixtures";
import strategiesMessages from "@/i18n/messages/en/strategies.json";

describe("GemTransferCard", () => {
  it("says why a partly matching holding is still sold whole", () => {
    // Compliance above zero and a transfer of the entire position look
    // contradictory until the card explains that units cannot be split by
    // market -- the sale takes the on-target sleeve out with everything else.
    render(<GemTransferCard action={gemAction({ partialMatchCount: 1 })} />);
    expect(
      screen.getByText(/One holding is partly in the target's markets already/),
    ).toBeInTheDocument();
  });

  it("says nothing about partial matches when there are none", () => {
    render(<GemTransferCard action={gemAction()} />);
    expect(
      screen.queryByText(/partly in the target's markets/),
    ).not.toBeInTheDocument();
  });

  it("leads with the value to move and lists the estimated costs", () => {
    render(<GemTransferCard action={gemAction()} />);

    expect(screen.getByText("Estimated value to transfer")).toBeInTheDocument();
    expect(screen.getByText("$23,076.26")).toBeInTheDocument();
    expect(screen.getByText("+$4,794.90")).toBeInTheDocument();
    expect(screen.getByText("Estimated tax (19%)")).toBeInTheDocument();
    // The switch sells one holding and buys the target: two commissions.
    expect(
      screen.getByText("Estimated commission (2 trades)"),
    ).toBeInTheDocument();
    expect(screen.getByText("Broker IRA")).toBeInTheDocument();
  });

  it("charges the configured commission once per trade, and says so", () => {
    // The contract runs from the settings field to this row: the amount the
    // user types is per *trade*, and a switch is one sell per off-target
    // holding plus the buy. Labelling the field "per switch" while the server
    // multiplies by the trade count understated exactly the switches that cost
    // the most -- selling out of three funds is four commissions, not one.
    const report = gemReport();
    const perTrade = report.strategy.commissionAmount!;
    const action = report.action!;

    expect(strategiesMessages.gem.settingsForm.commissionAmount).toBe(
      "Commission per Trade (optional)",
    );

    render(<GemTransferCard action={action} />);

    expect(action.estimatedCommission).toBe(
      perTrade * action.estimatedTradeCount,
    );
    expect(
      screen.getByText(
        `Estimated commission (${action.estimatedTradeCount} trades)`,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("$59.80")).toBeInTheDocument();
  });

  it("signs a realized loss", () => {
    render(
      <GemTransferCard action={gemAction({ realizedGainLoss: -120.5 })} />,
    );
    expect(screen.getByText("-$120.50")).toBeInTheDocument();
  });

  it("drops cost rows the server could not estimate", () => {
    render(
      <GemTransferCard
        action={gemAction({
          estimatedTax: null,
          estimatedCommission: null,
          taxRatePercent: null,
        })}
      />,
    );
    expect(screen.queryByText(/Estimated tax/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Estimated commission/)).not.toBeInTheDocument();
  });

  /**
   * Invariant: an estimate the server could not make is a dash, not an absent
   * row.
   * Canonical adversarial input: aggregation with one unknown component -- a
   * configured rate against a missing cost basis.
   * Minimal mutation: gate the row on `estimatedTax` instead of on
   * `taxRatePercent`. Test that fails under it: the first of these.
   */
  it("shows the tax row as unknown when the basis is missing", () => {
    // A 19% rate is configured and one sold holding has no cost basis, so the
    // realized result and the tax are both null. The row used to disappear,
    // and a 100,000 switch then read as costing only its commission.
    render(
      <GemTransferCard
        action={gemAction({
          taxRatePercent: 19,
          realizedGainLoss: null,
          estimatedTax: null,
        })}
      />,
    );

    expect(screen.getByText("Estimated tax (19%)")).toBeInTheDocument();
    expect(
      screen.getByText("Cannot be estimated: the cost of one of these positions is not known"),
    ).toBeInTheDocument();
  });

  it("omits the tax row when no rate is configured", () => {
    // Nothing to estimate rather than an estimate that failed, and the two
    // must not look the same.
    render(
      <GemTransferCard
        action={gemAction({ taxRatePercent: null, estimatedTax: null })}
      />,
    );
    expect(screen.queryByText(/Estimated tax/)).not.toBeInTheDocument();
  });

  it("marks an unknown transfer value instead of zero", () => {
    render(<GemTransferCard action={gemAction({ transferValue: null })} />);
    expect(
      screen.getByText("Transfer value not available"),
    ).toBeInTheDocument();
  });

  it("shows nothing to transfer when the portfolio already matches", () => {
    render(<GemTransferCard action={gemAction({ required: false })} />);
    expect(screen.getByText("Nothing to transfer")).toBeInTheDocument();
  });

  it("shows nothing to transfer when there is no pending action at all", () => {
    render(<GemTransferCard action={null} />);
    expect(screen.getByText("Nothing to transfer")).toBeInTheDocument();
    expect(
      screen.getByText(/already hold the target instrument/),
    ).toBeInTheDocument();
  });

  it("explains the empty state differently before the first signal", () => {
    render(<GemTransferCard action={null} signalUnavailable />);
    expect(
      screen.getByText(
        "Nothing moves until the strategy produces its first signal.",
      ),
    ).toBeInTheDocument();
  });
});
