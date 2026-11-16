import { EntityManager } from "typeorm";
import { TransactionRulesApplierService } from "../../../transaction-rules/transaction-rules-applier.service";
import { TransactionRule } from "../../../transaction-rules/transaction-rule.entity";
import { MappedTransaction } from "../model/mny-import-model";
import { applyImportRules, eligibleImportRuleIds } from "./apply-import-rules";
import { INSERT_CHUNK_SIZE } from "./chunk";

const tx = (
  id: string,
  over: Partial<MappedTransaction> = {},
): MappedTransaction =>
  ({
    id,
    handle: 1,
    accountKey: "acct-1",
    payeeHandle: 5,
    isTransfer: false,
    linkedTransactionId: null,
    collapsedTradeHandle: null,
    tagHandles: [],
    splits: [],
    ...over,
  }) as unknown as MappedTransaction;

describe("apply-import-rules", () => {
  const manager = {} as EntityManager;
  const rules = [{ id: "rule-1" }] as unknown as TransactionRule[];
  let applier: { loadRulesFor: jest.Mock; applyToNew: jest.Mock };

  const run = (
    transactions: MappedTransaction[],
    over: { cash?: string[]; written?: string[] } = {},
  ) =>
    applyImportRules(
      manager,
      applier as unknown as TransactionRulesApplierService,
      "user-1",
      {
        transactions,
        writtenTransactionIds: new Set(
          over.written ?? transactions.map((t) => t.id),
        ),
        payeeNameByHandle: new Map([[5, "Loblaws"]]),
        investmentCashTransactionIds: new Set(over.cash ?? []),
      },
    );

  beforeEach(() => {
    applier = {
      loadRulesFor: jest.fn().mockResolvedValue(rules),
      applyToNew: jest.fn().mockResolvedValue([]),
    };
  });

  describe("eligibleImportRuleIds", () => {
    it("keeps regular written rows and drops transfers, linked rows, trade cash rows and unwritten rows", () => {
      const ids = eligibleImportRuleIds({
        transactions: [
          tx("regular"),
          tx("transfer", { isTransfer: true }),
          tx("linked", { linkedTransactionId: "other" }),
          tx("collapsed", { collapsedTradeHandle: 3 }),
          tx("cash"),
          tx("unwritten"),
        ],
        writtenTransactionIds: new Set([
          "regular",
          "transfer",
          "linked",
          "collapsed",
          "cash",
        ]),
        payeeNameByHandle: new Map(),
        investmentCashTransactionIds: new Set(["cash"]),
      });
      expect(ids).toEqual(["regular"]);
    });
  });

  describe("applyImportRules", () => {
    it("loads the rules once and applies them with the payee name as the raw text", async () => {
      await run([tx("a"), tx("b", { payeeHandle: null })]);

      expect(applier.loadRulesFor).toHaveBeenCalledTimes(1);
      expect(applier.loadRulesFor).toHaveBeenCalledWith(
        manager,
        "user-1",
        "import",
      );
      expect(applier.applyToNew).toHaveBeenCalledTimes(1);
      const [m, userId, ids, source, options] =
        applier.applyToNew.mock.calls[0];
      expect(m).toBe(manager);
      expect(userId).toBe("user-1");
      expect(ids).toEqual(["a", "b"]);
      expect(source).toBe("import");
      expect(options.rules).toBe(rules);
      expect(options.payeeTextById.get("a")).toBe("Loblaws");
      expect(options.payeeTextById.get("b")).toBeNull();
    });

    it("loads nothing when no row is eligible", async () => {
      expect((await run([tx("t", { isTransfer: true })])).changed).toBe(0);
      expect(applier.loadRulesFor).not.toHaveBeenCalled();
      expect(applier.applyToNew).not.toHaveBeenCalled();
    });

    it("writes nothing when the user has no import rule", async () => {
      applier.loadRulesFor.mockResolvedValue([]);
      expect((await run([tx("a")])).changed).toBe(0);
      expect(applier.applyToNew).not.toHaveBeenCalled();
    });

    it("hands the applier the rows oldest first, keeping the file's order within a date (INV-RULE-005)", async () => {
      await run([
        tx("march", { transactionDate: "2024-03-01" }),
        tx("jan-first", { transactionDate: "2024-01-05" }),
        tx("jan-second", { transactionDate: "2024-01-05" }),
        tx("feb", { transactionDate: "2024-02-01" }),
      ]);
      expect(applier.applyToNew.mock.calls[0][2]).toEqual([
        "jan-first",
        "jan-second",
        "feb",
        "march",
      ]);
    });

    it("batches the rows, so facts are read per chunk and not per row", async () => {
      const rows = Array.from({ length: INSERT_CHUNK_SIZE + 1 }, (_, i) =>
        tx(`t-${i}`),
      );
      await run(rows);
      expect(applier.applyToNew).toHaveBeenCalledTimes(2);
      expect(applier.applyToNew.mock.calls[0][2]).toHaveLength(
        INSERT_CHUNK_SIZE,
      );
      expect(applier.applyToNew.mock.calls[1][2]).toEqual([
        `t-${INSERT_CHUNK_SIZE}`,
      ]);
      expect(applier.loadRulesFor).toHaveBeenCalledTimes(1);
    });

    it("counts only the rows a rule changed", async () => {
      applier.applyToNew.mockResolvedValue([
        {
          transactionId: "a",
          effects: {
            trace: [{ ruleId: "r", matched: true, changes: { x: 1 } }],
          },
          affectedAccountIds: [],
          settledScheduleIds: [],
        },
        {
          transactionId: "b",
          effects: { trace: [{ ruleId: "r", matched: true, changes: {} }] },
          affectedAccountIds: [],
          settledScheduleIds: [],
        },
      ]);
      expect((await run([tx("a"), tx("b")])).changed).toBe(1);
    });

    it("returns the accounts a structural action moved, once each, across batches", async () => {
      applier.applyToNew.mockResolvedValue([
        {
          transactionId: "a",
          effects: { trace: [] },
          affectedAccountIds: ["loan", "other"],
          settledScheduleIds: [],
        },
        {
          transactionId: "b",
          effects: { trace: [] },
          affectedAccountIds: ["loan"],
          settledScheduleIds: [],
        },
      ]);
      const result = await run([tx("a"), tx("b")]);
      expect([...result.affectedAccountIds].sort()).toEqual(["loan", "other"]);
    });

    it("returns the schedules a settlement claimed on, once each, across batches", async () => {
      applier.applyToNew.mockResolvedValue([
        {
          transactionId: "a",
          effects: { trace: [] },
          affectedAccountIds: ["loan"],
          settledScheduleIds: ["st-loan"],
        },
        {
          transactionId: "b",
          effects: { trace: [] },
          affectedAccountIds: [],
          settledScheduleIds: ["st-loan"],
        },
      ]);
      const result = await run([tx("a"), tx("b")]);
      expect([...result.settledScheduleIds]).toEqual(["st-loan"]);
    });

    it("returns no accounts when no rule applies", async () => {
      applier.loadRulesFor.mockResolvedValue([]);
      const result = await run([tx("a")]);
      expect(result).toEqual({
        changed: 0,
        affectedAccountIds: new Set(),
        settledScheduleIds: new Set(),
      });
    });
  });
});
