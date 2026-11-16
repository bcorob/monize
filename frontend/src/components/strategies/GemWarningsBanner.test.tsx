import { describe, it, expect } from "vitest";
import { render, screen } from "@/test/render";
import { GemWarningsBanner } from "./GemWarningsBanner";

describe("GemWarningsBanner", () => {
  it("says how many periods an earlier configuration is holding back", () => {
    // The history and the backtest carry one configuration's decisions only.
    // Without this the table just comes up short, with nothing saying why.
    render(
      <GemWarningsBanner
        warnings={[{ code: "LEGACY_PERIODS", count: 3 }]}
        lookbackMonths={12}
        assets={[]}
      />,
    );
    expect(
      screen.getByText(
        /3 earlier periods were decided under a different configuration/,
      ),
    ).toBeInTheDocument();
  });

  it("renders nothing without warnings", () => {
    const { container } = render(
      <GemWarningsBanner warnings={[]} lookbackMonths={12} assets={[]} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("raises a calculation failure as an alert", () => {
    render(
      <GemWarningsBanner
        warnings={[{ code: "CALCULATION_FAILED" }]}
        lookbackMonths={12}
        assets={[]}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The signal could not be calculated from the available data.",
    );
  });

  it("names the roles a warning is about, in strategy order", () => {
    render(
      <GemWarningsBanner
        warnings={[
          { code: "UNMAPPED_ROLE", roles: ["SAFE", "EM_EQUITY"] },
          { code: "STALE_PRICES", roles: ["EX_US_EQUITY"] },
        ]}
        lookbackMonths={12}
        assets={[]}
      />,
    );
    expect(
      screen.getByText(/Emerging markets, Safe asset/),
    ).toBeInTheDocument();
    // The stale-price warning names the instrument to go and refresh.
    expect(screen.getByText(/Developed markets ex-US/)).toBeInTheDocument();
  });

  it("names the short-history instrument, its symbol, and how to fix it", () => {
    render(
      <GemWarningsBanner
        warnings={[
          {
            code: "SHORT_HISTORY",
            roles: ["EM_EQUITY"],
            requiredFrom: "2024-07-31",
          },
        ]}
        lookbackMonths={12}
        assets={[
          { role: "EM_EQUITY", securityId: "s1", symbol: "IS3N", name: "EM IMI" },
        ]}
      />,
    );
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(/Not enough price history/);
    // The role is named with its symbol so the user knows which instrument.
    expect(alert).toHaveTextContent("IS3N");
    // And the fix points at the security page's control.
    expect(alert).toHaveTextContent(/Add another year of price history/);
  });

  it("leaves the in-place empty states to explain account and position gaps", () => {
    const { container } = render(
      <GemWarningsBanner
        warnings={[{ code: "NO_ACCOUNT" }, { code: "NO_POSITION" }]}
        lookbackMonths={12}
        assets={[]}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("treats a first run as information rather than a problem", () => {
    render(
      <GemWarningsBanner
        warnings={[{ code: "FIRST_RUN" }]}
        lookbackMonths={12}
        assets={[]}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      /has not been evaluated yet/,
    );
  });
});
