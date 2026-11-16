import { Logger } from "@nestjs/common";
import type { ModuleRef } from "@nestjs/core";
import type { EntityManager } from "typeorm";

import {
  OAUTH_GRANT_REVOKER,
  revokeOAuthGrantsAfterCommit,
  revokeStandingCredentials,
} from "./credential-revocation";
import { PersonalAccessToken } from "./entities/personal-access-token.entity";
import { TrustedDevice } from "../users/entities/trusted-device.entity";
import { OAuthModule } from "../oauth/oauth.module";
import { OAuthProviderService } from "../oauth/oauth-provider.service";

describe("credential revocation", () => {
  describe("revokeStandingCredentials", () => {
    it("revokes every live PAT and deletes every trusted device on the given manager", async () => {
      const pats = { update: jest.fn() };
      const devices = { delete: jest.fn() };
      const manager = {
        getRepository: jest.fn((entity: unknown) =>
          entity === PersonalAccessToken ? pats : devices,
        ),
      } as unknown as EntityManager;

      await revokeStandingCredentials(manager, "user-1");

      expect(pats.update).toHaveBeenCalledWith(
        { userId: "user-1", isRevoked: false },
        { isRevoked: true },
      );
      expect(devices.delete).toHaveBeenCalledWith({ userId: "user-1" });
      expect(manager.getRepository).toHaveBeenCalledWith(TrustedDevice);
    });
  });

  it("is bound to the OAuth provider service by OAuthModule", () => {
    // Without the binding every lazy lookup fails, and every password reset
    // would report an error after committing.
    const providers: unknown[] = Reflect.getMetadata("providers", OAuthModule);
    expect(providers).toContainEqual({
      provide: OAUTH_GRANT_REVOKER,
      useExisting: OAuthProviderService,
    });
  });

  describe("revokeOAuthGrantsAfterCommit", () => {
    const logger = { error: jest.fn() } as unknown as Logger;

    const moduleRefWith = (oauth: unknown) =>
      ({
        get: jest.fn((token: unknown) => {
          if (token === OAUTH_GRANT_REVOKER) return oauth;
          throw new Error("not registered");
        }),
      }) as unknown as ModuleRef;

    beforeEach(() => jest.clearAllMocks());

    it("revokes through the provider service, resolved without a strict scope", async () => {
      const oauth = { revokeAllForUser: jest.fn().mockResolvedValue(3) };
      const moduleRef = moduleRefWith(oauth);

      await revokeOAuthGrantsAfterCommit(moduleRef, "user-1", logger);

      expect(moduleRef.get).toHaveBeenCalledWith(OAUTH_GRANT_REVOKER, {
        strict: false,
      });
      expect(oauth.revokeAllForUser).toHaveBeenCalledWith("user-1");
      expect(logger.error).not.toHaveBeenCalled();
    });

    it("logs the account and rethrows when the sweep fails", async () => {
      // The password has already changed, so a silent failure would report a
      // clean reset while an MCP client kept its access.
      const oauth = {
        revokeAllForUser: jest.fn().mockRejectedValue(new Error("db down")),
      };

      await expect(
        revokeOAuthGrantsAfterCommit(moduleRefWith(oauth), "user-1", logger),
      ).rejects.toThrow("db down");
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining("user-1"),
        expect.any(String),
      );
    });

    it("fails loudly when the provider service cannot be resolved", async () => {
      await expect(
        revokeOAuthGrantsAfterCommit(
          {
            get: jest.fn(() => {
              throw new Error("missing");
            }),
          } as never,
          "user-1",
          logger,
        ),
      ).rejects.toThrow("missing");
      expect(logger.error).toHaveBeenCalled();
    });
  });
});
