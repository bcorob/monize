import { ConflictException } from "@nestjs/common";
import { QueryFailedError } from "typeorm";

import { tr } from "../i18n/translate";

/** How long an emailed email-change link stays usable (the verify-email TTL). */
export const EMAIL_CHANGE_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * The same normalization registration applies before it stores or looks up an
 * address, so a changed email can be signed in with exactly as a registered one.
 */
export function normalizeEmail(email: string): string {
  return email.toLowerCase().trim();
}

/** `users.email` is UNIQUE; a lost race on it surfaces as SQLSTATE 23505. */
export function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof QueryFailedError &&
    (error.driverError as { code?: string } | undefined)?.code === "23505"
  );
}

/** The one refusal both halves of an email change answer a taken address with. */
export function emailInUseConflict(): ConflictException {
  return new ConflictException(
    tr("errors.users.emailInUse", "Email already in use"),
  );
}
