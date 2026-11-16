import {
  BadRequestException,
  ConflictException,
  HttpException,
  NotFoundException,
} from "@nestjs/common";

/**
 * A log-safe account of a failure: the class, and the message only when it is
 * ours (an `HttpException`). Kept apart from the pipeline service so the
 * modules the pipeline depends on can use it without importing it back.
 */
export function describeFailure(error: unknown): string {
  if (error instanceof HttpException) {
    return `${error.constructor.name}: ${error.message}`;
  }
  return error instanceof Error ? error.constructor.name : "unknown error";
}

/** The refusals a proposal's validation raises on purpose (anything else is ours and propagates). */
export const isRefusal = (error: unknown): boolean =>
  error instanceof BadRequestException ||
  error instanceof NotFoundException ||
  error instanceof ConflictException;

/** The longest note a refused proposal leaves on its request. */
const MAX_REFUSAL_NOTE = 400;

/** The reason a refusal gives, cut to what a request's note keeps. */
export function refusalNote(error: unknown): string {
  const message =
    error instanceof HttpException
      ? error.message
      : "The proposal was refused.";
  return message.slice(0, MAX_REFUSAL_NOTE);
}
