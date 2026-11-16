import "reflect-metadata";
import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { InvestmentTransactionSummaryController } from "./investment-transaction-summary.controller";
import { InvestmentTransactionSummaryQueryDto } from "./dto/investment-transaction-summary.dto";
import { InvestmentAction } from "../securities/entities/investment-transaction.entity";

const UUID = "d290f1ee-6c54-4b01-90e6-d701748f0851";

function buildDto(data: unknown): InvestmentTransactionSummaryQueryDto {
  return plainToInstance(InvestmentTransactionSummaryQueryDto, data, {
    enableImplicitConversion: true,
  });
}

async function constraints(data: unknown): Promise<string[]> {
  const errors = await validate(buildDto(data));
  return errors.flatMap((e) => Object.keys(e.constraints ?? {}));
}

describe("InvestmentTransactionSummaryController", () => {
  it("takes the user id from the JWT, never from the query", async () => {
    const service = { summarize: jest.fn().mockResolvedValue({ total: 0 }) };
    const controller = new InvestmentTransactionSummaryController(
      service as never,
    );
    const query = buildDto({ accountIds: UUID });

    await controller.summary(
      { user: { id: "u1" }, query: { userId: "someone-else" } } as never,
      query,
    );

    expect(service.summarize).toHaveBeenCalledWith("u1", query);
  });
});

describe("InvestmentTransactionSummaryQueryDto", () => {
  it("accepts a comma-separated account list and action list", async () => {
    const dto = buildDto({
      accountIds: `${UUID},${UUID}`,
      startDate: "2026-01-01",
      endDate: "2026-12-31",
      actions: "BUY,SELL",
    });
    expect(await validate(dto)).toEqual([]);
    expect(dto.accountIds).toEqual([UUID, UUID]);
    expect(dto.actions).toEqual([InvestmentAction.BUY, InvestmentAction.SELL]);
  });

  it("accepts an empty filter", async () => {
    expect(await constraints({})).toEqual([]);
  });

  it("rejects an account id that is not a UUID", async () => {
    expect(await constraints({ accountIds: "not-a-uuid" })).toContain("isUuid");
  });

  it("rejects an unbounded account list", async () => {
    const ids = Array.from({ length: 201 }, () => UUID).join(",");
    expect(await constraints({ accountIds: ids })).toContain("arrayMaxSize");
  });

  it("rejects an action outside the vocabulary", async () => {
    expect(await constraints({ actions: "BUY,NOT_AN_ACTION" })).toContain(
      "isEnum",
    );
  });

  it("rejects a malformed date", async () => {
    expect(await constraints({ startDate: "01/01/2026" })).toContain(
      "isDateString",
    );
  });
});
