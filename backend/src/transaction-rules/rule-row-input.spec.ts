import { BadRequestException } from "@nestjs/common";
import { Account } from "../accounts/entities/account.entity";
import { Category } from "../categories/entities/category.entity";
import { Payee } from "../payees/entities/payee.entity";
import { Tag } from "../tags/entities/tag.entity";
import { RuleRowInputDto } from "./dto/explain-rule-row.dto";
import { checkedRuleRowInput } from "./rule-row-input";

const uuid = (n: number): string =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const USER = "user-1";
const ACCOUNT = uuid(1);
const OTHER_ACCOUNT = uuid(2);
const FOREIGN_ACCOUNT = uuid(90);
const PAYEE = uuid(3);
const CATEGORY = uuid(4);
const TAG = uuid(5);

const dto = (over: Partial<RuleRowInputDto> = {}): RuleRowInputDto => ({
  accountId: ACCOUNT,
  currencyCode: "PLN",
  amount: "-12.5000",
  isTransfer: false,
  payeeId: PAYEE,
  payeeText: "Sklep",
  categoryId: CATEGORY,
  description: "milk",
  tagIds: [TAG],
  hasSplits: false,
  ...over,
});

/** The user's own ids; anything else is "not found", as under RLS and a userId filter. */
function harness(accountCurrency = "PLN") {
  const mine = new Set([ACCOUNT, OTHER_ACCOUNT, PAYEE, CATEGORY, TAG]);
  const find = jest.fn(
    async (opts: { where: { id: { value: string[] }; userId: string } }) =>
      opts.where.id.value.filter((id) => mine.has(id)).map((id) => ({ id })),
  );
  const findOne = jest.fn(
    async (opts: { where: { id: string; userId: string } }) =>
      mine.has(opts.where.id) && opts.where.userId === USER
        ? { id: opts.where.id, currencyCode: accountCurrency }
        : null,
  );
  const repos = new Map<unknown, unknown>([
    [Account, { find, findOne }],
    [Payee, { find }],
    [Category, { find }],
    [Tag, { find }],
  ]);
  const m = {
    getRepository: jest.fn((entity: unknown) => repos.get(entity)),
    update: jest.fn(),
    insert: jest.fn(),
    save: jest.fn(),
    query: jest.fn(),
  };
  return { m: m as never, mock: m, find, findOne };
}

describe("checkedRuleRowInput", () => {
  it("turns a row of the caller's own into the rule input, with the account's currency", async () => {
    const h = harness("PLN");
    const input = await checkedRuleRowInput(h.m, USER, dto());

    expect(input).toEqual({
      accountId: ACCOUNT,
      currencyCode: "PLN",
      amount: "-12.5000",
      isTransfer: false,
      fromAccountId: null,
      toAccountId: null,
      payeeId: PAYEE,
      payeeText: "Sklep",
      categoryId: CATEGORY,
      description: "milk",
      tagIds: [TAG],
      hasSplits: false,
      referenceNumber: null,
      transactionDate: null,
      status: null,
      hasAttachment: false,
    });
  });

  it("derives the currency from the account when the request leaves it out", async () => {
    const h = harness("eur");
    const input = await checkedRuleRowInput(
      h.m,
      USER,
      dto({ currencyCode: null }),
    );
    expect(input.currencyCode).toBe("EUR");
  });

  it("refuses a currency that is not the account's", async () => {
    const h = harness("PLN");
    await expect(
      checkedRuleRowInput(h.m, USER, dto({ currencyCode: "USD" })),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("reads absent optional fields as unknown (null), never as a default", async () => {
    const h = harness();
    const input = await checkedRuleRowInput(
      h.m,
      USER,
      dto({
        payeeId: undefined as never,
        payeeText: undefined as never,
        categoryId: undefined as never,
        description: undefined as never,
        amount: undefined as never,
      }),
    );
    expect(input).toMatchObject({
      payeeId: null,
      payeeText: null,
      categoryId: null,
      description: null,
      amount: null,
    });
    expect("payeeName" in input).toBe(false);
  });

  it("keeps the stored payee name and the X3 facts when they are sent", async () => {
    const h = harness();
    const input = await checkedRuleRowInput(
      h.m,
      USER,
      dto({
        payeeName: "Sklep Alfa",
        referenceNumber: "REF-1",
        transactionDate: "2026-03-01",
        status: "CLEARED",
        hasAttachment: true,
      }),
    );
    expect(input).toMatchObject({
      payeeName: "Sklep Alfa",
      referenceNumber: "REF-1",
      transactionDate: "2026-03-01",
      status: "CLEARED",
      hasAttachment: true,
    });
  });

  describe("ownership", () => {
    it.each([
      ["account", { accountId: FOREIGN_ACCOUNT }],
      ["transfer source account", { fromAccountId: FOREIGN_ACCOUNT }],
      ["transfer target account", { toAccountId: FOREIGN_ACCOUNT }],
      ["payee", { payeeId: uuid(91) }],
      ["category", { categoryId: uuid(92) }],
      ["tag", { tagIds: [TAG, uuid(93)] }],
    ])(
      "refuses a foreign %s with 400 REFERENCE_NOT_FOUND, like one that does not exist",
      async (_name, over) => {
        const h = harness();
        const error = await checkedRuleRowInput(
          h.m,
          USER,
          dto(over as Partial<RuleRowInputDto>),
        ).catch((e) => e);
        expect(error).toBeInstanceOf(BadRequestException);
        expect(error.getResponse()).toMatchObject({
          errorCode: "REFERENCE_NOT_FOUND",
        });
        // The message does not say which id, or whose it is.
        expect(JSON.stringify(error.getResponse())).not.toContain(
          FOREIGN_ACCOUNT,
        );
        expect(h.mock.update).not.toHaveBeenCalled();
      },
    );

    it("scopes every lookup by the caller's id", async () => {
      const h = harness();
      await checkedRuleRowInput(
        h.m,
        USER,
        dto({ fromAccountId: ACCOUNT, toAccountId: OTHER_ACCOUNT }),
      );
      expect(h.findOne.mock.calls[0][0].where).toEqual({
        id: ACCOUNT,
        userId: USER,
      });
      for (const [opts] of h.find.mock.calls) {
        expect(opts.where.userId).toBe(USER);
      }
    });

    it("writes nothing", async () => {
      const h = harness();
      await checkedRuleRowInput(h.m, USER, dto());
      expect(h.mock.update).not.toHaveBeenCalled();
      expect(h.mock.insert).not.toHaveBeenCalled();
      expect(h.mock.save).not.toHaveBeenCalled();
      expect(h.mock.query).not.toHaveBeenCalled();
    });
  });
});
