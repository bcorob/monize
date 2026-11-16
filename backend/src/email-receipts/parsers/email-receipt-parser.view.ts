import type {
  EmailReceiptParser,
  EmailReceiptParserSource,
  EmailReceiptParserStatus,
} from "../entities/email-receipt-parser.entity";
import { effectiveMatchDefinition } from "../parsing/receipt-match-config";
import type { ReceiptMatchDefinition } from "../parsing/receipt-parser.types";
import { nameParserCategories } from "./parser-category-names.util";
import {
  validateReceiptParserDefinition,
  type ReceiptParserValidationError,
} from "../parsing/receipt-parser.validation";

/**
 * A parser as a client sees it. `definitionValid` and `definitionErrors` are
 * computed on every read: a definition restored from a support backup can be the
 * column default `{}`, which is reported as invalid, never a crash.
 */
export interface EmailReceiptParserView {
  id: string;
  name: string;
  payeeId: string | null;
  fromDomains: string[];
  subjectContains: string[];
  definition: Record<string, unknown>;
  definitionValid: boolean;
  definitionErrors: ReceiptParserValidationError[];
  status: EmailReceiptParserStatus;
  source: EmailReceiptParserSource;
  approvedAt: string | null;
  revision: number;
  /**
   * Approved parsers only (0 for a draft): stored emails of the parser's sender
   * domains in a processable status that were last processed before the
   * parser's last change, so processing them again can change something.
   */
  reprocessableCount: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * The definition a client sees: the matching the profile EFFECTIVELY has (every
 * default filled in, so the form and the AI show what the matcher will do) and
 * the categories by name. An invalid definition is shown as stored. A trade
 * profile is shown as stored too: it matches no bank transaction, and a `match`
 * beside its `trade` section is a key the validator refuses (`trade_conflict`),
 * so the editor would open it as JSON and saving it back would fail.
 */
function viewDefinition(
  stored: Record<string, unknown>,
  valid: boolean,
  categoryNames: ReadonlyMap<string, string>,
): Record<string, unknown> {
  if (!valid || stored.trade !== undefined) return stored;
  return nameParserCategories(
    {
      ...stored,
      match: effectiveMatchDefinition(
        stored as {
          reference?: unknown[];
          match?: ReceiptMatchDefinition | null;
        },
      ),
    },
    categoryNames,
  );
}

/**
 * The view of a stored row, field by field so a new column is not shown by
 * accident. `categoryNames` is `id -> qualified name` of the owner's categories.
 */
export function toParserView(
  row: EmailReceiptParser,
  categoryNames: ReadonlyMap<string, string> = new Map(),
  reprocessableCount = 0,
): EmailReceiptParserView {
  const validation = validateReceiptParserDefinition(row.definition);
  return {
    id: row.id,
    name: row.name,
    payeeId: row.payeeId,
    fromDomains: row.fromDomains,
    subjectContains: row.subjectContains,
    definition: viewDefinition(row.definition, validation.ok, categoryNames),
    definitionValid: validation.ok,
    definitionErrors: validation.ok ? [] : validation.errors,
    status: row.status,
    source: row.source,
    approvedAt: row.approvedAt ? row.approvedAt.toISOString() : null,
    revision: row.revision,
    reprocessableCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
