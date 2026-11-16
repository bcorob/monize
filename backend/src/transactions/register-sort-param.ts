import { BadRequestException } from "@nestjs/common";
import { assertStringParam } from "../common/query-param-utils";
import { tr } from "../i18n/translate";
import {
  DEFAULT_TRANSACTION_SORT_DIRECTION,
  DEFAULT_TRANSACTION_SORT_FIELD,
  RegisterSortDirection,
  TRANSACTION_SORT_FIELDS,
  TransactionSortField,
} from "./register-order";

/**
 * The register's `sortBy` / `sortDirection` query parameters, validated.
 *
 * `assertStringParam` runs first on both: Express parses a repeated query key
 * (`?sortBy=date&sortBy=amount`) as an array, and an array's `toLowerCase` does
 * not exist while its `includes` compares whole elements -- so a raw check
 * against the allowlist would throw a TypeError or, worse, pass. The
 * boundary's job is to reject anything that is not one string before the value
 * is compared with anything (`docs/backend/entities-and-dtos.md`).
 *
 * Absent means the default rather than an error, because every existing caller
 * of `GET /transactions` omits both and must keep the register it has today.
 */
export interface TransactionSortSelection {
  sortBy: TransactionSortField;
  sortDirection: RegisterSortDirection;
}

function parseSortField(value: unknown): TransactionSortField {
  const raw = assertStringParam(value, "sortBy")?.trim();
  if (!raw) return DEFAULT_TRANSACTION_SORT_FIELD;
  // Matched case-insensitively but returned in the list's own spelling, which
  // is what every other layer compares against. Lowercasing the input and
  // testing THAT against the list quietly rejects `refNumber`, the one field
  // whose name is not all lower case.
  const field = TRANSACTION_SORT_FIELDS.find(
    (candidate) => candidate.toLowerCase() === raw.toLowerCase(),
  );
  if (!field) {
    const allowed = TRANSACTION_SORT_FIELDS.join(", ");
    throw new BadRequestException(
      tr(
        "errors.transactions.invalidSortBy",
        `Invalid sortBy: ${raw}. Must be one of: ${allowed}`,
        { sortBy: raw, allowed },
      ),
    );
  }
  return field;
}

function parseSortDirection(value: unknown): RegisterSortDirection {
  const raw = assertStringParam(value, "sortDirection")?.trim().toLowerCase();
  if (!raw) return DEFAULT_TRANSACTION_SORT_DIRECTION;
  if (raw === "asc") return "ASC";
  if (raw === "desc") return "DESC";
  throw new BadRequestException(
    tr(
      "errors.transactions.invalidSortDirection",
      `Invalid sortDirection: ${raw}. Must be one of: asc, desc`,
      { sortDirection: raw },
    ),
  );
}

export function parseTransactionSort(
  sortBy: unknown,
  sortDirection: unknown,
): TransactionSortSelection {
  return {
    sortBy: parseSortField(sortBy),
    sortDirection: parseSortDirection(sortDirection),
  };
}
