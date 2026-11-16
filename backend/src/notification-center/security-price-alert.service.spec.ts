import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { CreateSecurityDto } from "../securities/dto/create-security.dto";
import {
  SecurityPriceAlertService,
  priceMovement,
} from "./security-price-alert.service";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import { UserPreference } from "../users/entities/user-preference.entity";
import {
  NotificationType,
  NotificationCategory,
  notificationCategoryOf,
} from "./entities/notification.entity";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);
const today = "2026-09-07";
const prices = (
  latest: string | number = 110,
  previous: string | number = 100,
) => [
  { price_date: today, close_price: latest },
  { price_date: "2026-09-04", close_price: previous },
];
describe("security price movement", () => {
  it.each([
    [110, 10],
    [90, -10],
  ])("fires at the exact threshold in either direction", (price, expected) => {
    expect(priceMovement(prices(price), 10, today)).toBe(expected);
  });
  it("includes a decimal threshold boundary without admitting a meaningful shortfall", () => {
    expect(priceMovement(prices("100.1"), 0.1, today)).toBeCloseTo(0.1, 10);
    expect(priceMovement(prices("100.09999"), 0.1, today)).toBeNull();
  });
  it("compares stored decimal strings and skips a non-trading weekend", () => {
    expect(priceMovement(prices("110.00", "100.00"), 5, today)).toBe(10);
  });
  it.each([0, -1, Infinity, NaN])(
    "withholds invalid latest prices %s",
    (value) => {
      expect(priceMovement(prices(value), 5, today)).toBeNull();
      expect(priceMovement(prices(110, value), 5, today)).toBeNull();
    },
  );
  it.each([0, 0.01, 1001, NaN, Infinity])(
    "rejects invalid threshold %s",
    (value) => {
      expect(priceMovement(prices(), value, today)).toBeNull();
    },
  );
  it("withholds insufficient, stale, future and same-day comparisons", () => {
    expect(priceMovement([], 5, today)).toBeNull();
    expect(priceMovement(prices().slice(0, 1), 5, today)).toBeNull();
    expect(priceMovement(prices(), 5, "2026-09-08")).toBeNull();
    expect(priceMovement(prices(), 5, "2026-09-06")).toBeNull();
    expect(priceMovement([prices()[0], prices()[0]], 5, today)).toBeNull();
    expect(priceMovement(prices(101), 5, today)).toBeNull();
  });
  it("belongs to the existing Investments channel matrix", () => {
    expect(
      notificationCategoryOf(NotificationType.SECURITY_PRICE_MOVEMENT),
    ).toBe(NotificationCategory.INVESTMENTS);
  });
  it.each([null, undefined, 0.1, 1000, 5.5])(
    "accepts an opt-out or valid threshold %s",
    async (priceAlertPercent) => {
      const dto = plainToInstance(CreateSecurityDto, {
        symbol: "AAPL",
        name: "Apple",
        currencyCode: "USD",
        priceAlertPercent,
      });
      expect(
        (await validate(dto)).filter((e) => e.property === "priceAlertPercent"),
      ).toEqual([]);
    },
  );
  it.each(["5", 0, -5, 1001, NaN, Infinity])(
    "rejects invalid API configuration %s",
    async (priceAlertPercent) => {
      const dto = plainToInstance(CreateSecurityDto, { priceAlertPercent });
      expect(
        (await validate(dto)).some((e) => e.property === "priceAlertPercent"),
      ).toBe(true);
    },
  );

  it.each([0.12345, 2.00001, 12.123456])(
    "refuses a precision the column cannot hold (%s)",
    async (priceAlertPercent) => {
      // The column is NUMERIC(9,4) and `SecurityForm` renders it through
      // `NumericInput decimalPlaces={4}`, so anything finer is displayed
      // rounded and then committed at that rounding on the next blur -- a
      // threshold changed by a save the user made about another field.
      // PostgreSQL would round such a value in silently, so the DTO every
      // writer reaches is where it has to be refused.
      const dto = plainToInstance(CreateSecurityDto, { priceAlertPercent });
      expect(
        (await validate(dto)).some((e) => e.property === "priceAlertPercent"),
      ).toBe(true);
    },
  );

  it.each([0.1, 0.125, 5.0001, 12.3456, 1000])(
    "accepts a threshold the column and the form both hold exactly (%s)",
    async (priceAlertPercent) => {
      const dto = plainToInstance(CreateSecurityDto, { priceAlertPercent });
      expect(
        (await validate(dto)).filter((e) => e.property === "priceAlertPercent"),
      ).toEqual([]);
    },
  );
});

