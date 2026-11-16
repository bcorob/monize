import { BusinessDayCalendar } from "./business-day-calendar";

/** Calendars by id. Immutable: registering returns a new map, the engine only reads one. */
export type CalendarRegistry = ReadonlyMap<string, BusinessDayCalendar>;

export const EMPTY_CALENDAR_REGISTRY: CalendarRegistry = new Map();

export function registerCalendar(
  registry: CalendarRegistry,
  calendar: BusinessDayCalendar,
): CalendarRegistry {
  if (registry.has(calendar.id)) {
    throw new Error(`Calendar already registered: ${calendar.id}`);
  }
  return new Map([...registry, [calendar.id, calendar]]);
}
