import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@/test/render";
import { GemSettingsForm } from "./GemSettingsForm";
import { TOUR_ANCHORS, tourAnchorSelector } from "@/lib/tours/anchors";
import { gemAssets, gemReport } from "@/test/gem-fixtures";

/**
 * The GEM release tour (`release-1.14.0/gem-strategy`) points its five settings
 * steps at containers in this form. They have to be present whether or not the
 * user has any instruments -- the no-securities case is the tour's primary
 * audience -- and taking the tour must never write anything.
 */

const mockGetAccounts = vi.fn();
vi.mock("@/lib/accounts", () => ({
  accountsApi: { getAll: (...args: unknown[]) => mockGetAccounts(...args) },
}));

const mockGetSecurities = vi.fn();
const mockCreateSecurity = vi.fn();
vi.mock("@/lib/investments", () => ({
  investmentsApi: {
    getSecurities: (...args: unknown[]) => mockGetSecurities(...args),
    createSecurity: (...args: unknown[]) => mockCreateSecurity(...args),
  },
}));

vi.mock("@/components/securities/SecurityForm", () => ({
  SecurityForm: () => <div>stub-security-form</div>,
}));

const mockUpdateConfig = vi.fn();
vi.mock("@/lib/gem-strategy", () => ({
  gemStrategyApi: {
    updateConfig: (...args: unknown[]) => mockUpdateConfig(...args),
  },
}));

vi.mock("react-hot-toast", () => ({
  default: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/logger", () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

const accounts = [
  {
    id: "acct-1",
    name: "Broker IRA",
    accountType: "INVESTMENT",
    accountSubType: "INVESTMENT_BROKERAGE",
    currencyCode: "USD",
  },
];

const securities = [
  {
    id: "sec-spy",
    symbol: "SPY",
    name: "SPDR S&P 500 ETF",
    exchange: "NYSEARCA",
    currencyCode: "USD",
    isActive: true,
  },
];

/** Every anchor the tour's settings steps rely on, in step order. */
const SETTINGS_ANCHORS = [
  TOUR_ANCHORS.gemSettingsAccounts,
  TOUR_ANCHORS.gemSettingsTimingAndCosts,
  TOUR_ANCHORS.gemSettingsAssets,
  TOUR_ANCHORS.gemSettingsRoles,
  TOUR_ANCHORS.gemSettingsSave,
] as const;

async function renderForm(
  props: Partial<Parameters<typeof GemSettingsForm>[0]> = {},
) {
  await act(async () => {
    render(
      <GemSettingsForm
        strategy={gemReport().strategy}
        assets={gemAssets}
        range="1Y"
        onSaved={vi.fn()}
        {...props}
      />,
    );
  });
}

function anchor(id: (typeof SETTINGS_ANCHORS)[number]) {
  return document.querySelector(tourAnchorSelector(id));
}

describe("GemSettingsForm guided-tour anchors", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAccounts.mockResolvedValue(accounts);
    mockGetSecurities.mockResolvedValue(securities);
  });

  it("exposes every settings anchor the tour steps point at", async () => {
    await renderForm();
    for (const id of SETTINGS_ANCHORS) {
      expect(anchor(id), id).toBeInTheDocument();
    }
  });

  it("groups cadence, momentum window and both cost inputs under one anchor", async () => {
    await renderForm();
    const group = anchor(TOUR_ANCHORS.gemSettingsTimingAndCosts);
    // The step explains all four together, so all four have to be inside the
    // spotlight -- an anchor on only the cadence select would ring one field
    // while the copy described the rest.
    expect(group).toContainElement(
      screen.getByLabelText("Evaluation frequency"),
    );
    expect(group).toContainElement(
      screen.getByLabelText("Momentum window (months)"),
    );
    expect(group).toContainElement(screen.getByLabelText("Tax Rate (optional)"));
    expect(group).toContainElement(
      screen.getByLabelText("Commission per Trade (optional)"),
    );
  });

  it("keeps the assets anchor on the card while the fill-missing shortcut shows", async () => {
    // No role assigned: the shortcut box is on screen, and the tour's
    // `addInstruments` step is talking about it.
    await renderForm({
      assets: gemAssets.map((asset) => ({
        ...asset,
        securityId: null,
        symbol: null,
      })),
    });

    expect(screen.getByLabelText("Listings to add")).toBeInTheDocument();
    const card = anchor(TOUR_ANCHORS.gemSettingsAssets);
    expect(card).toBeInTheDocument();
    // The anchor is the card, so the shortcut sits *inside* the spotlight
    // rather than being the spotlight.
    expect(card).toContainElement(screen.getByLabelText("Listings to add"));
  });

  it("keeps the assets anchor when every role is filled and the shortcut is gone", async () => {
    // The regression this guards: anchoring `addInstruments` to the shortcut box
    // instead of the card. A fully configured strategy hides that box, and the
    // tour step would then have no anchor and appear broken.
    await renderForm({ assets: gemAssets });

    expect(screen.queryByLabelText("Listings to add")).not.toBeInTheDocument();
    expect(anchor(TOUR_ANCHORS.gemSettingsAssets)).toBeInTheDocument();
    expect(anchor(TOUR_ANCHORS.gemSettingsRoles)).toBeInTheDocument();
  });

  it("writes nothing while the tour walks the form", async () => {
    // The tour advances every settings step with Next; no step submits the form,
    // creates an instrument, or fills the missing roles.
    await renderForm({
      assets: gemAssets.map((asset) => ({
        ...asset,
        securityId: null,
        symbol: null,
      })),
    });

    for (const id of SETTINGS_ANCHORS) {
      expect(anchor(id), id).toBeInTheDocument();
    }
    expect(mockUpdateConfig).not.toHaveBeenCalled();
    expect(mockCreateSecurity).not.toHaveBeenCalled();
  });
});
