import { PipeTransform, Injectable, BadRequestException } from "@nestjs/common";

import { tr } from "../../i18n/translate";
import { isCalendarDate } from "../validators/is-calendar-date.validator";

/**
 * Validates a route parameter that is a calendar date.
 *
 * The counterpart of `ParseUUIDPipe` for a resource keyed by its day rather
 * than by an id. A shape check alone is not enough: `2026-02-30` and
 * `9999-99-99` match `\d{4}-\d{2}-\d{2}` and reach Postgres as date literals,
 * where they fail with "date/time field value out of range" -- a 500 for what is
 * plainly a client error.
 */
@Injectable()
export class ParseCalendarDatePipe implements PipeTransform<unknown, string> {
  transform(value: unknown): string {
    if (!isCalendarDate(value)) {
      throw new BadRequestException(
        tr(
          "errors.common.calendarDateInvalid",
          "date must be a real YYYY-MM-DD calendar date",
        ),
      );
    }
    return value;
  }
}

/**
 * The same check for a query parameter the route may omit.
 *
 * `@Query()` hands a pipe `undefined` when the key is absent, which is the one
 * value an optional bound may take; everything else goes through
 * `ParseCalendarDatePipe`'s check, including the array Express parses a
 * repeated key into (`?startDate=x&startDate=y`). A regular expression `.test`
 * on such a value coerces the array to text and passes it (CodeQL
 * `js/type-confusion-through-parameter-tampering`), which is why the type is
 * checked rather than the text.
 */
@Injectable()
export class ParseOptionalCalendarDatePipe implements PipeTransform<
  unknown,
  string | undefined
> {
  private readonly required = new ParseCalendarDatePipe();

  transform(value: unknown): string | undefined {
    // Absent, or the empty string a client sends for a bound the user left
    // alone: no bound, which is what the route means by an omitted one.
    if (value === undefined || value === "") return undefined;
    return this.required.transform(value);
  }
}
