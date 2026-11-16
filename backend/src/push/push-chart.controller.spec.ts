import { NotFoundException } from "@nestjs/common";
import { PushChartController } from "./push-chart.controller";
describe("push chart endpoint", () => {
  const consume = jest.fn();
  const controller = new PushChartController({ consume } as any);
  const response = () => ({
    setHeader: jest.fn(),
    status: jest.fn().mockReturnThis(),
    end: jest.fn(),
    type: jest.fn(),
    send: jest.fn(),
  });
  beforeEach(() => consume.mockReset());
  it("returns non-cacheable PNG", async () => {
    const png = Buffer.from("png"),
      res = response();
    consume.mockResolvedValue(png);
    const returned = await controller.get(
      "token",
      { method: "GET" },
      res as any,
    );
    // A @Res() handler returns nothing: the value would reach the global
    // ClassSerializerInterceptor, which cannot be handed a live response.
    expect(returned).toBeUndefined();
    expect(res.setHeader).toHaveBeenCalledWith(
      "Cache-Control",
      "no-store, private",
    );
    expect(res.type).toHaveBeenCalledWith("image/png");
    expect(res.send).toHaveBeenCalledWith(png);
  });
  it("does not consume a token on HEAD", async () => {
    const res = response();
    const returned = await controller.get(
      "token",
      { method: "HEAD" },
      res as any,
    );
    expect(returned).toBeUndefined();
    expect(consume).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(405);
  });
  it("returns the same 404 for an invalid, expired or consumed token", async () => {
    consume.mockResolvedValue(null);
    await expect(
      controller.get("token", { method: "GET" }, response() as any),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
