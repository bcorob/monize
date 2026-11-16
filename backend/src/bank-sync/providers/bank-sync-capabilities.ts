import type { BankSyncProviderName } from "../bank-sync.constants";

export interface BankSyncProviderCapabilities {
  setupFlow: "bank_redirect" | "setup_token";
  hasConsentExpiry: boolean;
  supportsRemoteSessionRevocation: boolean;
}
export const BANK_SYNC_PROVIDER_CAPABILITIES: Readonly<
  Record<BankSyncProviderName, BankSyncProviderCapabilities>
> = {
  enable_banking: {
    setupFlow: "bank_redirect",
    hasConsentExpiry: true,
    supportsRemoteSessionRevocation: true,
  },
  simplefin: {
    setupFlow: "setup_token",
    hasConsentExpiry: false,
    supportsRemoteSessionRevocation: false,
  },
};
