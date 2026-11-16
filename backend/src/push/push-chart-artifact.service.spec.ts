import { ConfigService } from "@nestjs/config";
import {
  PushChartArtifactService,
  CHART_TOKEN_TTL_MS,
} from "./push-chart-artifact.service";
import { PUSH_TTL_SECONDS } from "./web-push-sender.service";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import { renderPriceChart } from "./price-chart-png";
jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);
const png = renderPriceChart([
  { date: "2026-09-01", close: 100 },
  { date: "2026-09-02", close: 101 },
])!;
const config = (secret = "chart-test-secret") =>
  ({ get: () => secret }) as unknown as ConfigService;
function setup() {
  const { dataSource, manager } = createScopedDbMocks([]);
  const service = new PushChartArtifactService(dataSource as any, config());
  manager.query.mockResolvedValue([]);
  return { service, manager, dataSource };
}
async function issue(s: ReturnType<typeof setup>) {
  s.manager.query
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([[], 0])
    .mockResolvedValueOnce([{ id: "inserted" }]);
  return (await s.service.issue(png))!.split("/").pop()!.slice(0, -4);
}
describe("push chart bearer tokens", () => {
  afterEach(() => jest.restoreAllMocks());
  it("keeps the token valid as long as the push it rides on (A26-L27)", () => {
    expect(CHART_TOKEN_TTL_MS).toBeGreaterThanOrEqual(PUSH_TTL_SECONDS * 1000);
  });
  it("mints separate credentials for separate devices", async () => {
    const s = setup();
    expect(await issue(s)).not.toBe(await issue(s));
  });
  it("consumes via atomic DELETE RETURNING and reads the PostgreSQL tuple shape", async () => {
    const s = setup(),
      token = await issue(s);
    s.manager.query.mockClear().mockResolvedValueOnce([[{ png }], 1]);
    expect(await s.service.consume(token)).toEqual(png);
    expect(s.manager.query.mock.calls[0][0]).toMatch(
      /DELETE FROM push_chart_artifacts[\s\S]*RETURNING png/,
    );
    expect(s.manager.query.mock.calls[0][1][0]).toBe(token.split(".")[0]);
  });
  it("rejects tampering, path traversal, expiry and key rotation before querying", async () => {
    const s = setup(),
      token = await issue(s);
    s.manager.query.mockClear();
    for (const bad of [
      "../secret",
      "%2e%2e%2fsecret",
      token + "x",
      token.replace(/.$/, token.endsWith("0") ? "1" : "0"),
    ])
      expect(await s.service.consume(bad)).toBeNull();
    expect(
      await new PushChartArtifactService(
        s.dataSource as any,
        config("rotated"),
      ).consume(token),
    ).toBeNull();
    const now = Date.now();
    jest.spyOn(Date, "now").mockReturnValue(now + CHART_TOKEN_TTL_MS + 1);
    expect(await s.service.consume(token)).toBeNull();
    expect(s.manager.query).not.toHaveBeenCalled();
  });
  it("does not mint a URL when storage is full or PNG is invalid", async () => {
    const s = setup();
    expect(await s.service.issue(png)).toBeNull();
    s.manager.query.mockClear();
    expect(await s.service.issue(Buffer.alloc(70000))).toBeNull();
    expect(await s.service.issue(Buffer.from("not PNG"))).toBeNull();
    expect(s.manager.query).not.toHaveBeenCalled();
  });
  it("does not mint without a signing secret", async () => {
    const s = setup();
    expect(
      await new PushChartArtifactService(s.dataSource as any, config("")).issue(
        png,
      ),
    ).toBeNull();
    expect(s.manager.query).not.toHaveBeenCalled();
  });
});
