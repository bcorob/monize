import { BadRequestException } from "@nestjs/common";

import { NotificationPreferenceController } from "./notification-preference.controller";
import { NotificationCategory } from "./entities/notification.entity";
import {
  configurableCategoriesFor,
  NOTIFICATION_PREFERENCE_CATEGORIES,
} from "./notification-preference.service";

describe("NotificationPreferenceController", () => {
  const preferences = { list: jest.fn(), updatePreference: jest.fn() };
  const controller = new NotificationPreferenceController(preferences as never);
  const req = { user: { id: "u1", role: "user" } };
  const adminReq = { user: { id: "a1", role: "admin" } };

  afterEach(() => jest.clearAllMocks());

  it("lists the caller's own preferences, without the SYSTEM row for a non-admin", () => {
    preferences.list.mockReturnValue(["x"]);
    expect(controller.list(req)).toEqual(["x"]);
    expect(preferences.list).toHaveBeenCalledWith(
      "u1",
      configurableCategoriesFor(false),
    );
    expect(preferences.list.mock.calls[0][1]).not.toContain(
      NotificationCategory.SYSTEM,
    );
  });

  it("lists every matrix row, SYSTEM included, for an admin", () => {
    controller.list(adminReq);
    expect(preferences.list).toHaveBeenCalledWith(
      "a1",
      NOTIFICATION_PREFERENCE_CATEGORIES,
    );
  });

  it("refuses a SYSTEM write from a non-admin -- a cell their matrix does not show", () => {
    expect(() =>
      controller.update(req, NotificationCategory.SYSTEM, { push: true }),
    ).toThrow(BadRequestException);
    expect(preferences.updatePreference).not.toHaveBeenCalled();
  });

  it("updates an exposed category, keyed on the JWT user", () => {
    controller.update(req, NotificationCategory.PAYMENTS, {
      email: false,
      emailNotification: true,
      push: true,
      throttleMinutes: 15,
    });
    expect(preferences.updatePreference).toHaveBeenCalledWith(
      "u1",
      NotificationCategory.PAYMENTS,
      {
        email: false,
        emailNotification: true,
        push: true,
        unifiedpush: undefined,
        throttleMinutes: 15,
      },
    );
  });

  it("passes a partial update through untouched (only the field sent)", () => {
    controller.update(req, NotificationCategory.BUDGETS, { email: false });
    expect(preferences.updatePreference).toHaveBeenCalledWith(
      "u1",
      NotificationCategory.BUDGETS,
      {
        email: false,
        emailNotification: undefined,
        push: undefined,
        unifiedpush: undefined,
        throttleMinutes: undefined,
      },
    );
  });

  it("updates the SYSTEM category (its push is a live control for admins)", () => {
    controller.update(adminReq, NotificationCategory.SYSTEM, { push: true });
    expect(preferences.updatePreference).toHaveBeenCalledWith(
      "a1",
      NotificationCategory.SYSTEM,
      {
        email: undefined,
        emailNotification: undefined,
        push: true,
        unifiedpush: undefined,
        throttleMinutes: undefined,
      },
    );
  });

  it("refuses a category the matrix does not expose", () => {
    // Every current enum member is exposed, so the defensive guard is exercised
    // with a value that could only reach it past the ParseEnumPipe -- a future
    // category added to the enum before it is wired into the matrix.
    expect(() =>
      controller.update(req, "GOALS" as NotificationCategory, { email: true }),
    ).toThrow(BadRequestException);
    expect(preferences.updatePreference).not.toHaveBeenCalled();
  });

  it("refuses an empty body rather than writing a default row", () => {
    expect(() =>
      controller.update(req, NotificationCategory.PAYMENTS, {}),
    ).toThrow(BadRequestException);
    expect(preferences.updatePreference).not.toHaveBeenCalled();
  });
});
