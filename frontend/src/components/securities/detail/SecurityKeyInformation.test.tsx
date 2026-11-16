import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import { render } from "@/test/render";
import { act } from "@testing-library/react";
import { SecurityKeyInformation } from "./SecurityKeyInformation";
import type { Security } from "@/types/investment";
import type { SecurityPricePoint } from "@/lib/security-detail";

/** The user's own default provider, which a security without one inherits. */
const preferences = {
  current: { defaultQuoteProvider: "msn" } as {
    defaultQuoteProvider: string;
  } | null,
};
vi.mock("@/store/preferencesStore", () => ({
  usePreferencesStore: (selector: (state: unknown) => unknown) =>
    selector({ preferences: preferences.current }),
}));

const mockListBondPrograms = vi.fn();
vi.mock("@/lib/investments", () => ({
  investmentsApi: {
    listBondPrograms: (...args: unknown[]) => mockListBondPrograms(...args),
  },
}));

function security(overrides: Partial<Security> = {}): Security {
  return {
    id: "sec-1",
    symbol: "IUSQ",
    name: "All World",
    securityType: "ETF",
    exchange: "XETRA",
    currencyCode: "EUR",
    description: null,
    tags: [],
    isActive: true,
    isFavourite: false,
    skipPriceUpdates: false,
    sector: null,
    industry: null,
    sectorWeightings: null,
    countryWeightings: null,
    assetWeightings: null,
    website: null,
    irWebsite: null,
    quoteProvider: "yahoo",
    msnInstrumentId: null,
    lastPriceSource: null,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** Two points that agree: an adjusted series exists and nothing was paid out. */
const accumulating: SecurityPricePoint[] = [
  { date: "2024-01-01", close: 100, totalReturnClose: 100 },
  { date: "2025-01-01", close: 120, totalReturnClose: 120 },
];

/** No adjusted series at all, as MSN supplies. */
const noAdjustedSeries: SecurityPricePoint[] = [
  { date: "2024-01-01", close: 100 },
  { date: "2025-01-01", close: 120 },
];

async function renderAsync(ui: React.ReactElement) {
  await act(async () => {
    render(ui);
  });
}

const program = (infoUrl?: string | null) => ({
  id: "b-1",
  issuerCountryCode: "PL",
  issuerCode: "MF",
  programCode: "EDO",
  currency: "PLN",
  seriesCount: 1,
  newestSeriesCode: "EDO1036",
  ...(infoUrl === undefined ? {} : { infoUrl }),
});

describe("SecurityKeyInformation", () => {
  beforeEach(() => {
    preferences.current = { defaultQuoteProvider: "msn" };
    mockListBondPrograms.mockReset();
    mockListBondPrograms.mockResolvedValue([]);
  });

  it("drops the rows a thinly-filled security has no value for", () => {
    // A column of dashes says nothing; `KeyValueList` omits an empty row, so this
    // has to stay true as rows are added.
    render(
      <SecurityKeyInformation
        security={security({ exchange: null, sector: null, industry: null })}
        latestPrice={null}
        prices={[]}
      />,
    );

    expect(screen.getByText("Symbol")).toBeInTheDocument();
    expect(screen.queryByText("Exchange")).not.toBeInTheDocument();
    expect(screen.queryByText("Sector")).not.toBeInTheDocument();
    expect(screen.queryByText("Industry")).not.toBeInTheDocument();
    expect(screen.queryByText("Last price")).not.toBeInTheDocument();
  });

  it("states the distribution behaviour it can read off the price history", () => {
    render(
      <SecurityKeyInformation
        security={security()}
        latestPrice={null}
        prices={accumulating}
      />,
    );

    expect(screen.getByText("Distributions")).toBeInTheDocument();
    // Worded as observed from data, not declared by the issuer.
    expect(screen.getByText("None (accumulating)")).toBeInTheDocument();
  });

  it("drops the distribution row rather than guessing without an adjusted series", () => {
    render(
      <SecurityKeyInformation
        security={security()}
        latestPrice={null}
        prices={noAdjustedSeries}
      />,
    );

    expect(screen.queryByText("Distributions")).not.toBeInTheDocument();
  });

  it("names the effective provider, never a blank row", () => {
    // A security with no provider of its own uses the user's default, so the
    // answer here is what will actually be asked for a quote.
    render(
      <SecurityKeyInformation
        security={security({ quoteProvider: null })}
        latestPrice={null}
        prices={[]}
      />,
    );

    expect(screen.getByText("Provider")).toBeInTheDocument();
    expect(screen.getByText("MSN")).toBeInTheDocument();
  });

  it("names the bond engine for a security linked to a bond program", async () => {
    await renderAsync(
      <SecurityKeyInformation
        security={security({ quoteProvider: "yahoo", bondProgramId: "b-1" })}
        latestPrice={null}
        prices={[]}
      />,
    );

    expect(screen.getByText("Bond engine")).toBeInTheDocument();
    expect(screen.queryByText("Yahoo")).not.toBeInTheDocument();
  });

  it("falls back to Yahoo when the user has no default either", () => {
    preferences.current = null;
    render(
      <SecurityKeyInformation
        security={security({ quoteProvider: null })}
        latestPrice={null}
        prices={[]}
      />,
    );

    expect(screen.getByText("Yahoo")).toBeInTheDocument();
  });

  it("dates the last price, because a stale quote reads as a current one", () => {
    render(
      <SecurityKeyInformation
        security={security()}
        latestPrice={{ price: 123.45, priceDate: "2026-07-28" }}
        prices={[]}
      />,
    );

    expect(screen.getByText("Last price")).toBeInTheDocument();
    expect(screen.getByText(/123\.45/)).toBeInTheDocument();
    expect(screen.getByText(/2026/)).toBeInTheDocument();
  });

  describe("the bond description link", () => {
    const linked = security({ bondProgramId: "b-1" });

    it("links the issuer's page in a new tab and names its host", async () => {
      mockListBondPrograms.mockResolvedValue([
        program("https://www.obligacjeskarbowe.pl/oferta/obligacje-10-letnie-edo/"),
      ]);
      await renderAsync(
        <SecurityKeyInformation security={linked} latestPrice={null} prices={[]} />,
      );

      expect(screen.getByText("Bond description")).toBeInTheDocument();
      const link = screen.getByRole("link", { name: "obligacjeskarbowe.pl" });
      expect(link).toHaveAttribute(
        "href",
        "https://www.obligacjeskarbowe.pl/oferta/obligacje-10-letnie-edo/",
      );
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", "noopener noreferrer");
    });

    it.each([
      ["null", null],
      ["absent", undefined],
      ["not https", "http://www.obligacjeskarbowe.pl/"],
      ["not a web address", "javascript:alert(1)"],
    ])("is hidden when the address is %s", async (_name, infoUrl) => {
      mockListBondPrograms.mockResolvedValue([program(infoUrl)]);
      await renderAsync(
        <SecurityKeyInformation security={linked} latestPrice={null} prices={[]} />,
      );

      expect(screen.queryByText("Bond description")).not.toBeInTheDocument();
      expect(screen.queryByRole("link")).not.toBeInTheDocument();
    });

    it("is hidden when the catalog cannot be read", async () => {
      mockListBondPrograms.mockRejectedValue(new Error("boom"));
      await renderAsync(
        <SecurityKeyInformation security={linked} latestPrice={null} prices={[]} />,
      );

      expect(screen.queryByText("Bond description")).not.toBeInTheDocument();
    });

    it("never asks for the catalog, nor shows the row, for a security that is not a bond", async () => {
      await renderAsync(
        <SecurityKeyInformation security={security()} latestPrice={null} prices={[]} />,
      );

      expect(mockListBondPrograms).not.toHaveBeenCalled();
      expect(screen.queryByText("Bond description")).not.toBeInTheDocument();
    });
  });
});
