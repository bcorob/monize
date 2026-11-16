import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@/test/render";
import { SimplefinSettingsCard } from "./SimplefinSettingsCard";
import type { SimplefinStatus, SimplefinDiscovery } from "@/types/simplefin";

const api = vi.hoisted(() => ({
  getStatus: vi.fn(),
  connect: vi.fn(),
  discover: vi.fn(),
  remove: vi.fn(),
}));
vi.mock("@/lib/simplefin", () => ({ simplefinApi: api }));

const status = (credentialSet = false, remaining = 20): SimplefinStatus => ({
  provider: "simplefin",
  credentialSet,
  encryptionAvailable: true,
  capabilities: {
    setupFlow: "setup_token",
    hasConsentExpiry: false,
    supportsRemoteSessionRevocation: false,
  },
  quota: credentialSet ? { remaining, nextEligibleAt: null } : null,
});
const discovered: SimplefinDiscovery = {
  ok: true,
  reviewRequired: false,
  errors: [],
  connections: [],
};
const token = "private-one-time-setup-token";

async function mount(disabled = false) {
  const onChanged = vi.fn().mockResolvedValue(undefined);
  let result: ReturnType<typeof render>;
  await act(async () => {
    result = render(
      <SimplefinSettingsCard disabled={disabled} onChanged={onChanged} />,
    );
  });
  return { ...result!, onChanged };
}
async function paste(value = token) {
  await act(async () => {
    fireEvent.change(screen.getByLabelText("Setup token"), {
      target: { value },
    });
  });
}
async function click(name: string) {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  Object.values(api).forEach((mock) => mock.mockReset());
  api.getStatus.mockResolvedValue(status());
  api.connect.mockResolvedValue({ credentialSet: true, discovery: discovered });
  api.discover.mockResolvedValue(discovered);
  api.remove.mockResolvedValue(undefined);
});

describe("SimpleFIN settings", () => {
  it("masks the token and explains read-only access without RSA or callback fields", async () => {
    await mount();
    expect(screen.getByLabelText("Setup token")).toHaveAttribute(
      "type",
      "password",
    );
    expect(screen.getByText(/Access is read-only/)).toBeInTheDocument();
    expect(screen.queryByText(/RSA/)).not.toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "SimpleFIN Bridge" }),
    ).toHaveAttribute("rel", "noopener noreferrer");
  });
  it("clears the token at submission and sends it once in the request body", async () => {
    await mount();
    await paste();
    await click("Connect SimpleFIN");
    expect(api.connect).toHaveBeenCalledExactlyOnceWith(token, false);
    expect(screen.getByLabelText("Setup token")).toHaveValue("");
    expect(JSON.stringify(localStorage)).not.toContain(token);
    expect(JSON.stringify(sessionStorage)).not.toContain(token);
  });
  it("does not replay an uncertain claim, and reloads connection status", async () => {
    api.connect.mockRejectedValue(new Error("Network Error"));
    await mount();
    await paste();
    await click("Connect SimpleFIN");
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(api.connect).toHaveBeenCalledTimes(1);
    expect(api.getStatus).toHaveBeenCalledTimes(2);
    expect(screen.getByLabelText("Setup token")).toHaveValue("");
  });
  it("distinguishes committed credentials from failed discovery and retries without a token", async () => {
    api.getStatus
      .mockResolvedValueOnce(status())
      .mockResolvedValue(status(true));
    api.connect.mockResolvedValue({
      credentialSet: true,
      discovery: { ...discovered, ok: false, errors: ["rate_limited"] },
    });
    await mount();
    await paste();
    await click("Connect SimpleFIN");
    expect(
      screen.getByText(/Connected, but account discovery needs attention/),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Request limit reached. Wait before refreshing."),
    ).toBeInTheDocument();
    await click("Refresh accounts");
    expect(api.discover).toHaveBeenCalledTimes(1);
    expect(api.connect).toHaveBeenCalledTimes(1);
  });
  it("requires explicit confirmation before replacing credentials for all institutions", async () => {
    api.getStatus.mockResolvedValue(status(true));
    await mount();
    await paste();
    await click("Connect SimpleFIN");
    expect(api.connect).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog");
    expect(
      within(dialog).getByText(/This replaces access for all institutions/),
    ).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(
        within(dialog).getByRole("button", { name: "Connect SimpleFIN" }),
      );
    });
    expect(api.connect).toHaveBeenCalledExactlyOnceWith(token, true);
  });
  it("discards a cancelled replacement token", async () => {
    api.getStatus.mockResolvedValue(status(true));
    await mount();
    await paste();
    await click("Connect SimpleFIN");
    await act(async () => {
      fireEvent.click(
        within(screen.getByRole("dialog")).getByRole("button", {
          name: "Cancel",
        }),
      );
    });
    expect(api.connect).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Setup token")).toHaveValue("");
  });
  it("confirms local removal and explains separate remote revocation", async () => {
    api.getStatus.mockResolvedValue(status(true));
    await mount();
    await click("Remove SimpleFIN from Monize");
    const dialog = screen.getByRole("dialog");
    expect(
      within(dialog).getByText(/Revoke the app token in Bridge/),
    ).toBeInTheDocument();
    expect(api.remove).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(
        within(dialog).getByRole("button", {
          name: "Remove SimpleFIN from Monize",
        }),
      );
    });
    expect(api.remove).toHaveBeenCalledTimes(1);
  });
  it("does not invent a zero request quota before connection", async () => {
    await mount();
    expect(screen.queryByText(/requests remaining/)).not.toBeInTheDocument();
  });
  it("disables quota-consuming discovery at zero remaining requests", async () => {
    api.getStatus.mockResolvedValue(status(true, 0));
    await mount();
    expect(
      screen.getByRole("button", { name: "Refresh accounts" }),
    ).toBeDisabled();
    expect(screen.getByText("0 requests remaining")).toBeInTheDocument();
  });
  it("preserves load failures as errors with a retry instead of showing disconnected", async () => {
    api.getStatus.mockRejectedValue(new Error("offline"));
    await mount();
    expect(
      screen.getByText("Could not load SimpleFIN status."),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("SimpleFIN is connected."),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Connect SimpleFIN" }),
    ).toBeDisabled();
  });
  it("refuses demo mutations", async () => {
    await mount(true);
    expect(screen.getByLabelText("Setup token")).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Connect SimpleFIN" }),
    ).toBeDisabled();
  });
  it("treats confirmed empty status as onboarding and retains disabled last-known state after a poll failure", async () => {
    let poll!: () => void;
    const timer = vi
      .spyOn(window, "setInterval")
      .mockImplementation((handler) => {
        poll = handler as () => void;
        return 123 as unknown as ReturnType<typeof window.setInterval>;
      });
    try {
      await mount();
      expect(
        screen.queryByText("Could not load SimpleFIN status."),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Try again" }),
      ).not.toBeInTheDocument();
      api.getStatus.mockResolvedValueOnce(status(true));
      await act(async () => poll());
      expect(screen.getByText("SimpleFIN is connected.")).toBeInTheDocument();
      api.getStatus.mockRejectedValueOnce(new Error("offline"));
      await act(async () => poll());
      expect(
        screen.getByText(
          "SimpleFIN was connected at the last successful check.",
        ),
      ).toBeInTheDocument();
      expect(
        screen.getByText("Could not load SimpleFIN status."),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Remove SimpleFIN from Monize" }),
      ).toBeDisabled();
    } finally {
      timer.mockRestore();
    }
  });
});
