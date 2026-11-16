import { Logger } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { ActionHistoryService } from "../../action-history/action-history.service";
import { FaviconService } from "../../common/favicon/favicon.service";
import { withUserContext } from "../../common/db/with-context";
import { createScopedDbMocks } from "../../test-helpers/scoped-db-testing";
import { Payee } from "../entities/payee.entity";
import { PayeeContactEnrichmentService } from "./payee-contact-enrichment.service";
import { PayeeContactLookupService } from "./payee-contact-lookup.service";
import {
  ContactLookupOutcome,
  PayeeContactSuggestion,
} from "./payee-contact-lookup.types";

jest.mock("../../common/db/scoped-db", () =>
  jest
    .requireActual("../../test-helpers/scoped-db-testing")
    .scopedDbMockModule(),
);
jest.mock("../../common/db/with-context", () => ({
  withUserContext: jest.fn((_userId: string, fn: () => unknown) => fn()),
}));

describe("PayeeContactEnrichmentService", () => {
  let service: PayeeContactEnrichmentService;
  let payeeRepo: Record<string, jest.Mock>;
  let manager: Record<string, jest.Mock>;
  let lookup: jest.Mocked<Pick<PayeeContactLookupService, "lookup">>;
  let history: { record: jest.Mock };
  let favicon: jest.Mocked<Pick<FaviconService, "fetchFavicon">>;

  const userId = "user-1";
  const payeeId = "payee-1";
  const suggestion: PayeeContactSuggestion = {
    website: "https://acme.example",
    address: "1 Main St",
    email: "hi@acme.example",
    phone: "+1 555 010 2000",
    label: null,
    source: "ai-web-search",
    confidence: "high",
    notes: null,
    refined: [],
  };
  const emptyRow = {
    id: payeeId,
    website: null,
    address: null,
    email: null,
    phone: null,
  };
  const returned = (row: Record<string, unknown>) => [
    {
      website: null,
      address: null,
      email: null,
      phone: null,
      contact_lookup_source: null,
      ...row,
    },
  ];

  beforeEach(async () => {
    jest.clearAllMocks();
    payeeRepo = { findOne: jest.fn().mockResolvedValue(emptyRow) };
    lookup = {
      lookup: jest
        .fn()
        .mockResolvedValue({ reason: "ok", suggestions: [suggestion] }),
    };
    history = { record: jest.fn().mockResolvedValue(null) };
    favicon = { fetchFavicon: jest.fn().mockResolvedValue(null) };
    const scoped = createScopedDbMocks([[Payee, payeeRepo]]);
    manager = scoped.manager as unknown as Record<string, jest.Mock>;
    manager.query.mockResolvedValue(
      returned({
        website: "https://acme.example",
        address: "1 Main St",
        email: "hi@acme.example",
        phone: "+1 555 010 2000",
        contact_lookup_source: "ai-web-search",
      }),
    );
    manager.update.mockResolvedValue({ affected: 1 });

    const module = await Test.createTestingModule({
      providers: [
        PayeeContactEnrichmentService,
        { provide: DataSource, useValue: scoped.dataSource },
        { provide: PayeeContactLookupService, useValue: lookup },
        { provide: ActionHistoryService, useValue: history },
        { provide: FaviconService, useValue: favicon },
      ],
    }).compile();
    service = module.get(PayeeContactEnrichmentService);
  });

  const updateSql = (): string => manager.query.mock.calls[0][0] as string;
  const updateParams = (): unknown[] =>
    manager.query.mock.calls[0][1] as unknown[];

  describe("enrichAfterCreate", () => {
    it("fills only empty columns through COALESCE, first attempt only, and reports what it wrote", async () => {
      const result = await service.enrichAfterCreate(userId, payeeId, "Acme");

      expect(lookup.lookup).toHaveBeenCalledWith(userId, { name: "Acme" });
      const sql = updateSql();
      expect(sql).toMatch(/SET\s+website = COALESCE\(website, \$3\)/);
      expect(sql).toMatch(/address = COALESCE\(address, \$4\)/);
      expect(sql).toMatch(/email = COALESCE\(email, \$5\)/);
      expect(sql).toMatch(/phone = COALESCE\(phone, \$6\)/);
      expect(sql).toMatch(/contact_lookup_at = NOW\(\)/);
      expect(sql).toMatch(
        /WHERE id = \$1 AND user_id = \$2\s+AND contact_lookup_at IS NULL/,
      );
      expect(sql).toMatch(
        /RETURNING website, address, email, phone, contact_lookup_source/,
      );
      expect(updateParams()).toEqual([
        payeeId,
        userId,
        "https://acme.example",
        "1 Main St",
        "hi@acme.example",
        "+1 555 010 2000",
        "ai-web-search",
      ]);
      expect(result).toEqual({
        reason: "ok",
        filled: ["website", "address", "email", "phone"],
      });
    });

    it("moves the source only when this write set a field, and keeps it otherwise", () => {
      // The CASE is the mechanism; pin its shape rather than trust the prose.
      return service.enrichAfterCreate(userId, payeeId, "Acme").then(() => {
        const sql = updateSql();
        expect(sql).toMatch(
          /WHEN \(website IS NULL AND \$3::text IS NOT NULL\)\s+OR \(address IS NULL AND \$4::text IS NOT NULL\)\s+OR \(email IS NULL AND \$5::text IS NOT NULL\)\s+OR \(phone IS NULL AND \$6::text IS NOT NULL\)\s+THEN \$7::varchar\s+ELSE contact_lookup_source/,
        );
      });
    });

    it("holds the row's write lock across the read and the UPDATE", async () => {
      // The two statements are otherwise a check-then-act: a user editing the
      // payee while the lookup was in flight commits between them, and
      // `filled` -- computed from before/after -- credits the lookup with the
      // value they typed, recording it in their history and fetching a favicon
      // for it.
      await service.enrichAfterCreate(userId, payeeId, "Acme");

      expect(payeeRepo.findOne).toHaveBeenCalledWith(
        expect.objectContaining({ lock: { mode: "pessimistic_write" } }),
      );
    });

    it("reports as filled only the fields that were empty before and set after", async () => {
      payeeRepo.findOne.mockResolvedValue({
        ...emptyRow,
        website: "https://typed.example",
      });
      manager.query.mockResolvedValue(
        returned({
          website: "https://typed.example",
          address: "1 Main St",
          email: "hi@acme.example",
          phone: "+1 555 010 2000",
          contact_lookup_source: "ai-web-search",
        }),
      );

      const result = await service.enrichAfterCreate(userId, payeeId, "Acme");

      expect(result.filled).toEqual(["address", "email", "phone"]);
      expect(favicon.fetchFavicon).not.toHaveBeenCalled();
    });

    it("records history and caches the favicon when it set the website", async () => {
      favicon.fetchFavicon.mockResolvedValue({
        data: Buffer.from("png"),
        contentType: "image/png",
      });

      await service.enrichAfterCreate(userId, payeeId, "Acme");

      expect(history.record).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({
          entityType: "payee",
          entityId: payeeId,
          action: "update",
          descriptionKey: "lookedUpPayeeContact",
          descriptionParams: { name: "Acme" },
          beforeData: expect.objectContaining({ website: null }),
          afterData: expect.objectContaining({
            website: "https://acme.example",
            contactLookupSource: "ai-web-search",
          }),
        }),
      );
      expect(favicon.fetchFavicon).toHaveBeenCalledWith("https://acme.example");
      // Keyed on the website it resolved, never on the id alone.
      expect(manager.update).toHaveBeenCalledWith(
        Payee,
        { id: payeeId, userId, website: "https://acme.example" },
        expect.objectContaining({ hasLogo: true }),
      );
    });

    it("stamps the attempt with all-null values when the lookup found nothing", async () => {
      lookup.lookup.mockResolvedValue({ reason: "none", suggestions: [] });
      manager.query.mockResolvedValue(returned({}));

      const result = await service.enrichAfterCreate(userId, payeeId, "Acme");

      expect(updateParams()).toEqual([
        payeeId,
        userId,
        null,
        null,
        null,
        null,
        null,
      ]);
      expect(result).toEqual({ reason: "none", filled: [] });
      expect(history.record).not.toHaveBeenCalled();
    });

    it.each(["disabled", "no_provider", "failed"] as const)(
      "writes nothing for %s, so a later attempt can still run",
      async (reason) => {
        lookup.lookup.mockResolvedValue({
          reason,
          suggestions: [],
          ...(reason === "failed" ? { detail: "agent offline" } : {}),
        } as ContactLookupOutcome);

        const result = await service.enrichAfterCreate(userId, payeeId, "Acme");

        expect(manager.query).not.toHaveBeenCalled();
        expect(result).toEqual({
          reason,
          filled: [],
          ...(reason === "failed" ? { detail: "agent offline" } : {}),
        });
      },
    );

    it("does nothing further when the UPDATE matched no row (already attempted, or gone)", async () => {
      manager.query.mockResolvedValue([]);

      const result = await service.enrichAfterCreate(userId, payeeId, "Acme");

      expect(result).toEqual({ reason: "ok", filled: [] });
      expect(history.record).not.toHaveBeenCalled();
      expect(favicon.fetchFavicon).not.toHaveBeenCalled();
    });

    it("does nothing when the payee no longer exists", async () => {
      payeeRepo.findOne.mockResolvedValue(null);

      const result = await service.enrichAfterCreate(userId, payeeId, "Acme");

      expect(manager.query).not.toHaveBeenCalled();
      expect(result).toEqual({ reason: "ok", filled: [] });
    });
  });

  describe("dispatchAfterCreate", () => {
    it("runs the enrichment under the user's own context", async () => {
      service.dispatchAfterCreate(userId, payeeId, "Acme");
      await flush();

      expect(withUserContext).toHaveBeenCalledWith(
        userId,
        expect.any(Function),
      );
      expect(lookup.lookup).toHaveBeenCalledWith(userId, { name: "Acme" });
    });

    it("dedupes a re-dispatch for the same payee while one is in flight", async () => {
      let release!: () => void;
      lookup.lookup.mockReturnValue(
        new Promise((resolve) => {
          release = () => resolve({ reason: "none", suggestions: [] });
        }),
      );

      service.dispatchAfterCreate(userId, payeeId, "Acme");
      service.dispatchAfterCreate(userId, payeeId, "Acme");
      await flush();
      expect(lookup.lookup).toHaveBeenCalledTimes(1);

      release();
      await flush();
      service.dispatchAfterCreate(userId, payeeId, "Acme");
      await flush();
      expect(lookup.lookup).toHaveBeenCalledTimes(2);
    });

    it("logs a failure and never throws", async () => {
      const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation();
      lookup.lookup.mockRejectedValue(new Error("boom"));

      expect(() =>
        service.dispatchAfterCreate(userId, payeeId, "Acme"),
      ).not.toThrow();
      await flush();

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain("boom");
      warn.mockRestore();
    });
  });
});

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}
