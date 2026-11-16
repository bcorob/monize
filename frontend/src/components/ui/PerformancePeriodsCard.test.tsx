import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/react";
import { render } from "@/test/render";
import { PerformancePeriodsCard } from "./PerformancePeriodsCard";

const base = {
  title: "Portfolio performance",
  subtitle: "How your investments did.",
  unavailableLabel: "n/a",
  emptyMessage: "Not enough history yet.",
};

describe("PerformancePeriodsCard", () => {
  it("renders each period with its figures", () => {
    render(
      <PerformancePeriodsCard
        {...base}
        entries={[
          {
            period: "1m",
            label: "1M",
            primary: "+2.12%",
            primaryValue: 2.12,
            secondary: "+624.00",
            secondaryValue: 624,
          },
        ]}
      />,
    );

    expect(screen.getByText("Portfolio performance")).toBeInTheDocument();
    expect(screen.getByText("1M")).toBeInTheDocument();
    expect(screen.getByText("+2.12%")).toBeInTheDocument();
    expect(screen.getByText("+624.00")).toBeInTheDocument();
  });

  /** The distinction the card exists to make: unknown is not zero. */
  it("says n/a for a period that could not be reported", () => {
    render(
      <PerformancePeriodsCard
        {...base}
        entries={[
          {
            period: "1m",
            label: "1M",
            primary: "+1.00%",
            primaryValue: 1,
            secondary: null,
            secondaryValue: null,
          },
          { period: "1y", label: "1Y", primary: null, primaryValue: null },
        ]}
      />,
    );

    // The withheld period and the withheld second line both read as unknown.
    expect(screen.getAllByText("n/a")).toHaveLength(2);
  });

  it("renders a known zero as a number", () => {
    render(
      <PerformancePeriodsCard
        {...base}
        entries={[
          {
            period: "1m",
            label: "1M",
            primary: "0.00%",
            primaryValue: 0,
            secondary: "+0.00",
            secondaryValue: 0,
          },
        ]}
      />,
    );

    expect(screen.getByText("0.00%")).toBeInTheDocument();
    expect(screen.queryByText("n/a")).not.toBeInTheDocument();
  });

  it("colours a negative figure as a loss and a positive one as a gain", () => {
    render(
      <PerformancePeriodsCard
        {...base}
        entries={[
          {
            period: "1m",
            label: "1M",
            primary: "-3.00%",
            primaryValue: -3,
            secondary: "-90.00",
            secondaryValue: -90,
          },
          {
            period: "3m",
            label: "3M",
            primary: "+3.00%",
            primaryValue: 3,
          },
        ]}
      />,
    );

    expect(screen.getByText("-3.00%").className).toContain("red");
    expect(screen.getByText("-90.00").className).toContain("red");
    expect(screen.getByText("+3.00%").className).toContain("green");
  });

  it("draws no second figure, and no column for one, where no entry has one", () => {
    const { container } = render(
      <PerformancePeriodsCard
        {...base}
        entries={[
          { period: "1m", label: "1M", primary: "+1.00%", primaryValue: 1 },
        ]}
      />,
    );

    expect(container.querySelectorAll("dd")).toHaveLength(1);
    // Two columns, not three: an empty gutter would leave the percentages
    // hanging off a column nothing sits in.
    expect(container.querySelector("dl")!.className).toContain(
      "grid-cols-[1fr_auto]",
    );
  });

  it("holds the column open for a row that has no second figure of its own", () => {
    // Absent is not unknown: the cell keeps the column aligned and says
    // nothing, where a withheld one says so.
    const { container } = render(
      <PerformancePeriodsCard
        {...base}
        entries={[
          {
            period: "1m",
            label: "1M",
            primary: "+1.00%",
            primaryValue: 1,
            secondary: "+10.00",
            secondaryValue: 10,
          },
          { period: "1y", label: "1Y", primary: "+2.00%", primaryValue: 2 },
        ]}
      />,
    );

    const cells = container.querySelectorAll("dd");
    expect(cells).toHaveLength(4);
    expect(cells[2].textContent).toBe("");
    expect(screen.queryByText("n/a")).not.toBeInTheDocument();
  });

  it("keeps the second figure on the headline's line, in its own column", () => {
    // The security card has one row per period; the portfolio card carries an
    // amount too, and it joins that row rather than opening a second one, so
    // the two cards read alike side by side.
    const { container } = render(
      <PerformancePeriodsCard
        {...base}
        entries={[
          {
            period: "1m",
            label: "1M",
            primary: "+1.41%",
            primaryValue: 1.41,
            secondary: "+1,016.00",
            secondaryValue: 1016,
          },
        ]}
      />,
    );

    // One grid row: the amount and the ratio are two cells of it, in that
    // order, and every period's cells share a column so the figures line up
    // down the card rather than each starting wherever its own text does.
    const cells = container.querySelectorAll("dd");
    expect(cells).toHaveLength(2);
    expect(cells[0].textContent).toBe("+1,016.00");
    expect(cells[1].textContent).toBe("+1.41%");
    const list = container.querySelector("dl")!;
    expect(list.className).toContain("grid-cols-[1fr_auto_auto]");
    expect(list.className).toContain("items-baseline");
    // Both are figures the reader compares, so they are set at one size; the
    // headline is distinguished by weight, not by making the money smaller.
    expect(cells[0].className).toContain("text-sm");
    expect(cells[1].className).toContain("text-sm");
    expect(cells[0].className).not.toContain("font-medium");
    expect(cells[1].className).toContain("font-medium");
  });

  it("says so when no period can be reported at all, and drops the footnote", () => {
    render(
      <PerformancePeriodsCard
        {...base}
        entries={[
          { period: "1m", label: "1M", primary: null, primaryValue: null },
        ]}
        footnote="Deposits are not result."
      />,
    );

    expect(screen.getByText("Not enough history yet.")).toBeInTheDocument();
    // Nothing is shown, so a caption about the figures would caption nothing.
    expect(
      screen.queryByText("Deposits are not result."),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("n/a")).not.toBeInTheDocument();
  });

  it("keeps the unknown rows on screen when a notice says why", () => {
    render(
      <PerformancePeriodsCard
        {...base}
        entries={[
          { period: "1m", label: "1M", primary: null, primaryValue: null },
        ]}
        notice="The request failed."
        footnote="Deposits are not result."
      />,
    );

    // A notice is a claim about the figures, so the figures stay listed as
    // unknown beneath it; the empty message would claim there is nothing.
    expect(screen.getByRole("status")).toHaveTextContent("The request failed.");
    expect(screen.getByText("n/a")).toBeInTheDocument();
    expect(
      screen.queryByText("Not enough history yet."),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Deposits are not result."),
    ).not.toBeInTheDocument();
  });

  it("carries the footnote under the figures", () => {
    render(
      <PerformancePeriodsCard
        {...base}
        entries={[
          { period: "1m", label: "1M", primary: "+1.00%", primaryValue: 1 },
        ]}
        footnote="Deposits are not result."
        footnoteTone="warning"
        footnoteTitle="The long version."
      />,
    );

    const footnote = screen.getByText("Deposits are not result.");
    expect(footnote).toBeInTheDocument();
    expect(footnote.className).toContain("amber");
    expect(footnote).toHaveAttribute("title", "The long version.");
  });
});
