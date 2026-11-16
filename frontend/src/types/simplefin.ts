export interface SimplefinStatus {
  provider: "simplefin";
  credentialSet: boolean;
  encryptionAvailable: boolean;
  capabilities: {
    setupFlow: "setup_token";
    hasConsentExpiry: false;
    supportsRemoteSessionRevocation: false;
  };
  quota: { remaining: number; nextEligibleAt: string | null } | null;
}
export type SimplefinReadError =
  | "unauthorized"
  | "payment_required"
  | "rate_limited"
  | "unavailable"
  | "invalid_response"
  | "partial_data"
  | "identity_review"
  | "no_accounts";
export interface SimplefinDiscovery {
  ok: boolean;
  reviewRequired: boolean;
  errors: SimplefinReadError[];
  connections: Array<{
    id: string;
    name: string;
    accounts: Array<{
      id: string;
      name: string | null;
      currencyCode: string | null;
      balance: string | null;
      balanceAt: string | null;
    }>;
  }>;
}
