import { DataSource } from "typeorm";
import { ConfigService } from "@nestjs/config";
import { TestingModule } from "@nestjs/testing";
import { createIntegrationModule } from "../helpers/integration-setup";
import { PushChartArtifactService } from "@/push/push-chart-artifact.service";
import { renderPriceChart } from "@/push/price-chart-png";
describe("one-use push chart token across replicas (real PostgreSQL)", () => {
  let module: TestingModule;
  let db: DataSource;
  beforeAll(async () => {
    module = await createIntegrationModule([]);
    db = module.get(DataSource);
  });
  afterAll(async () => {
    await module?.close();
  });
  it("gives exactly one concurrent consumer the PNG and refuses replay", async () => {
    const config = {
      get: () => "shared-chart-integration-secret",
    } as unknown as ConfigService;
    const a = new PushChartArtifactService(db, config),
      b = new PushChartArtifactService(db, config);
    const png = renderPriceChart([
      { date: "2026-09-01", close: 100 },
      { date: "2026-09-02", close: 105 },
    ])!;
    const path = await a.issue(png);
    expect(path).not.toBeNull();
    const token = path!.split("/").pop()!.slice(0, -4);
    const results = await Promise.all([a.consume(token), b.consume(token)]);
    expect(results.filter(Boolean)).toEqual([png]);
    expect(await b.consume(token)).toBeNull();
  });
});
