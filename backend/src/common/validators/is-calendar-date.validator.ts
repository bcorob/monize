import {
  ValidatorConstraint,
  ValidatorConstraintInterface,
  ValidationArguments,
  registerDecorator,
  ValidationOptions,
} from "class-validator";

/**
 * A `YYYY-MM-DD` string that names a day that exists.
 *
 * `@Matches(/^\d{4}-\d{2}-\d{2}$/)` is a shape check, not a date check: it
 * accepts `9999-99-99` and `2026-02-30`, and a value that reaches Postgres as a
 * date literal then fails with "date/time field value out of range" -- a 500 for
 * what is plainly a client error. The round trip is what proves it: format the
 * parsed date back and require the same string, which also rejects a month or
 * day that JavaScript would otherwise roll forward (`2026-02-30` -> March 2nd).
 */
export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return false;
  return parsed.toISOString().slice(0, 10) === value;
}

@ValidatorConstraint({ name: "isCalendarDate", async: false })
export class IsCalendarDateConstraint implements ValidatorConstraintInterface {
  validate(value: unknown, _args: ValidationArguments): boolean {
    return isCalendarDate(value);
  }

  defaultMessage(args: ValidationArguments): string {
    return `${args.property} must be a real YYYY-MM-DD calendar date`;
  }
}

export function IsCalendarDate(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      target: object.constructor,
      propertyName,
      options: validationOptions,
      constraints: [],
      validator: IsCalendarDateConstraint,
    });
  };
}

/**
 * A calendar date no further ahead than `maxDaysAhead` from today.
 *
 * The horizon matters because the value is a *walk bound*: an unbounded `through`
 * walks every schedule to `OCCURRENCE_WALK_GUARD` and serializes up to
 * `maxPerSchedule` occurrences for each, so `through=9999-12-31` is a cheap
 * request that is expensive to answer.
 */
@ValidatorConstraint({ name: "isDateWithinHorizon", async: false })
export class IsDateWithinHorizonConstraint implements ValidatorConstraintInterface {
  validate(value: unknown, args: ValidationArguments): boolean {
    if (!isCalendarDate(value)) return false; // reported by IsCalendarDate
    const [maxDaysAhead] = args.constraints as [number];
    const limit = new Date();
    limit.setUTCHours(0, 0, 0, 0);
    limit.setUTCDate(limit.getUTCDate() + maxDaysAhead);
    return value <= limit.toISOString().slice(0, 10);
  }

  defaultMessage(args: ValidationArguments): string {
    const [maxDaysAhead] = args.constraints as [number];
    return `${args.property} must be no more than ${maxDaysAhead} days ahead of today`;
  }
}

export function IsDateWithinHorizon(
  maxDaysAhead: number,
  validationOptions?: ValidationOptions,
) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      target: object.constructor,
      propertyName,
      options: validationOptions,
      constraints: [maxDaysAhead],
      validator: IsDateWithinHorizonConstraint,
    });
  };
}
