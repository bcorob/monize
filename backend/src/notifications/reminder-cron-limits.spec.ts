import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  REMINDER_CRON_LIMIT_SPECS,
  resolveReminderCronLimits,
} from "./reminder-cron-limits";

const logger = () => ({ warn: jest.fn() });

describe("reminder cron limits", () => {
  it("keeps existing defaults when unset", () => {
    const log = logger();
    expect(resolveReminderCronLimits({}, log)).toEqual({
      claimBatch: 100,
      reemitConcurrency: 5,
    });
    expect(log.warn).not.toHaveBeenCalled();
  });

  describe.each(Object.entries(REMINDER_CRON_LIMIT_SPECS))(
    "%s",
    (key, spec) => {
      it.each(["1", "2"])("honors override %s", (raw) => {
        expect(
          resolveReminderCronLimits({ [spec.envVar]: raw }, logger())[
            key as keyof typeof REMINDER_CRON_LIMIT_SPECS
          ],
        ).toBe(Number(raw));
      });
      it("accepts the upper bound", () => {
        expect(
          resolveReminderCronLimits(
            { [spec.envVar]: String(spec.max) },
            logger(),
          )[key as keyof typeof REMINDER_CRON_LIMIT_SPECS],
        ).toBe(spec.max);
      });
      it.each([
        "0",
        "-1",
        "1.5",
        "bad",
        "Infinity",
        "99999999999999999999",
        true,
      ])("rejects invalid override %s", (raw) => {
        const log = logger();
        expect(
          resolveReminderCronLimits({ [spec.envVar]: raw }, log)[
            key as keyof typeof REMINDER_CRON_LIMIT_SPECS
          ],
        ).toBe(spec.default);
        expect(log.warn).toHaveBeenCalledWith(
          expect.stringContaining(spec.envVar),
        );
      });
      it("falls back when above the cap", () => {
        const log = logger();
        expect(
          resolveReminderCronLimits({ [spec.envVar]: spec.max + 1 }, log)[
            key as keyof typeof REMINDER_CRON_LIMIT_SPECS
          ],
        ).toBe(spec.default);
        expect(log.warn).toHaveBeenCalled();
      });
    },
  );

  it("documents every knob and current default, with no stale knobs", () => {
    const text = readFileSync(join(__dirname, "../../../.env.example"), "utf8");
    const documented = [
      ...text.matchAll(/^# (NOTIFICATION_REMINDER_\w+)=(\d+)$/gm),
    ].map(([, name, value]) => [name, Number(value)]);
    expect(Object.fromEntries(documented)).toEqual(
      Object.fromEntries(
        Object.values(REMINDER_CRON_LIMIT_SPECS).map((spec) => [
          spec.envVar,
          spec.default,
        ]),
      ),
    );
  });
  it.each(["docker-compose.dev.yml", "docker-compose.prod.yml"])(
    "forwards every knob into the backend in %s",
    (file) => {
      const source = readFileSync(join(__dirname, "../../..", file), "utf8");
      for (const { envVar } of Object.values(REMINDER_CRON_LIMIT_SPECS)) {
        expect(source).toContain(`${envVar}: ` + "${" + envVar + ":-}");
      }
    },
  );
});
