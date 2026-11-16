import { BadRequestException } from "@nestjs/common";
import { DataSource } from "typeorm";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import { Transaction } from "../transactions/entities/transaction.entity";
import { TransactionStatus } from "../transactions/entities/transaction-status.enum";
import type {
  TransactionWithInvestmentLink,
  TransactionsService,
} from "../transactions/transactions.service";
import { RuleConditionNode } from "./rule-condition.types";
import { loadAttachmentPresence } from "./rule-facts";
import { CandidateUnit, loadCandidateUnits } from "./rule-run-candidates";
import { TransactionRulesApplierService } from "./transaction-rules-applier.service";
import { TransactionRulesMatchService } from "./transaction-rules-match.service";
import { TransactionRulesService } from "./transaction-rules.service";
import { MAX_RULE_MATCH_SCAN } from "./transaction-rules.limits";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);
jest.mock("./rule-run-candidates", () => ({
  ...jest.requireActual("./rule-run-candidates"),
  loadCandidateUnits: jest.fn(),
}));
jest.mock("./rule-facts", () => ({
  ...jest.requireActual("./rule-facts"),
  loadAttachmentPresence: jest.fn(),
}));

const USER = "user-1";
const CAT = "c0000000-0000-4000-8000-000000000003";
const PARENT = "c0000000-0000-4000-8000-000000000001";

const PAYEE_CONDITION: RuleConditionNode = {
  field: "payeeText",
  op: "contains",
  value: "coffee",
};

const row = (
  id: string,
  payeeName: string,
  over: Partial<Transaction> = {},
): Transaction =>
  ({
    id,
    userId: USER,
    accountId: "acc-1",
    currencyCode: "CAD",
    amount: -4.5,
    transactionDate: "2026-10-05",
    isTransfer: false,
    linkedTransactionId: null,
    parentTransactionId: null,
    payeeId: null,
    payeeName,
    categoryId: null,
    description: null,
    referenceNumber: null,
    isSplit: false,
    status: TransactionStatus.UNRECONCILED,
    ...over,
  }) as Transaction;

const unit = (r: Transaction): CandidateUnit => ({
  primary: r,
  legs: [r],
  isTransfer: false,
  fromAccountId: null,
  toAccountId: null,
  crossOwnerTransferLeg: false,
});

function setup(
  units: CandidateUnit[],
  options: { truncated?: boolean; chains?: Map<string, string[]> } = {},
) {
  (loadCandidateUnits as jest.Mock).mockResolvedValue({
    units,
    truncated: options.truncated ?? false,
  });
  (loadAttachmentPresence as jest.Mock).mockResolvedValue(new Set<string>());
  const applier = new TransactionRulesApplierService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  jest
    .spyOn(applier, "loadTagIds")
    .mockResolvedValue(new Map<string, string[]>());
  jest
    .spyOn(applier, "chainsFor")
    .mockResolvedValue(options.chains ?? new Map());
  const rulesService = {
    checkedCondition: jest
      .fn()
      .mockImplementation(async (_m, _u, condition) => condition),
    activeWindowInvalid: () => new BadRequestException("window"),
  };
  // The register read returns the rows it was asked for, as the real one does.
  const findRegisterRowsByIds = jest
    .fn()
    .mockImplementation(
      async (_u: string, ids: readonly string[]) =>
        ids.map((id) => ({ id })) as TransactionWithInvestmentLink[],
    );
  const { dataSource } = createScopedDbMocks([]);
  const service = new TransactionRulesMatchService(
    dataSource as unknown as DataSource,
    rulesService as unknown as TransactionRulesService,
    applier,
    { findRegisterRowsByIds } as unknown as TransactionsService,
  );
  return { service, rulesService, findRegisterRowsByIds };
}

const scanCall = () => {
  const calls = (loadCandidateUnits as jest.Mock).mock.calls;
  return calls[calls.length - 1] as [
    unknown,
    string,
    { startDate?: string; endDate?: string; limit?: number },
    { lock: boolean; maxLimit?: number },
  ];
};

