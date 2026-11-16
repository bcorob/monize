import { NotificationReminderService } from "./notification-reminder.service";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";

/**
 * RLS smoke for the reminder CRUD (task C4). The firing cron moved to
 * `notifications/notification-reminder-cron.service.ts` and has its own smoke
 * spec beside it; what stays here is the request-path half, which inherits the
 * interceptor's context in production and so must be refused without one.
 */
describe("notification-center reminder RLS context smoke (real withScopedDb)", () => {
  it("real withScopedDb still refuses the request-path methods without a context wrapper", async () => {
    const { dataSource } = createScopedDbMocks();
    const service = new NotificationReminderService(
      dataSource as never,
      { create: jest.fn() } as never,
    );
    // list() has no context wrapper of its own -- it inherits the request
    // interceptor's context in production -- so with none seeded here, the real
    // withScopedDb refuses it.
    await expect(service.list("u1")).rejects.toThrow();
  });
});
