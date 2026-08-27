import { ValidationArguments } from "class-validator";
import {
  IsCalendarDateConstraint,
  IsDateWithinHorizonConstraint,
  isCalendarDate,
} from "./is-calendar-date.validator";

const args = (property: string, constraints: unknown[] = []) =>
  ({ property, constraints }) as unknown as ValidationArguments;

const ymdFromNow = (days: number): string => {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

describe("isCalendarDate", () => {
  it("accepts a real day", () => {
    expect(isCalendarDate("2026-08-26")).toBe(true);
    // A leap day that exists.
    expect(isCalendarDate("2024-02-29")).toBe(true);
  });

  it("rejects a well-shaped day that does not exist", () => {
    // The round trip is the point: `new Date("2026-02-30")` rolls forward to
    // March 2nd rather than failing, and `9999-99-99` reached Postgres as a date
    // literal and became a 500.
    expect(isCalendarDate("2026-02-30")).toBe(false);
    expect(isCalendarDate("2023-02-29")).toBe(false);
    expect(isCalendarDate("2026-13-01")).toBe(false);
    expect(isCalendarDate("9999-99-99")).toBe(false);
  });

  it("rejects anything that is not a bare YYYY-MM-DD string", () => {
    expect(isCalendarDate("2026-8-26")).toBe(false);
    expect(isCalendarDate("2026-08-26T00:00:00Z")).toBe(false);
    expect(isCalendarDate("")).toBe(false);
    expect(isCalendarDate(undefined)).toBe(false);
    expect(isCalendarDate(20260826)).toBe(false);
  });
});

describe("IsCalendarDateConstraint", () => {
  const constraint = new IsCalendarDateConstraint();

  it("delegates to the predicate", () => {
    expect(constraint.validate("2026-08-26", args("through"))).toBe(true);
    expect(constraint.validate("2026-02-30", args("through"))).toBe(false);
  });

  it("names the property in its message", () => {
    expect(constraint.defaultMessage(args("through"))).toContain("through");
  });
});

describe("IsDateWithinHorizonConstraint", () => {
  const constraint = new IsDateWithinHorizonConstraint();

  it("accepts a date inside the horizon, including a past one", () => {
    expect(constraint.validate(ymdFromNow(10), args("through", [30]))).toBe(
      true,
    );
    expect(constraint.validate(ymdFromNow(-100), args("through", [30]))).toBe(
      true,
    );
    expect(constraint.validate(ymdFromNow(30), args("through", [30]))).toBe(
      true,
    );
  });

  it("rejects a date past the horizon", () => {
    expect(constraint.validate(ymdFromNow(31), args("through", [30]))).toBe(
      false,
    );
    expect(constraint.validate("9999-12-31", args("through", [30]))).toBe(
      false,
    );
  });

  it("rejects a non-date without claiming it is out of range", () => {
    expect(constraint.validate("2026-02-30", args("through", [30]))).toBe(
      false,
    );
    expect(constraint.defaultMessage(args("through", [30]))).toContain("30");
  });
});
