import { Transform } from "class-transformer";

/** The sanitizer `@SanitizeHtml()` applies to a string; also for values that bypass a DTO. */
export function sanitizeHtmlString(raw: string): string {
  return raw.replace(/[<>]/g, "");
}

/**
 * Strips HTML angle brackets from string values to prevent stored XSS.
 * Also rejects non-string values (objects, arrays) that would otherwise
 * be coerced to "[object Object]" by enableImplicitConversion.
 */
export function SanitizeHtml(): PropertyDecorator {
  return Transform(({ obj, key }) => {
    const raw = obj[key];
    if (raw === undefined || raw === null) return raw;
    if (Array.isArray(raw)) {
      return raw.map((item) =>
        typeof item === "string" ? sanitizeHtmlString(item) : item,
      );
    }
    if (typeof raw !== "string") return raw;
    return sanitizeHtmlString(raw);
  });
}
