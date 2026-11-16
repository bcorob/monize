import {
  PushPriceChartService,
  priceChartRequest,
} from "./push-price-chart.service";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import { renderPriceChart } from "./price-chart-png";
jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);
const request = {
  securityId: "11111111-1111-4111-8111-111111111111",
  priceDate: "2026-09-02",
  price: 110,
};
function setup() {
  const { dataSource, manager } = createScopedDbMocks([]);
  const artifacts = { issue: jest.fn() };
  return {
    manager,
    artifacts,
    service: new PushPriceChartService(dataSource as any, artifacts as any),
  };
}
describe("opted-in owner-scoped price charts", () => {
  it("requires owner, active alert and explicit chart opt-in before reading prices", async () => {
    const s = setup();
    s.manager.query.mockResolvedValueOnce([]);
    expect(await s.service.render("owner", request)).toBeNull();
    expect(s.manager.query).toHaveBeenCalledTimes(1);
    expect(s.manager.query).toHaveBeenCalledWith(
      expect.stringMatching(
        /user_id = \$2[\s\S]*price_chart_enabled = true[\s\S]*price_alert_percent IS NOT NULL/,
      ),
      [request.securityId, "owner"],
    );
  });
  it("bounds historical closes and appends the notification snapshot", async () => {
    const s = setup();
    s.manager.query
      .mockResolvedValueOnce([{ id: request.securityId }])
      .mockResolvedValueOnce([
        { date: "2026-09-01", close: "105" },
        { date: "2026-08-31", close: "100" },
      ]);
    expect(await s.service.render("owner", request)).toEqual(
      renderPriceChart([
        { date: "2026-08-31", close: 100 },
        { date: "2026-09-01", close: 105 },
        { date: request.priceDate, close: 110 },
      ]),
    );
    expect(s.manager.query.mock.calls[1][1]).toEqual([
      request.securityId,
      request.priceDate,
      59,
    ]);
  });
  it("falls back to text on missing history or query/storage failures", async () => {
    const s = setup();
    s.manager.query
      .mockResolvedValueOnce([{ id: request.securityId }])
      .mockResolvedValueOnce([]);
    expect(await s.service.render("owner", request)).toBeNull();
    s.manager.query.mockRejectedValueOnce(new Error("unavailable"));
    expect(await s.service.render("owner", request)).toBeNull();
    s.artifacts.issue.mockRejectedValueOnce(new Error("full"));
    expect(await s.service.issue(Buffer.from("png"))).toBeNull();
  });
  it.each([
    null,
    {},
    { ...request, securityId: "invalid" },
    { ...request, priceDate: "2026-02-30" },
    { ...request, price: NaN },
    { ...request, price: 0 },
  ])("refuses invalid restored data %#", async (value) => {
    expect(priceChartRequest(value)).toBeUndefined();
    const s = setup();
    expect(await s.service.render("owner", value as any)).toBeNull();
    expect(s.manager.query).not.toHaveBeenCalled();
  });
});
