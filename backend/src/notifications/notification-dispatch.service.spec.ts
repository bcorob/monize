import { readFileSync } from "fs";
import { decode } from "he";
import { join } from "path";

import {
  NotificationDispatchService,
  PUSH_CATEGORY_COPY,
} from "./notification-dispatch.service";
import {
  Notification,
  NotificationCategory,
  NotificationSeverity,
  NotificationType,
} from "../notification-center/entities/notification.entity";
import { User } from "../users/entities/user.entity";
import * as scopedDb from "../common/db/scoped-db";

jest.mock("../common/db/scoped-db");

describe("NotificationDispatchService", () => {
  let service: NotificationDispatchService;
  let create: jest.Mock;
  let resolveDelivery: jest.Mock;
  let sendToUser: jest.Mock;
  let translate: jest.Mock;
  let sendMail: jest.Mock;
  let getStatus: jest.Mock;
  let query: jest.Mock;
  let userRepo: Record<string, jest.Mock>;
  let prefRepo: Record<string, jest.Mock>;

  const row = (over: Partial<Notification> = {}): Notification =>
    ({
      id: "n1",
      userId: "u1",
      type: NotificationType.OVER_BUDGET, // -> BUDGETS
      severity: NotificationSeverity.WARNING,
      title: "Groceries over budget",
      message: "You have spent 105% of Groceries.",
      target: "/budgets/b1",
      data: {},
      dedupeKey: null,
      createdAt: new Date("2026-09-02T10:00:00Z"),
      ...over,
    }) as Notification;

  beforeEach(() => {
    create = jest.fn().mockResolvedValue(row());
    resolveDelivery = jest.fn().mockResolvedValue({
      emailNotification: false,
      push: false,
      unifiedpush: false,
      throttleMinutes: 0,
    });
    sendToUser = jest.fn().mockResolvedValue({ attempted: 1, delivered: 1 });
    sendMail = jest.fn().mockResolvedValue(undefined);
    getStatus = jest.fn().mockReturnValue({ configured: true });
    query = jest.fn().mockResolvedValue([{ suppress: false }]);
    userRepo = {
      findOne: jest.fn().mockResolvedValue({ email: "u1@example.com" }),
    };
    prefRepo = { findOne: jest.fn().mockResolvedValue({ language: "en" }) };
    translate = jest.fn(
      (_k: string, o?: { defaultValue?: string }) => o?.defaultValue,
    );

    const manager = {
      query,
      getRepository: (entity: unknown) =>
        entity === User ? userRepo : (prefRepo as unknown),
    };
    (scopedDb.withScopedDb as jest.Mock).mockImplementation(
      (_ds: unknown, fn: (m: unknown) => unknown) => fn(manager),
    );

    service = new NotificationDispatchService(
      {} as never,
      { create } as never,
      { resolveNotificationDelivery: resolveDelivery } as never,
      { sendToUser } as never,
      { getStatus, sendMail } as never,
      { get: (_k: string, d: string) => d } as never,
      { translate } as never,
    );
  });

  it.each([false, true])(
    "localizes immediate email and reminder re-emits in the recipient locale (%s)",
    async (reminder) => {
      resolveDelivery.mockResolvedValue({
        emailNotification: true,
        push: false,
        unifiedpush: false,
        throttleMinutes: 0,
      });
      prefRepo.findOne.mockResolvedValue({ language: "pl" });
      const stored = row({
        type: NotificationType.BALANCE_BELOW_THRESHOLD,
        data: {
          accountName: "Current",
          balance: -25,
          threshold: 0,
          currencyCode: "PLN",
          ...(reminder ? { reminderId: "rem-1" } : {}),
        },
      });
      create.mockResolvedValue(stored);
      translate.mockImplementation(
        (
          key: string,
          options: {
            lang: string;
            defaultValue: string;
            args?: Record<string, unknown>;
          },
        ) => {
          if (key === "emails.notificationCopy.balanceThreshold.titleLow")
            return `Saldo: ${options.args?.account}`;
          if (key === "emails.notificationCopy.balanceThreshold.messageLow")
            return `Poniżej progu: ${options.args?.balance}`;
          return options.defaultValue;
        },
      );
      await service.notify("u1", {} as never);
      const html = decode(sendMail.mock.calls[0][2]);
      expect(html).toContain("Saldo: Current");
      expect(html).toContain("Poniżej progu: -25,00");
      expect(html).not.toContain(stored.title);
      expect(stored.title).toBe("Groceries over budget");
      for (const [, options] of translate.mock.calls)
        expect(options.lang).toBe("pl");
    },
  );

  it("formats the email's figures by the recipient's numberFormat, not their language", async () => {
    // The two preferences are independent (INV-DISPLAY-001): an English UI with
    // Polish grouping is a supported choice. The test above proves only that
    // `language` travels -- with the two AGREEING, dropping the number
    // preference anywhere between the preferences read and the composer still
    // renders Polish. Here they disagree, so this is the case that fails if
    // `resolveUserEmailFormats` stops reporting `numberFormat`, or if
    // `sendEmail` stops passing it on.
    resolveDelivery.mockResolvedValue({
      emailNotification: true,
      push: false,
      unifiedpush: false,
      throttleMinutes: 0,
    });
    prefRepo.findOne.mockResolvedValue({
      language: "en",
      numberFormat: "pl-PL",
    });
    create.mockResolvedValue(
      row({
        type: NotificationType.BALANCE_BELOW_THRESHOLD,
        data: {
          accountName: "Current",
          balance: -25,
          threshold: 0,
          currencyCode: "PLN",
        },
      }),
    );
    await service.notify("u1", {} as never);
    const html = decode(sendMail.mock.calls[0][2]);
    // English prose around a Polish figure is the point, not an accident.
    expect(html).toContain("dropped to");
    expect(html).toContain("-25,00");
    expect(html).not.toContain("-25.00");
  });

  it("passes validated price facts to chart delivery only for price alerts", async () => {
    const data = {
      securityId: "11111111-1111-4111-8111-111111111111",
      priceDate: "2026-09-02",
      price: 110,
    };
    create.mockResolvedValue(
      row({ type: NotificationType.SECURITY_PRICE_MOVEMENT, data }),
    );
    resolveDelivery.mockResolvedValue({
      push: true,
      unifiedpush: false,
      emailNotification: false,
      throttleMinutes: 0,
    });
    await service.notify("u1", {
      type: NotificationType.SECURITY_PRICE_MOVEMENT,
      severity: NotificationSeverity.INFO,
      title: "Price",
      message: "Changed",
    });
    expect(sendToUser.mock.calls[0][3]).toEqual(data);
  });

  it("writes through the one write door and returns the row (INV-DISPATCH-001)", async () => {
    const result = await service.notify("u1", {
      type: NotificationType.OVER_BUDGET,
    } as never);
    expect(create).toHaveBeenCalledWith("u1", {
      type: NotificationType.OVER_BUDGET,
    });
    expect(result?.id).toBe("n1");
  });

  it("does not fan out when create lost the conflict race (null)", async () => {
    create.mockResolvedValue(null);
    expect(await service.notify("u1", {} as never)).toBeNull();
    expect(sendToUser).not.toHaveBeenCalled();
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("always writes the in-app row even with push and email both off (INV-DISPATCH-002)", async () => {
    resolveDelivery.mockResolvedValue({
      emailNotification: false,
      push: false,
      throttleMinutes: 0,
    });
    await service.notify("u1", {} as never);
    expect(create).toHaveBeenCalled();
    expect(sendToUser).not.toHaveBeenCalled();
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("pushes a privacy-minimal payload to web-push devices when push is on", async () => {
    resolveDelivery.mockResolvedValue({
      emailNotification: false,
      push: true,
      unifiedpush: false,
      throttleMinutes: 0,
    });
    await service.notify("u1", {} as never);
    expect(sendToUser).toHaveBeenCalledTimes(1);
    const [userId, payload, transports] = sendToUser.mock.calls[0];
    expect(userId).toBe("u1");
    expect(payload).toEqual({
      type: NotificationType.OVER_BUDGET,
      // The category's copy, never the row's: "Groceries over budget" and the
      // 105% stay in the app. The wire is encrypted; the lock screen is not.
      title: PUSH_CATEGORY_COPY.BUDGETS.title,
      body: PUSH_CATEGORY_COPY.BUDGETS.body,
      target: "/budgets/b1",
      // no dedupeKey -> the row id, never a name/amount.
      collapseKey: "n1",
    });
    expect(JSON.stringify(payload)).not.toContain("Groceries");
    expect(JSON.stringify(payload)).not.toContain("105");
    // push on, unifiedpush off -> web-push devices only.
    expect(transports).toEqual(["webpush"]);
  });

  it("reads no users row for a push-only fan-out (the address is the email channel's need)", async () => {
    resolveDelivery.mockResolvedValue({
      emailNotification: false,
      push: true,
      unifiedpush: false,
      throttleMinutes: 0,
    });
    await service.notify("u1", {} as never);
    expect(sendToUser).toHaveBeenCalledTimes(1);
    expect(prefRepo.findOne).toHaveBeenCalledTimes(1); // the locale
    expect(userRepo.findOne).not.toHaveBeenCalled();
  });

  it("renders the push copy in the recipient's stored language, resolved once with the email's", async () => {
    resolveDelivery.mockResolvedValue({
      emailNotification: true,
      push: true,
      unifiedpush: false,
      throttleMinutes: 0,
    });
    prefRepo.findOne.mockResolvedValue({ language: "pl" });
    await service.notify("u1", {} as never);
    const pushCalls = translate.mock.calls.filter(([key]) =>
      String(key).startsWith("push.notification."),
    );
    expect(pushCalls.map(([key]) => key)).toEqual([
      "push.notification.budgets.title",
      "push.notification.budgets.body",
    ]);
    for (const [, options] of pushCalls) {
      expect(options).toMatchObject({ lang: "pl" });
    }
    // One recipient read serves both channels: the email frame and the push
    // body cannot disagree about the reader's language.
    expect(prefRepo.findOne).toHaveBeenCalledTimes(1);
    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  it("keeps the en catalogue equal to the English fallbacks, for every category", () => {
    // `emailTranslator` returns the fallback when a key is missing, so a typo in
    // the catalogue would ship English to every locale and no test would notice
    // -- unless the two are held equal here.
    const catalogue = JSON.parse(
      readFileSync(
        join(__dirname, "..", "i18n", "locales", "en", "push.json"),
        "utf8",
      ),
    ) as { notification: Record<string, { title: string; body: string }> };
    for (const category of Object.values(NotificationCategory)) {
      expect(catalogue.notification[category.toLowerCase()]).toEqual(
        PUSH_CATEGORY_COPY[category],
      );
    }
    expect(Object.keys(catalogue.notification).sort()).toEqual(
      Object.values(NotificationCategory)
        .map((c) => c.toLowerCase())
        .sort(),
    );
  });

  describe("push transports (INV-PUSH-007)", () => {
    // The two push channels ride one wire and differ only by which devices they
    // reach, so the fan-out is one call carrying the enabled transport set.
    const deliver = (push: boolean, unifiedpush: boolean) =>
      resolveDelivery.mockResolvedValue({
        emailNotification: false,
        push,
        unifiedpush,
        throttleMinutes: 0,
      });

    it("push on, unifiedpush off -> web-push devices only", async () => {
      deliver(true, false);
      await service.notify("u1", {} as never);
      expect(sendToUser).toHaveBeenCalledTimes(1);
      expect(sendToUser.mock.calls[0][2]).toEqual(["webpush"]);
    });

    it("push off, unifiedpush on -> UnifiedPush devices only", async () => {
      deliver(false, true);
      await service.notify("u1", {} as never);
      expect(sendToUser).toHaveBeenCalledTimes(1);
      expect(sendToUser.mock.calls[0][2]).toEqual(["unifiedpush"]);
    });

    it("both on -> both wires in one fan-out", async () => {
      deliver(true, true);
      await service.notify("u1", {} as never);
      expect(sendToUser).toHaveBeenCalledTimes(1);
      expect(sendToUser.mock.calls[0][2]).toEqual(["webpush", "unifiedpush"]);
    });

    it("both off (email off too) -> no fan-out", async () => {
      deliver(false, false);
      await service.notify("u1", {} as never);
      expect(sendToUser).not.toHaveBeenCalled();
    });
  });

  it("resolves delivery against the row's own category (SCHEDULED_POST_FAILED is PAYMENTS)", async () => {
    // A scheduled-post failure is about a scheduled payment, so it shares the
    // PAYMENTS row -- the matrix decision must be read for PAYMENTS, not SYSTEM.
    create.mockResolvedValue(
      row({
        type: NotificationType.SCHEDULED_POST_FAILED,
        dedupeKey: "SCHEDULED_POST_FAILED:st-1:2026-09-02",
      }),
    );
    resolveDelivery.mockResolvedValue({
      emailNotification: false,
      push: true,
      throttleMinutes: 0,
    });
    // The category is derived from the INPUT's type (it is what the row is
    // written with), before the write, so the D7 lock can be keyed on it.
    await service.notify("u1", {
      type: NotificationType.SCHEDULED_POST_FAILED,
    } as never);
    expect(resolveDelivery).toHaveBeenCalledWith(
      "u1",
      NotificationCategory.PAYMENTS,
    );
    expect(sendToUser).toHaveBeenCalledTimes(1);
  });

  it("runs the caller's onWritten follow-up AFTER the throttle decision, in the same transaction", async () => {
    // The reminder cron dismisses the previous nag in the hook, and a dismissed
    // row is not a prior -- so a hook that ran first would exempt every repeat
    // from its own predecessor. The decision reads the live rows first.
    resolveDelivery.mockResolvedValue({
      emailNotification: false,
      push: true,
      unifiedpush: false,
      throttleMinutes: 15,
    });
    const order: string[] = [];
    query.mockImplementation(async (sql: string) => {
      order.push(
        String(sql).includes("pg_advisory_xact_lock") ? "lock" : "decide",
      );
      return [{ suppress: false }];
    });
    create.mockImplementation(async () => {
      order.push("create");
      return row();
    });
    const onWritten = jest.fn(async () => {
      order.push("onWritten");
    });
    await service.notify("u1", {} as never, { onWritten });
    expect(order).toEqual(["lock", "create", "decide", "onWritten"]);
    expect(onWritten).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: "n1" }),
    );
  });

  it("never runs onWritten when the write door refused the row", async () => {
    create.mockResolvedValue(null);
    const onWritten = jest.fn();
    await expect(
      service.notify("u1", {} as never, { onWritten }),
    ).resolves.toBeNull();
    expect(onWritten).not.toHaveBeenCalled();
  });

  it("excludes its own row by id, never by created_at ordering (D7 across replicas)", async () => {
    // created_at is the transaction's BEGIN time, and the later lock-holder can
    // have begun earlier, so `created_at < mine` let both replicas send.
    resolveDelivery.mockResolvedValue({
      emailNotification: false,
      push: true,
      unifiedpush: false,
      throttleMinutes: 15,
    });
    await service.notify("u1", {} as never);
    const existsCall = query.mock.calls.find((c) =>
      String(c[0]).includes("SELECT EXISTS"),
    );
    expect(String(existsCall?.[0])).toContain("id <> $4");
    expect(String(existsCall?.[0])).not.toContain("created_at <");
    expect(existsCall?.[1]?.[3]).toBe("n1");
  });

  it("collapses a re-emitted nag onto its REMINDER and carries the Stop action (R4)", async () => {
    resolveDelivery.mockResolvedValue({
      emailNotification: false,
      push: true,
      unifiedpush: false,
      throttleMinutes: 0,
    });
    create.mockResolvedValue(
      row({
        dedupeKey: "BILL_DUE:rem:rem-1:7",
        data: { billId: "b1", reminderId: "rem-1" },
      }),
    );
    await service.notify("u1", {} as never);
    const payload = sendToUser.mock.calls[0][1];
    // The per-fire dedupe key differs every fire; a phone left overnight must
    // show one nag for this reminder, not a hundred stacked.
    expect(payload.collapseKey).toBe("rem:rem-1");
    expect(payload.reminderId).toBe("rem-1");
    expect(payload.actions).toEqual([
      { action: "stop-reminder", title: "Stop reminders" },
    ]);
  });

  it("carries no actions and no reminder id on an ordinary notification", async () => {
    resolveDelivery.mockResolvedValue({
      emailNotification: false,
      push: true,
      unifiedpush: false,
      throttleMinutes: 0,
    });
    await service.notify("u1", {} as never);
    const payload = sendToUser.mock.calls[0][1];
    expect(payload.reminderId).toBeUndefined();
    expect(payload.actions).toBeUndefined();
  });

  it("lets the producer name the collapse key (the admin fan-out's cause key)", async () => {
    resolveDelivery.mockResolvedValue({
      emailNotification: false,
      push: true,
      unifiedpush: false,
      throttleMinutes: 0,
    });
    create.mockResolvedValue(row({ dedupeKey: "BACKUP_FAILED:u7" }));
    await service.notify("u1", {} as never, {
      collapseKey: "BACKUP_FAILED:disk-full",
    });
    expect(sendToUser.mock.calls[0][1].collapseKey).toBe(
      "BACKUP_FAILED:disk-full",
    );
  });

  it("keeps a reminder's re-emit OUTSIDE the cooldown: no lock, no decision, always delivered", async () => {
    // A 15-minute reminder under a 30-minute cooldown would otherwise never
    // push: its source or its own previous nag is always a prior in the window,
    // which makes the interval a control that changes nothing.
    resolveDelivery.mockResolvedValue({
      emailNotification: false,
      push: true,
      unifiedpush: false,
      throttleMinutes: 30,
    });
    create.mockResolvedValue(row({ data: { reminderId: "rem-1" } }));
    await service.notify("u1", {
      type: NotificationType.OVER_BUDGET,
      data: { reminderId: "rem-1" },
    } as never);
    expect(query).not.toHaveBeenCalled();
    expect(sendToUser).toHaveBeenCalledTimes(1);
  });

  it("never counts a reminder's nag as a prior for other interruptions", async () => {
    resolveDelivery.mockResolvedValue({
      emailNotification: false,
      push: true,
      unifiedpush: false,
      throttleMinutes: 30,
    });
    await service.notify("u1", {} as never);
    const existsCall = query.mock.calls.find((c) =>
      String(c[0]).includes("SELECT EXISTS"),
    );
    expect(String(existsCall?.[0])).toContain(
      "COALESCE(data->>'reminderId', '') = ''",
    );
  });

  it("uses the dedupe key as the collapse key when present", async () => {
    create.mockResolvedValue(row({ dedupeKey: "PROVIDER_OUTAGE:yahoo" }));
    resolveDelivery.mockResolvedValue({
      emailNotification: false,
      push: true,
      throttleMinutes: 0,
    });
    await service.notify("u1", {} as never);
    expect(sendToUser.mock.calls[0][1].collapseKey).toBe(
      "PROVIDER_OUTAGE:yahoo",
    );
  });

  it("sends an immediate email in the recipient's locale when email is on", async () => {
    resolveDelivery.mockResolvedValue({
      emailNotification: true,
      push: false,
      throttleMinutes: 0,
    });
    await service.notify("u1", {} as never);
    expect(sendMail).toHaveBeenCalledTimes(1);
    const [to, , html] = sendMail.mock.calls[0];
    expect(to).toBe("u1@example.com");
    expect(html).toContain("Groceries over budget");
  });

  it("skips email when SMTP is not configured, without throwing", async () => {
    getStatus.mockReturnValue({ configured: false });
    resolveDelivery.mockResolvedValue({
      emailNotification: true,
      push: false,
      throttleMinutes: 0,
    });
    await expect(service.notify("u1", {} as never)).resolves.toBeTruthy();
    expect(sendMail).not.toHaveBeenCalled();
  });

  describe("throttle (INV-DISPATCH-003)", () => {
    it("suppresses the fan-out when the window says so", async () => {
      resolveDelivery.mockResolvedValue({
        emailNotification: false,
        push: true,
        throttleMinutes: 15,
      });
      query.mockResolvedValue([{ suppress: true }]);
      await service.notify("u1", {} as never);
      expect(sendToUser).not.toHaveBeenCalled();
    });

    it("does not throttle when the window is 0 (no throttle read)", async () => {
      resolveDelivery.mockResolvedValue({
        emailNotification: false,
        push: true,
        throttleMinutes: 0,
      });
      await service.notify("u1", {} as never);
      expect(query).not.toHaveBeenCalled();
      expect(sendToUser).toHaveBeenCalled();
    });

    it("takes the advisory lock on every throttled path, push included (D7)", async () => {
      // email path -> lock taken
      resolveDelivery.mockResolvedValue({
        emailNotification: true,
        push: false,
        throttleMinutes: 15,
      });
      await service.notify("u1", {} as never);
      expect(
        query.mock.calls.filter((c) =>
          String(c[0]).includes("pg_advisory_xact_lock"),
        ),
      ).toHaveLength(1);

      // push-only path -> lock ALSO taken: two replicas each winning a distinct
      // same-category row would not collapse device-side (distinct collapse
      // keys), so the decider is serialised here too.
      query.mockClear();
      resolveDelivery.mockResolvedValue({
        emailNotification: false,
        push: true,
        throttleMinutes: 15,
      });
      await service.notify("u1", {} as never);
      expect(
        query.mock.calls.filter((c) =>
          String(c[0]).includes("pg_advisory_xact_lock"),
        ),
      ).toHaveLength(1);
    });

    it("takes the lock BEFORE the row is written and decides AFTER it, in one transaction (D7)", async () => {
      // Taken after create() had committed, the lock serialised nothing: B could
      // commit and decide before A's row was visible, then A decided against
      // B's later created_at, and both sent. So the order is the claim.
      resolveDelivery.mockResolvedValue({
        emailNotification: false,
        push: true,
        throttleMinutes: 15,
      });
      const order: string[] = [];
      query.mockImplementation(async (sql: string) => {
        order.push(
          String(sql).includes("pg_advisory_xact_lock") ? "lock" : "decide",
        );
        return [{ suppress: false }];
      });
      create.mockImplementation(async () => {
        order.push("create");
        return row();
      });
      await service.notify("u1", {} as never);
      expect(order).toEqual(["lock", "create", "decide"]);
    });

    it("runs the caller's onWritten follow-up inside the write transaction, and never for a refused row", async () => {
      resolveDelivery.mockResolvedValue({
        emailNotification: false,
        push: false,
        unifiedpush: false,
        throttleMinutes: 0,
      });
      const onWritten = jest.fn().mockResolvedValue(undefined);
      const stored = row();
      create.mockResolvedValue(stored);
      await service.notify("u1", {} as never, { onWritten });
      expect(onWritten).toHaveBeenCalledTimes(1);
      const [manager, written] = onWritten.mock.calls[0];
      expect(written).toBe(stored);
      expect(manager).toHaveProperty("query");

      onWritten.mockClear();
      create.mockResolvedValue(null);
      await expect(
        service.notify("u1", {} as never, { onWritten }),
      ).resolves.toBeNull();
      expect(onWritten).not.toHaveBeenCalled();
    });

    it("passes the escalation set: only priors at or above this severity suppress", async () => {
      resolveDelivery.mockResolvedValue({
        emailNotification: false,
        push: true,
        throttleMinutes: 30,
      });
      create.mockResolvedValue(
        row({ severity: NotificationSeverity.CRITICAL }),
      );
      await service.notify("u1", {} as never);
      const existsCall = query.mock.calls.find((c) =>
        String(c[0]).includes("SELECT EXISTS"),
      );
      // A CRITICAL notification's "at or above" set is just [critical] -- a prior
      // WARNING must NOT suppress it (escalation always goes).
      expect(existsCall?.[1]?.[4]).toEqual(["critical"]);
    });
  });

  it("never lets a fan-out failure escape notify (INV-DISPATCH-004)", async () => {
    resolveDelivery.mockResolvedValue({
      emailNotification: false,
      push: true,
      throttleMinutes: 0,
    });
    sendToUser.mockRejectedValue(new Error("push exploded"));
    const spy = jest
      .spyOn(service["logger"], "error")
      .mockImplementation(() => undefined);
    await expect(service.notify("u1", {} as never)).resolves.toBeTruthy();
    expect(spy).toHaveBeenCalled();
  });

  describe("fanOut option (a read-path producer must not wait on a stalled push)", () => {
    const pushOn = () =>
      resolveDelivery.mockResolvedValue({
        emailNotification: false,
        push: true,
        unifiedpush: false,
        throttleMinutes: 0,
      });
    const flush = () => new Promise<void>((r) => setImmediate(r));

    it("awaits the fan-out by default, so a cron attempts its pushes before moving on", async () => {
      pushOn();
      let settle!: () => void;
      sendToUser.mockReturnValue(
        new Promise<void>((resolve) => {
          settle = () => resolve();
        }),
      );
      let resolved = false;
      const pending = service.notify("u1", {} as never).then((row) => {
        resolved = true;
        return row;
      });
      await flush();
      // The push was started and notify is still waiting on it.
      expect(sendToUser).toHaveBeenCalledTimes(1);
      expect(resolved).toBe(false);
      settle();
      await expect(pending).resolves.toEqual(
        expect.objectContaining({ id: "n1" }),
      );
    });

    it("detached: resolves with the committed row while the push is still in flight", async () => {
      pushOn();
      let settle!: () => void;
      sendToUser.mockReturnValue(
        new Promise<void>((resolve) => {
          settle = () => resolve();
        }),
      );
      const row = await service.notify("u1", {} as never, {
        fanOut: "detached",
      });
      // Resolved with the row before the push settled -- the caller's response
      // is not held by the delivery -- and the push is still started: the
      // fan-out's own reads (preferences, recipient locale) run on the
      // detached promise, so give the event loop one turn before looking.
      expect(row?.id).toBe("n1");
      await flush();
      expect(sendToUser).toHaveBeenCalledTimes(1);
      settle();
      await flush();
    });

    it("detached: a fan-out failure is still logged, never surfaced to the caller", async () => {
      pushOn();
      let fail!: (error: Error) => void;
      sendToUser.mockReturnValue(
        new Promise<void>((_resolve, reject) => {
          fail = reject;
        }),
      );
      const spy = jest
        .spyOn(service["logger"], "error")
        .mockImplementation(() => undefined);
      await expect(
        service.notify("u1", {} as never, { fanOut: "detached" }),
      ).resolves.toBeTruthy();
      fail(new Error("push stalled"));
      await flush();
      expect(spy).toHaveBeenCalledWith(
        "Fan-out failed for notification n1",
        expect.any(String),
      );
    });
  });
});
