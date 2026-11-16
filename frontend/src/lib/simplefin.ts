import apiClient from "./api";
import { dedupe, invalidateCache } from "./apiCache";
import type { SimplefinStatus, SimplefinDiscovery } from "@/types/simplefin";

/** Tokens are request bodies only. A failed claim may still have committed credentials. */
export const simplefinApi = {
  getStatus: (): Promise<SimplefinStatus> =>
    dedupe(
      "bank-sync:simplefin:status",
      async () =>
        (
          await apiClient.get<SimplefinStatus>("/bank-sync/status", {
            params: { provider: "simplefin" },
          })
        ).data,
      30_000,
    ),
  connect: async (
    setupToken: string,
    replaceExisting: boolean,
  ): Promise<{ credentialSet: true; discovery: SimplefinDiscovery }> => {
    try {
      return (
        await apiClient.post<{
          credentialSet: true;
          discovery: SimplefinDiscovery;
        }>(
          "/bank-sync/simplefin/connect",
          { setupToken, replaceExisting },
          { timeout: 120_000 },
        )
      ).data;
    } finally {
      invalidateCache("bank-sync:");
    }
  },
  discover: async (): Promise<SimplefinDiscovery> => {
    try {
      return (
        await apiClient.post<SimplefinDiscovery>(
          "/bank-sync/simplefin/discover",
          undefined,
          { timeout: 60_000 },
        )
      ).data;
    } finally {
      invalidateCache("bank-sync:");
    }
  },
  remove: async (): Promise<void> => {
    try {
      await apiClient.delete("/bank-sync/simplefin/credentials");
    } finally {
      invalidateCache("bank-sync:");
    }
  },
};
