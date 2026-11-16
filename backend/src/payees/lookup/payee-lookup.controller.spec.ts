import { readFileSync } from "fs";
import { join } from "path";
import { ModuleRef } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { AuthGuard } from "@nestjs/passport";
import { DEMO_RESTRICTED_KEY } from "../../common/guards/demo-mode.guard";
import {
  PayeeLookupSettingsService,
  PayeeLookupStatus,
} from "./google-places/payee-lookup-settings.service";
import { PayeeLookupController } from "./payee-lookup.controller";

/**
 * Comments blanked, newlines preserved so a reported line still points at the
 * offending one. The same stripper the repo's other source scans use, for the
 * same reason: prose that names a banned pattern must not trip the scan.
 */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, " "))
    .replace(
      /(^|[^:])\/\/[^\n]*/g,
      (match, lead: string) => lead + " ".repeat(match.length - lead.length),
    );
}

describe("PayeeLookupController", () => {
  let controller: PayeeLookupController;
  let settings: jest.Mocked<
    Pick<
      PayeeLookupSettingsService,
      "getSettings" | "updateSettings" | "getStatus" | "testKey"
    >
  >;
  let aiService: { getStatus: jest.Mock };
  const req = { user: { id: "user-1" } };

  beforeEach(async () => {
    settings = {
      getSettings: jest.fn().mockResolvedValue({ mode: "none" }),
      updateSettings: jest.fn().mockResolvedValue({ mode: "user" }),
      getStatus: jest.fn().mockResolvedValue({
        available: true,
        source: "ai",
      } as PayeeLookupStatus),
      testKey: jest.fn().mockResolvedValue({ available: true }),
    } as unknown as typeof settings;
    aiService = {
      getStatus: jest.fn().mockResolvedValue({ configured: true }),
    };

    const module = await Test.createTestingModule({
      controllers: [PayeeLookupController],
      providers: [
        { provide: PayeeLookupSettingsService, useValue: settings },
        {
          provide: ModuleRef,
          useValue: { get: jest.fn().mockReturnValue(aiService) },
        },
      ],
    }).compile();

    controller = module.get(PayeeLookupController);
  });

  it("derives userId from the token, never from the request body", async () => {
    await controller.getSettings(req);

    expect(settings.getSettings).toHaveBeenCalledWith("user-1");
  });

  it("hands the AI's own configured flag to the status", async () => {
    // Whether AI can answer is AiService's question; this controller only
    // relays it so one status describes both sources.
    aiService.getStatus.mockResolvedValue({ configured: false });

    await controller.getStatus(req);

    expect(settings.getStatus).toHaveBeenCalledWith("user-1", false);
  });

  it("passes an update through untouched", async () => {
    await controller.updateSettings(req, { enabled: false, monthlyCap: 250 });

    expect(settings.updateSettings).toHaveBeenCalledWith("user-1", {
      enabled: false,
      monthlyCap: 250,
    });
  });

  it("passes a draft key to the test", async () => {
    await controller.testKey(req, { apiKey: "draft" });

    expect(settings.testKey).toHaveBeenCalledWith("user-1", "draft");
  });

  describe("access", () => {
    it("is JWT-guarded at the class level", () => {
      const guards = Reflect.getMetadata("__guards__", PayeeLookupController);
      expect(guards).toHaveLength(1);
      expect(new guards[0]()).toBeInstanceOf(AuthGuard("jwt"));
    });

    it("is owner-only: a delegate may run lookups but not hold the key", () => {
      // A stored API key and the spending limit on it belong to the account
      // holder, not to somebody acting on their behalf.
      //
      // Comments are blanked first: the controller's own doc comment has to be
      // able to NAME the decorator it deliberately does not use, and a scan
      // over raw text would fail on the explanation rather than on the code.
      const source = readFileSync(
        join(__dirname, "payee-lookup.controller.ts"),
        "utf8",
      );
      expect(withoutComments(source)).not.toContain("@AllowDelegate");
    });

    it.each([["updateSettings"], ["testKey"]])(
      "%s is restricted in demo mode",
      (method) => {
        expect(
          Reflect.getMetadata(
            DEMO_RESTRICTED_KEY,
            PayeeLookupController.prototype[method],
          ),
        ).toBe(true);
      },
    );

    it("throttles the test, because each call is a billed request to Google", () => {
      expect(
        Reflect.getMetadata(
          "THROTTLER:LIMITdefault",
          PayeeLookupController.prototype.testKey,
        ),
      ).toBe(5);
      expect(
        Reflect.getMetadata(
          "THROTTLER:TTLdefault",
          PayeeLookupController.prototype.testKey,
        ),
      ).toBe(60000);
    });
  });
});
