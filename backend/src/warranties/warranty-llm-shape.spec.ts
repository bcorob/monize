import { WarrantyView } from "./dto/warranty-response.dto";
import {
  LLM_WARRANTY_DEFAULT_LIMIT,
  LLM_WARRANTY_MAX_LIMIT,
  llmWarrantyListQuery,
  toLlmWarrantyList,
} from "./warranty-llm-shape";
import { WARRANTY_EXPIRING_WINDOW_DAYS } from "./warranty-status.util";

/** A view as `WarrantiesService.findAll` answers it. */
function view(overrides: Partial<WarrantyView> = {}): WarrantyView {
  return {
    id: "w-1",
    name: "Laptop",
    vendorName: "Best Buy",
    payeeId: null,
    payee: null,
    modelNumber: "X1",
    serialNumbers: ["SN-1"],
    warrantyKind: "manufacturer",
    purchaseDate: "2026-10-01",
    expiresOn: "2028-10-01",
    isLifetime: false,
    purchasePrice: 1499.99,
    currencyCode: "CAD",
    productUrl: "https://example.com",
    notes: "kept in the drawer",
    today: "2026-10-21",
    status: "active",
    daysLeft: 711,
    documentCount: 2,
    openClaimCount: 1,
    linkedTransaction: null,
    linkedTransactionHidden: false,
    archivedAt: null,
    createdAt: "2026-10-01T12:00:00.000Z",
    updatedAt: "2026-10-01T12:00:00.000Z",
    ...overrides,
  };
}

describe("warranty-llm-shape (decision 11)", () => {
  describe("llmWarrantyListQuery", () => {
    it("reads the unarchived first page, soonest expiry first, every status by default", () => {
      expect(llmWarrantyListQuery({})).toEqual({
        status: "all",
        q: undefined,
        archived: false,
        sort: "expiresOn",
        page: 1,
        limit: LLM_WARRANTY_DEFAULT_LIMIT,
      });
    });

    it("forwards the status and the search", () => {
      expect(
        llmWarrantyListQuery({ status: "expiring", q: "fridge" }),
      ).toMatchObject({ status: "expiring", q: "fridge" });
    });

    it.each([
      [0, 1],
      [-5, 1],
      [2.7, 2],
      [LLM_WARRANTY_MAX_LIMIT + 1, LLM_WARRANTY_MAX_LIMIT],
    ])("clamps a limit of %p to %p", (limit, expected) => {
      expect(llmWarrantyListQuery({ limit }).limit).toBe(expected);
    });
  });

  describe("toLlmWarrantyList", () => {
    it("keeps the server's status and drops what a model has no use for", () => {
      const list = toLlmWarrantyList(
        "2026-10-21",
        [view({ transactionId: "t-1" }), view({ id: "w-2" })],
        7,
      );

      expect(list).toMatchObject({
        today: "2026-10-21",
        windowDays: WARRANTY_EXPIRING_WINDOW_DAYS,
        total: 7,
      });
      expect(list.warranties[0]).toEqual({
        id: "w-1",
        name: "Laptop",
        vendorName: "Best Buy",
        warrantyKind: "manufacturer",
        purchaseDate: "2026-10-01",
        expiresOn: "2028-10-01",
        isLifetime: false,
        status: "active",
        daysLeft: 711,
        purchasePrice: 1499.99,
        currencyCode: "CAD",
        serialNumbers: ["SN-1"],
        linkedTransactionId: "t-1",
        openClaimCount: 1,
        documentCount: 2,
        archived: false,
      });
      // A view with no `transactionId` (no link, or one hidden from the
      // reader, WTY-007) answers null.
      expect(list.warranties[1].linkedTransactionId).toBeNull();
    });
  });
});
