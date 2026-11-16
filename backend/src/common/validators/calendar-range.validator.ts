import {
  ValidatorConstraint,
  ValidatorConstraintInterface,
  ValidationArguments,
  registerDecorator,
  ValidationOptions,
} from "class-validator";

import { isCalendarDate } from "./is-calendar-date.validator";

/**
 * The widest date range a calendar read model will answer: three months plus a
 * couple of days, which is the most a month grid can span (a 31-day month whose
 * grid reaches into both neighbours) with room to spare.
 *
 * It is a work bound, not a display preference. Each of these endpoints walks a
 * per-day series across every account or holding in scope, so an unbounded range
 * is a cheap request that is expensive to answer -- and, for the projection
 * half, one that asks `BalanceForecastService` to expand every schedule to the
 * horizon. One constant, read by every calendar DTO, so the cap cannot drift
 * apart per endpoint.
 */
export const CALENDAR_RANGE_MAX_DAYS = 93;

/**
 * Inclusive whole days from `from` to `to`; 1 when they are the same day.
 * Both are calendar dates, so this is integer arithmetic on UTC midnights and
 * never crosses a daylight-saving boundary.
 */
export function calendarRangeDays(from: string, to: string): number {
  const span =
    (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) /
    86_400_000;
  return span + 1;
}

@ValidatorConstraint({ name: "isCalendarRangeEnd", async: false })
export class IsCalendarRangeEndConstraint implements ValidatorConstraintInterface {
  validate(value: unknown, args: ValidationArguments): boolean {
    // A bad shape is reported by the field's own IsCalendarDate; reporting it
    // twice would put two messages on one mistake.
    if (!isCalendarDate(value)) return false;
    const [startProperty, maxDays] = args.constraints as [string, number];
    const start = (args.object as Record<string, unknown>)[startProperty];
    if (!isCalendarDate(start)) return false;
    const days = calendarRangeDays(start, value);
    return days >= 1 && days <= maxDays;
  }

  defaultMessage(args: ValidationArguments): string {
    const [startProperty, maxDays] = args.constraints as [string, number];
    return `${args.property} must be on or after ${startProperty} and no more than ${maxDays} days from it`;
  }
}

/**
 * The end of a bounded calendar range: a real date, on or after the start date,
 * and within `maxDays` of it inclusive.
 */
export function IsCalendarRangeEnd(
  startProperty: string,
  maxDays: number = CALENDAR_RANGE_MAX_DAYS,
  validationOptions?: ValidationOptions,
) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      target: object.constructor,
      propertyName,
      options: validationOptions,
      constraints: [startProperty, maxDays],
      validator: IsCalendarRangeEndConstraint,
    });
  };
}
