import { Reflector } from "@nestjs/core";
import { AuthGuard } from "@nestjs/passport";
import { Test, TestingModule } from "@nestjs/testing";
import { DEMO_RESTRICTED_KEY } from "../common/guards/demo-mode.guard";
import { ROLES_KEY } from "../auth/guards/roles.guard";
import { PushController } from "./push.controller";
import { AdminNotificationsController } from "./admin-notifications.controller";
import { PushConfigService } from "./push-config.service";
import { PushSubscriptionService } from "./push-subscription.service";

/**
 * A request as `subscribe` reads it: the JWT's user, plus the socket the
 * address is derived from. Typed through the controller's own parameter so a
 * fixture cannot claim a shape Express never produces.
 */
type PushRequest = Parameters<PushController["subscribe"]>[0];

function caller(ip?: string | null): PushRequest {
  return {
    user: { id: "user-1" },
    ip: ip ?? undefined,
    socket: {},
  } as unknown as PushRequest;
}

const CALLER = caller("203.0.113.7");

describe("PushController", () => {
  let controller: PushController;
  let pushConfig: Partial<Record<keyof PushConfigService, jest.Mock>>;
  let subscriptions: Partial<Record<keyof PushSubscriptionService, jest.Mock>>;

  beforeEach(async () => {
    pushConfig = { getPublicConfig: jest.fn() };
    subscriptions = {
      listForUser: jest.fn(),
      subscribe: jest.fn(),
      remove: jest.fn(),
      hold: jest.fn(),
      sendTest: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [PushController],
      providers: [
        { provide: PushConfigService, useValue: pushConfig },
        { provide: PushSubscriptionService, useValue: subscriptions },
      ],
    }).compile();

    controller = module.get(PushController);
  });

  // The acceptance criterion this pins (discussion #1291): a subscription
  // belongs to the authenticated caller. Every route below reads req.user.id,
  // and no route takes a user id from anywhere else.
  it.each([
    ["list", () => controller.list(CALLER), "listForUser"],
    ["test", () => controller.test(CALLER), "sendTest"],
  ] as const)(
    "derives the tenant from the JWT on %s",
    (_name, call, method) => {
      call();
      expect(subscriptions[method]).toHaveBeenCalledWith("user-1");
    },
  );

  it("passes the caller, the payload, the user agent and the client address to subscribe", () => {
    const dto = { endpoint: "https://x", p256dh: "a", auth: "b" } as never;

    controller.subscribe(CALLER, dto, "Mozilla/5.0");

    expect(subscriptions.subscribe).toHaveBeenCalledWith(
      "user-1",
      dto,
      "Mozilla/5.0",
      "203.0.113.7",
    );
  });

  it("passes a null user agent rather than undefined when the header is absent", () => {
    const dto = { endpoint: "https://x", p256dh: "a", auth: "b" } as never;

    controller.subscribe(CALLER, dto);

    expect(subscriptions.subscribe).toHaveBeenCalledWith(
      "user-1",
      dto,
      null,
      "203.0.113.7",
    );
  });

  // An address this server could not determine is unknown. Recording a
  // placeholder would put every such registration at one fictitious location
  // and make the column's whole point -- telling two endpoints apart -- a lie.
  it("passes a null address when the request resolves none", () => {
    const dto = { endpoint: "https://x", p256dh: "a", auth: "b" } as never;

    controller.subscribe(caller(null), dto, "Mozilla/5.0");

    expect(subscriptions.subscribe).toHaveBeenCalledWith(
      "user-1",
      dto,
      "Mozilla/5.0",
      null,
    );
  });

  it("scopes a device removal to the caller", () => {
    controller.remove(CALLER, "device-1");

    expect(subscriptions.remove).toHaveBeenCalledWith("user-1", "device-1");
  });

  it("scopes a device hold to the caller", () => {
    controller.hold(CALLER, "device-1");

    expect(subscriptions.hold).toHaveBeenCalledWith("user-1", "device-1");
  });

  it("guards every route with the JWT strategy", () => {
    const guards = new Reflector().get("__guards__", PushController) ?? [];
    const names = guards.map((g: unknown) => (g as { name?: string })?.name);

    expect(guards).toHaveLength(1);
    expect(names[0]).toBe(AuthGuard("jwt").name);
  });

  // Every demo visitor shares one account, so a subscription registered by one
  // visitor would receive the test notification another visitor triggered -- and
  // `remove` is on this list because it is a WRITE, not because it is expensive:
  // it was grouped with the reads and called "read-only", which a DELETE is not.
  // On one shared account a removal is a stranger deleting the row somebody else
  // is looking at.
  it.each(["subscribe", "test", "remove", "hold"] as const)(
    "restricts %s in demo mode",
    (method) => {
      expect(
        new Reflector().get(
          DEMO_RESTRICTED_KEY,
          PushController.prototype[method],
        ),
      ).toBe(true);
    },
  );

  it.each(["list", "getConfig"] as const)(
    "leaves the read-only route %s available in demo mode",
    (method) => {
      expect(
        new Reflector().get(
          DEMO_RESTRICTED_KEY,
          PushController.prototype[method],
        ),
      ).toBeUndefined();
    },
  );
});

