import { ExecutionContext, ForbiddenException, Type } from "@nestjs/common";
import { PATH_METADATA } from "@nestjs/common/constants";
import { Reflector } from "@nestjs/core";
import { JwtService } from "@nestjs/jwt";
import { AccountDelegateGuard } from "../delegation/guards/account-delegate.guard";
import { NotificationController } from "./notification.controller";
import { NotificationPreferenceController } from "./notification-preference.controller";
import { NotificationReminderController } from "./notification-reminder.controller";
import { PushController } from "../push/push.controller";

// Use real route metadata, JWT verification and the production delegate guard.
// Enumerating controllers makes a newly added route part of this policy gate.
const controllers = [
  NotificationController,
  NotificationPreferenceController,
  NotificationReminderController,
  PushController,
];
const routes = controllers.flatMap((controller) =>
  Object.getOwnPropertyNames(controller.prototype)
    .filter(
      (name) =>
        name !== "constructor" &&
        Reflect.hasMetadata(PATH_METADATA, controller.prototype[name]),
    )
    .map((name) => ({ controller, name })),
);

describe("notification delegate policy", () => {
  const jwt = new JwtService({ secret: "notification-policy-test-secret" });
  const owner = "01111111-1111-4111-8111-111111111111";
  const actor = "d1111111-1111-4111-8111-111111111111";
  const delegationId = "a1111111-1111-4111-8111-111111111111";
  const hasSection = jest.fn();
  const guard = new AccountDelegateGuard(
    new Reflector(),
    jwt,
    { hasSection } as any,
    {} as any,
  );
  function context(
    controller: Type<any>,
    name: string,
    acting: boolean,
  ): ExecutionContext {
    const token = jwt.sign(
      acting
        ? { sub: actor, actingAsUserId: owner, delegationId }
        : { sub: owner },
    );
    return {
      getType: () => "http",
      getHandler: () => controller.prototype[name],
      getClass: () => controller,
      switchToHttp: () => ({
        getRequest: () => ({ cookies: { auth_token: token } }),
      }),
    } as ExecutionContext;
  }
  beforeEach(() => {
    hasSection.mockReset().mockResolvedValue(true);
  });

  it.each(routes)(
    "owner can reach $controller.name.$name",
    async ({ controller, name }) => {
      await expect(
        guard.canActivate(context(controller, name, false)),
      ).resolves.toBe(true);
    },
  );
  it.each(routes)(
    "delegate policy for $controller.name.$name",
    async ({ controller, name }) => {
      const result = guard.canActivate(context(controller, name, true));
      if (controller === NotificationController && name === "list") {
        await expect(result).resolves.toBe(true);
        expect(hasSection).toHaveBeenCalledWith(delegationId, "budgets");
      } else {
        await expect(result).rejects.toBeInstanceOf(ForbiddenException);
        expect(hasSection).not.toHaveBeenCalled();
      }
    },
  );
  it("refuses the feed without the Budgets grant", async () => {
    hasSection.mockResolvedValue(false);
    await expect(
      guard.canActivate(context(NotificationController, "list", true)),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
  it("discovers every current notification, reminder, preference and device route", () => {
    expect(routes).toHaveLength(18);
  });
});
