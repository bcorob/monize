import { NotificationReminderController } from "./notification-reminder.controller";
import { ReminderRepeatMode } from "./entities/notification-reminder.entity";

describe("NotificationReminderController", () => {
  const reminders = {
    create: jest.fn(),
    list: jest.fn(),
    stop: jest.fn(),
  };
  const controller = new NotificationReminderController(reminders as never);
  const req = { user: { id: "u1" } };

  afterEach(() => jest.clearAllMocks());

  it("creates a reminder keyed on the JWT user", () => {
    const dto = {
      sourceNotificationId: "src-1",
      repeatMode: ReminderRepeatMode.REPEAT,
      intervalMinutes: 15,
    };
    controller.create(req, dto);
    expect(reminders.create).toHaveBeenCalledWith("u1", dto);
  });

  it("lists the caller's own reminders", () => {
    reminders.list.mockReturnValue(["r"]);
    expect(controller.list(req)).toEqual(["r"]);
    expect(reminders.list).toHaveBeenCalledWith("u1");
  });

  it("stops a reminder keyed on the JWT user", () => {
    controller.stop(req, "rem-1");
    expect(reminders.stop).toHaveBeenCalledWith("u1", "rem-1");
  });
});