describe("TransactionRulesMatchService.matchDraft", () => {
  beforeEach(() => jest.clearAllMocks());

  it("returns only the rows whose condition matches, with the count of matches as the total", async () => {
    const { service, findRegisterRowsByIds } = setup([
      unit(row("a", "Coffee House")),
      unit(row("b", "Grocer")),
      unit(row("c", "Corner coffee")),
    ]);
    const page = await service.matchDraft(USER, {
      condition: PAYEE_CONDITION as never,
    });
    expect(findRegisterRowsByIds).toHaveBeenCalledWith(USER, ["a", "c"]);
    expect(page.data.map((r) => r.id)).toEqual(["a", "c"]);
    expect(page.pagination).toEqual({
      page: 1,
      limit: 10,
      total: 2,
      totalPages: 1,
      hasMore: false,
    });
    expect(page.scanned).toBe(3);
    expect(page.truncated).toBe(false);
  });

  it("pages through the matches ten at a time by default", async () => {
    const units = Array.from({ length: 23 }, (_, i) =>
      unit(row(`r${i}`, "coffee")),
    );
    const { service, findRegisterRowsByIds } = setup(units);
    const page = await service.matchDraft(USER, {
      condition: PAYEE_CONDITION as never,
      page: 3,
    });
    expect(findRegisterRowsByIds).toHaveBeenCalledWith(USER, [
      "r20",
      "r21",
      "r22",
    ]);
    expect(page.pagination).toMatchObject({
      page: 3,
      total: 23,
      totalPages: 3,
      hasMore: false,
    });
  });

  it("answers an empty page with a zero total when nothing matches", async () => {
    const { service, findRegisterRowsByIds } = setup([
      unit(row("b", "Grocer")),
    ]);
    const page = await service.matchDraft(USER, {
      condition: PAYEE_CONDITION as never,
    });
    expect(findRegisterRowsByIds).toHaveBeenCalledWith(USER, []);
    expect(page.data).toEqual([]);
    expect(page.pagination.total).toBe(0);
    expect(page.scanned).toBe(1);
  });

  it("matches a category through its ancestors, as a run does", async () => {
    const { service } = setup([unit(row("child", "x", { categoryId: CAT }))], {
      chains: new Map([[CAT, [CAT, PARENT]]]),
    });
    const page = await service.matchDraft(USER, {
      condition: {
        field: "categoryId",
        op: "inSubtree",
        value: PARENT,
      } as never,
    });
    expect(page.pagination.total).toBe(1);
  });

  it("narrows the scan to the active window and leaves out a row outside it", async () => {
    const { service } = setup([
      unit(row("before", "coffee", { transactionDate: "2026-09-30" })),
      unit(row("inside", "coffee", { transactionDate: "2026-10-01" })),
    ]);
    const page = await service.matchDraft(USER, {
      condition: PAYEE_CONDITION as never,
      activeFrom: "2026-10-01",
      activeTo: "",
    });
    expect(page.data.map((r) => r.id)).toEqual(["inside"]);
    const [, user, filters, options] = scanCall();
    expect(user).toBe(USER);
    expect(filters).toEqual({
      startDate: "2026-10-01",
      endDate: undefined,
      limit: MAX_RULE_MATCH_SCAN,
    });
    expect(options).toEqual({ lock: false, maxLimit: MAX_RULE_MATCH_SCAN });
  });

  it("refuses a window that ends before it starts, before reading anything", async () => {
    const { service, rulesService } = setup([]);
    await expect(
      service.matchDraft(USER, {
        condition: PAYEE_CONDITION as never,
        activeFrom: "2026-10-02",
        activeTo: "2026-10-01",
      }),
    ).rejects.toThrow(BadRequestException);
    expect(rulesService.checkedCondition).not.toHaveBeenCalled();
    expect(loadCandidateUnits).not.toHaveBeenCalled();
  });

  it("refuses a condition the validation refuses", async () => {
    const { service, rulesService } = setup([]);
    rulesService.checkedCondition.mockRejectedValue(
      new BadRequestException("invalid"),
    );
    await expect(
      service.matchDraft(USER, { condition: {} as never }),
    ).rejects.toThrow(BadRequestException);
    expect(loadCandidateUnits).not.toHaveBeenCalled();
  });

  it("says when the scan stopped short of the whole register", async () => {
    const { service } = setup([unit(row("a", "coffee"))], { truncated: true });
    const page = await service.matchDraft(USER, {
      condition: PAYEE_CONDITION as never,
    });
    expect(page.truncated).toBe(true);
  });
});