describe("AdminNotificationsController", () => {
  let controller: AdminNotificationsController;
  let pushConfig: Partial<Record<keyof PushConfigService, jest.Mock>>;

  beforeEach(async () => {
    pushConfig = {
      getAdminConfig: jest.fn(),
      setWebPushEnabled: jest.fn(),
      rotateKeyPair: jest
        .fn()
        .mockResolvedValue({ config: { enabled: true }, disabled: 3 }),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AdminNotificationsController],
      providers: [{ provide: PushConfigService, useValue: pushConfig }],
    }).compile();

    controller = module.get(AdminNotificationsController);
  });

  it("requires the admin role for the whole controller", () => {
    expect(
      new Reflector().get(ROLES_KEY, AdminNotificationsController),
    ).toEqual(["admin"]);
  });

  // Not at class level, which is what it used to be: that 403s the channels GET
  // as well, and the nav links to that page unconditionally -- so a demo
  // administrator following it got a page rendering nothing but "we could not
  // check", for a request with no body that returns a key fingerprint and two
  // counts. The two writes carry it; the read must not.
  it.each(["updateChannels", "rotate"] as const)(
    "restricts %s in demo mode",
    (method) => {
      expect(
        new Reflector().get(
          DEMO_RESTRICTED_KEY,
          AdminNotificationsController.prototype[method],
        ),
      ).toBe(true);
    },
  );

  it("leaves the channel read reachable in demo mode", () => {
    expect(
      new Reflector().get(DEMO_RESTRICTED_KEY, AdminNotificationsController),
    ).toBeUndefined();
    expect(
      new Reflector().get(
        DEMO_RESTRICTED_KEY,
        AdminNotificationsController.prototype.getChannels,
      ),
    ).toBeUndefined();
  });

  it("switches the instance channel from the payload", async () => {
    await controller.updateChannels({ webPushEnabled: false });

    expect(pushConfig.setWebPushEnabled).toHaveBeenCalledWith(false);
  });

  // How many devices a rotation retired is part of the answer, not a log line:
  // every one of them has to subscribe again before it can be reached.
  it("reports how many devices a rotation retired", async () => {
    const result = await controller.rotate();

    expect(result).toEqual({
      config: { enabled: true },
      disabledSubscriptions: 3,
    });
  });

  // The administrator configures the instance and never reaches an account's
  // devices or notifications. A route that did would be a new leak, not a
  // feature, so the surface is pinned.
  it("exposes only instance-level routes", () => {
    const methods = Object.getOwnPropertyNames(
      AdminNotificationsController.prototype,
    ).filter((name) => name !== "constructor");

    expect(methods.sort()).toEqual(["getChannels", "rotate", "updateChannels"]);
  });
});
