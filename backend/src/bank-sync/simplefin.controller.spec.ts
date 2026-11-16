import "reflect-metadata";
import { GUARDS_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { ValidationPipe } from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { DEMO_RESTRICTED_KEY } from "../common/guards/demo-mode.guard";
import { SimplefinController } from "./simplefin.controller";
import { SimplefinSetupService } from "./simplefin-setup.service";
import {
  SimplefinDiscoveryService,
  type SimplefinDiscoveryView,
} from "./simplefin-discovery.service";
import { ConnectSimplefinDto } from "./dto/connect-simplefin.dto";

describe("SimpleFIN owner-only setup endpoints", () => {
  const setup: jest.Mocked<
    Pick<SimplefinSetupService, "connect" | "disconnect">
  > = {
    connect: jest.fn(),
    disconnect: jest.fn(),
  };
  const discovery: jest.Mocked<Pick<SimplefinDiscoveryService, "discover">> = {
    discover: jest.fn(),
  };
  const req = { user: { id: "jwt-owner" } } as Parameters<
    SimplefinController["discover"]
  >[0];
  const view: SimplefinDiscoveryView = {
    ok: true,
    reviewRequired: false,
    errors: [],
    connections: [],
  };
  const controller = () =>
    new SimplefinController(
      setup as unknown as SimplefinSetupService,
      discovery as unknown as SimplefinDiscoveryService,
    );
  beforeEach(() => {
    jest.resetAllMocks();
    setup.connect.mockResolvedValue(undefined);
    setup.disconnect.mockResolvedValue(undefined);
    discovery.discover.mockResolvedValue(view);
  });
  it("uses the JWT owner and saves before attempting discovery", async () => {
    expect(
      await controller().connect(req, {
        setupToken: "token",
        replaceExisting: true,
      }),
    ).toEqual({ credentialSet: true, discovery: view });
    expect(setup.connect).toHaveBeenCalledWith("jwt-owner", "token", true);
    expect(discovery.discover).toHaveBeenCalledWith("jwt-owner");
    expect(discovery.discover.mock.invocationCallOrder[0]).toBeGreaterThan(
      setup.connect.mock.invocationCallOrder[0],
    );
  });
  it("does not claim replacement confirmation by default", async () => {
    await controller().connect(req, { setupToken: "token" });
    expect(setup.connect).toHaveBeenCalledWith("jwt-owner", "token", false);
  });
  it("reports committed credentials separately from failed discovery", async () => {
    discovery.discover.mockRejectedValue(
      new Error("sensitive upstream payload"),
    );
    expect(await controller().connect(req, { setupToken: "token" })).toEqual({
      credentialSet: true,
      discovery: {
        ok: false,
        reviewRequired: true,
        errors: ["unavailable"],
        connections: [],
      },
    });
    expect(setup.connect).toHaveBeenCalledTimes(1);
  });
  it("does not discover after a failed claim", async () => {
    setup.connect.mockRejectedValue(new Error("claim failed"));
    await expect(
      controller().connect(req, { setupToken: "token" }),
    ).rejects.toThrow("claim failed");
    expect(discovery.discover).not.toHaveBeenCalled();
  });
  it("retries discovery without claiming or replacing a token", async () => {
    expect(await controller().discover(req)).toEqual(view);
    expect(setup.connect).not.toHaveBeenCalled();
  });
  it("removes local credentials under the shared setup lease", async () => {
    await controller().remove(req);
    expect(setup.disconnect).toHaveBeenCalledWith("jwt-owner");
  });
  it("requires JWT authentication and demo restrictions on every mutation", () => {
    expect(Reflect.getMetadata(PATH_METADATA, SimplefinController)).toBe(
      "bank-sync/simplefin",
    );
    expect(Reflect.getMetadata(GUARDS_METADATA, SimplefinController)).toContain(
      AuthGuard("jwt"),
    );
    for (const method of ["connect", "discover", "remove"] as const)
      expect(
        Reflect.getMetadata(
          DEMO_RESTRICTED_KEY,
          SimplefinController.prototype[method],
        ),
      ).toBe(true);
  });
  it.each([
    { setupToken: "x", userId: "injected-owner" },
    { setupToken: ["x"] },
    { setupToken: "x".repeat(16385) },
    { setupToken: "" },
    { setupToken: "x", replaceExisting: "true" },
    { setupToken: "x", replaceExisting: null },
  ])("refuses malformed or owner-injected setup body", async (body) => {
    const pipe = new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    await expect(
      pipe.transform(body, { type: "body", metatype: ConnectSimplefinDto }),
    ).rejects.toThrow();
  });
});
