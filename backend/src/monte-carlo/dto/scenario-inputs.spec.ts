import "reflect-metadata";
import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { RunScenarioDto } from "./run-scenario.dto";
import { CreateScenarioDto } from "./create-scenario.dto";
import { UpdateScenarioDto } from "./update-scenario.dto";
import { MAX_SCENARIO_CASH_FLOWS } from "./cash-flow.dto";

const baseInputs = {
  accountIds: [],
  startingValue: 100000,
  useCurrentBalance: false,
  yearsToRetirement: 100,
  annualContribution: 0,
  contributionGrowthRate: 0,
  yearsInRetirement: 100,
  annualWithdrawal: 0,
  expectedReturn: 0.05,
  volatility: 0.1,
  inflationRate: 0.02,
  showRealValues: false,
  useHistoricalReturns: false,
  simulationCount: 50000,
};

const flows = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    name: `Flow ${i}`,
    amount: 100,
    flowType: "RECURRING",
    startYear: 1,
    inflationAdjust: true,
  }));

async function cashFlowErrors(
  cls: new () => object,
  data: Record<string, unknown>,
) {
  const errors = await validate(plainToInstance(cls, data));
  return errors.filter((e) => e.property === "cashFlows");
}

describe("ScenarioInputs.cashFlows bound", () => {
  // simulations x years x cash flows runs synchronously on the event loop,
  // so an unbounded list lets one request stall the server.
  it("accepts exactly the limit", async () => {
    expect(
      await cashFlowErrors(RunScenarioDto, {
        ...baseInputs,
        cashFlows: flows(MAX_SCENARIO_CASH_FLOWS),
      }),
    ).toHaveLength(0);
  });

  it.each([
    ["RunScenarioDto", RunScenarioDto, {}],
    ["CreateScenarioDto", CreateScenarioDto, { name: "Plan" }],
    ["UpdateScenarioDto", UpdateScenarioDto, {}],
  ] as const)(
    "%s rejects one more than the limit",
    async (_label, cls, extra) => {
      const errors = await cashFlowErrors(cls, {
        ...baseInputs,
        ...extra,
        cashFlows: flows(MAX_SCENARIO_CASH_FLOWS + 1),
      });
      expect(errors).toHaveLength(1);
      expect(errors[0].constraints).toHaveProperty("arrayMaxSize");
    },
  );
});