describe("security price alert producer", () => {
  const user = "11111111-1111-4111-8111-111111111111";
  const security = "22222222-2222-4222-8222-222222222222";
  const setup = (
    preferences: { numberFormat?: string; language?: string } | null = null,
  ) => {
    const prefsRepo = {
      findOne: jest.fn().mockResolvedValue(preferences),
    };
    const { dataSource, manager } = createScopedDbMocks([
      [UserPreference, prefsRepo],
    ]);
    const notify = jest.fn().mockResolvedValue({ id: "written" });
    const service = new SecurityPriceAlertService(
      dataSource as any,
      { notify } as any,
    );
    return { manager, notify, service, prefsRepo };
  };
  it("addresses the owner, persists facts and a security deep link, and uses stable per-day dedupe", async () => {
    const { manager, notify, service } = setup();
    manager.query
      .mockResolvedValueOnce([
        { symbol: "AAPL", currency_code: "USD", price_alert_percent: 5 },
      ])
      .mockResolvedValueOnce(prices());
    await service.evaluate(user, security, today);
    expect(manager.query.mock.calls[0][0]).toContain("user_id = $2");
    expect(manager.query.mock.calls[0][1]).toEqual([security, user]);
    expect(notify).toHaveBeenCalledWith(
      user,
      expect.objectContaining({
        type: NotificationType.SECURITY_PRICE_MOVEMENT,
        target: `/securities/${security}`,
        dedupeKey: `security-price:${security}:${today}`,
        data: expect.objectContaining({
          securityId: security,
          symbol: "AAPL",
          changePercent: 10,
          price: 110,
          previousPrice: 100,
        }),
      }),
      { collapseKey: `security-price:${security}` },
    );
  });
  it.each([
    [
      "an explicit numberFormat, over an English UI",
      { numberFormat: "pl-PL", language: "en" },
    ],
    [
      "the UI language when numberFormat follows the browser",
      { numberFormat: "browser", language: "pl" },
    ],
  ])(
    "writes the stored fallback percentage in the recipient's own convention: %s",
    async (_case, preferences) => {
      // Issue #1316: `title`/`message` here are the English fallback, and
      // `notificationEmailCopy` renders exactly that pair into an email for a
      // row it cannot rebuild -- so the figure inside it is the recipient's to
      // read. Polish writes it `10,00%`; `toFixed(2)` wrote `10.00`.
      const { manager, notify, service } = setup(preferences);
      manager.query
        .mockResolvedValueOnce([
          { symbol: "AAPL", currency_code: "USD", price_alert_percent: 5 },
        ])
        .mockResolvedValueOnce(prices());
      await service.evaluate(user, security, today);
      const written = notify.mock.calls[0][1];
      expect(written.title).toContain("10,00");
      expect(written.title).not.toContain("10.00");
      expect(written.message).toContain("10,00");
      // The structured fact is untouched: the client composes from `data`, and
      // a localized string there would be unreadable to it.
      expect(written.data.changePercent).toBe(10);
    },
  );

  it("falls back to the deterministic default when the recipient has no preferences row", async () => {
    // A user who has never opened Settings is not a reason to withhold or guess:
    // `numberFormatterFor` lands on DEFAULT_LOCALE, which writes `10.00%`.
    const { manager, notify, service } = setup(null);
    manager.query
      .mockResolvedValueOnce([
        { symbol: "AAPL", currency_code: "USD", price_alert_percent: 5 },
      ])
      .mockResolvedValueOnce(prices());
    await service.evaluate(user, security, today);
    expect(notify.mock.calls[0][1].title).toContain("10.00");
  });

  it("does nothing when the owner's active opt-in no longer exists", async () => {
    const { manager, notify, service } = setup();
    manager.query.mockResolvedValueOnce([]);
    await service.evaluate(user, security, today);
    expect(manager.query).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();
  });
  it("does not send for an incomplete price pair", async () => {
    const { manager, notify, service } = setup();
    manager.query
      .mockResolvedValueOnce([{ price_alert_percent: 5 }])
      .mockResolvedValueOnce([]);
    await service.evaluate(user, security, today);
    expect(notify).not.toHaveBeenCalled();
  });
  it("scans with keyset pagination and evaluates each security in its owner's context", async () => {
    const { manager, service } = setup();
    manager.query
      .mockResolvedValueOnce([{ id: security, user_id: user }])
      .mockResolvedValueOnce([]);
    const evaluate = jest.spyOn(service, "evaluate").mockResolvedValue();
    await service.run();
    expect(evaluate).toHaveBeenCalledWith(
      user,
      security,
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    );
    expect(manager.query.mock.calls[1][1]).toEqual([security]);
  });
});
