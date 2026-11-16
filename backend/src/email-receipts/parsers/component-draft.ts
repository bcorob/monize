import type { EntityManager } from "typeorm";
import { returnedRows } from "../../common/db/query-result";
import {
  componentWindow,
  type ComponentRow,
  type ComponentSearch,
} from "../linking/component-lookup";
import { coveredByDomainSql } from "../linking/component-reread";
import { parseReceiptLinesTraced } from "../parsing/parse-receipt";
import {
  MAX_LINK_DOMAINS,
  type ReceiptParserDefinition,
} from "../parsing/receipt-parser.types";
import {
  validateReceiptParserDefinition,
  type ReceiptParserValidationError,
} from "../parsing/receipt-parser.validation";
import { ReceiptSourceLines } from "../pipeline/receipt-source-lines";
import { EMAIL_RECEIPT_PARSER_TOOL_MAX_DRAFTS } from "./parser-tool.guide";
import {
  isReceiptDomain,
  normalizeReceiptDomain,
} from "./dto/receipt-domain.validator";

/**
 * `componentDrafts` of the `test` operation (linked receipts spec 10a): unsaved
 * `component` profiles, each with the sender domains it would cover, offered
 * beside a `settlement` definition so the profiles can be tested before any is
 * saved. Nothing here writes.
 */

/**
 * Stored emails ONE `test` call reads with its component drafts, over every
 * draft and every tested email together (each email once per draft: the
 * reading is cached). A call that would read more stops there and says so
 * (`DraftComponentReader.exhausted`), so a test of 25 settlement emails with
 * 5 drafts never parses thousands of emails.
 */
export const MAX_DRAFT_COMPONENT_READS = 200;

/** A component draft that passed `checkComponentDrafts`. */
export interface ComponentDraft {
  definition: ReceiptParserDefinition;
  /** Normalized sender domains (1 to `MAX_LINK_DOMAINS`). */
  fromDomains: string[];
}

export type ComponentDraftCheck =
  | { ok: true; drafts: ComponentDraft[] }
  | { ok: false; errors: ReceiptParserValidationError[] };

/**
 * Validate the `componentDrafts` of a test against the definition being tested.
 * The definition under test must be a `settlement`
 * (`component_draft_requires_settlement`); there are 1 to
 * `EMAIL_RECEIPT_PARSER_TOOL_MAX_DRAFTS` drafts (`component_draft_too_many`);
 * each draft's definition goes through the one validator (its paths are prefixed
 * `componentDrafts[i].definition`) and must have `role: "component"`
 * (`component_draft_requires_component`); its `fromDomains` is 1 to 10 valid
 * domains (`component_draft_domain_invalid`). Each `definition` is what the
 * caller resolved (category names to ids, the version defaulted). Pure.
 */
export function checkComponentDrafts(
  tested: Pick<ReceiptParserDefinition, "role">,
  inputs: readonly { definition: unknown; fromDomains: unknown }[],
): ComponentDraftCheck {
  if (tested.role !== "settlement") {
    return {
      ok: false,
      errors: [
        {
          path: "componentDrafts",
          code: "component_draft_requires_settlement",
        },
      ],
    };
  }
  if (
    inputs.length < 1 ||
    inputs.length > EMAIL_RECEIPT_PARSER_TOOL_MAX_DRAFTS
  ) {
    return {
      ok: false,
      errors: [{ path: "componentDrafts", code: "component_draft_too_many" }],
    };
  }
  const errors: ReceiptParserValidationError[] = [];
  const drafts: ComponentDraft[] = [];
  inputs.forEach((input, index) => {
    const at = `componentDrafts[${index}]`;
    const validation = validateReceiptParserDefinition(input.definition);
    let definition: ReceiptParserDefinition | null = null;
    if (!validation.ok) {
      for (const error of validation.errors) {
        errors.push({
          path:
            error.path === ""
              ? `${at}.definition`
              : `${at}.definition.${error.path}`,
          code: error.code,
        });
      }
    } else if (validation.definition.role !== "component") {
      errors.push({
        path: `${at}.definition.role`,
        code: "component_draft_requires_component",
      });
    } else {
      definition = validation.definition;
    }
    const list = input.fromDomains;
    const domains = Array.isArray(list)
      ? list.map((entry) => normalizeReceiptDomain(entry))
      : [];
    if (
      !Array.isArray(list) ||
      list.length < 1 ||
      list.length > MAX_LINK_DOMAINS ||
      !domains.every(isReceiptDomain)
    ) {
      errors.push({
        path: `${at}.fromDomains`,
        code: "component_draft_domain_invalid",
      });
    } else if (definition !== null) {
      drafts.push({
        definition,
        fromDomains: [...new Set(domains as string[])],
      });
    }
  });
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, drafts };
}

/** One stored email read with one draft: its link value, or null when it holds none. */
interface DraftReading {
  linkKey: string | null;
  row: ComponentRow | null;
}

/**
 * Reads the user's stored emails with the component drafts of ONE `test` call,
 * as the candidates a settlement's parts may join (spec 10a). Create one per
 * call and pass it to every `dryRunReceipt` of that call. The emails are the
 * user's, not `skipped`, from a sender the draft covers (the module's
 * equal-or-subdomain rule), dated inside the settlement's component window (the
 * one `loadLinkedComponents` uses), newest first; the settlement's own email is
 * left out. Each is read with the draft over the lines of its `source`, once per
 * draft for the whole call; a reading that the draft's guards turn aside, or that
 * holds no link value among the parts' links, is not a candidate. At most
 * `MAX_DRAFT_COMPONENT_READS` emails are read for the call; past that the reader
 * reads no more and `exhausted` is true. Reads only: no write, no row lock.
 */
export interface DraftComponentReader {
  readonly drafts: readonly ComponentDraft[];
  /** True once the call wanted an email that the read limit left unread. */
  readonly exhausted: boolean;
  read(
    m: EntityManager,
    userId: string,
    settlement: { id: string; effectiveDate: string },
    wanted: ReadonlySet<string>,
    search: ComponentSearch,
  ): Promise<ComponentRow[]>;
}

/**
 * One reader per `test` call. Its cache and its read budget are locals of this
 * call (a closure), never state of the process: the reader is discarded with
 * the call.
 */
export function createDraftComponentReader(
  drafts: readonly ComponentDraft[],
): DraftComponentReader {
  const readings = new Map<string, DraftReading>();
  let remaining = MAX_DRAFT_COMPONENT_READS;
  let exhausted = false;

  /** The ids of the emails one draft covers for this settlement, newest first (no bodies). */
  const candidateIds = async (
    m: EntityManager,
    userId: string,
    settlement: { id: string; effectiveDate: string },
    search: ComponentSearch,
    draft: ComponentDraft,
  ): Promise<string[]> => {
    const { from, to } = componentWindow(settlement.effectiveDate, search);
    const rows = returnedRows<{ id: string }>(
      await m.query(
        `SELECT r.id
           FROM email_receipts r
          WHERE r.user_id = $1
            AND r.status <> 'skipped'
            AND r.id <> $2
            AND EXISTS (
                  SELECT 1 FROM unnest($3::text[]) AS d(domain)
                   WHERE ${coveredByDomainSql("r", "d.domain")})
            AND (COALESCE(r.original_sent_at, r.received_at) AT TIME ZONE 'UTC')::date
                  BETWEEN $4::date AND $5::date
          ORDER BY COALESCE(r.original_sent_at, r.received_at) DESC, r.id ASC
          LIMIT ${MAX_DRAFT_COMPONENT_READS}`,
        [userId, settlement.id, draft.fromDomains, from, to],
      ),
    );
    return rows.map((row) => row.id);
  };

  /** Read, with draft `index`, the emails among `ids` it has not read yet, within the call's limit. */
  const readMissing = async (
    m: EntityManager,
    userId: string,
    index: number,
    ids: readonly string[],
  ): Promise<void> => {
    const missing = ids.filter((id) => !readings.has(`${index}:${id}`));
    if (missing.length === 0) return;
    const batch = missing.slice(0, remaining);
    if (batch.length < missing.length) exhausted = true;
    if (batch.length === 0) return;
    remaining -= batch.length;
    const draft = drafts[index];
    const rows = returnedRows<{
      id: string;
      subject: string;
      body_text: string;
      body_html: string | null;
      effective_date: string;
    }>(
      await m.query(
        `SELECT r.id, r.subject, r.body_text, r.body_html,
                TO_CHAR((COALESCE(r.original_sent_at, r.received_at) AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS effective_date
           FROM email_receipts r
          WHERE r.user_id = $1
            AND r.id = ANY($2::uuid[])`,
        [userId, batch],
      ),
    );
    for (const row of rows) {
      const read = parseReceiptLinesTraced(
        draft.definition,
        row.subject,
        new ReceiptSourceLines({
          bodyText: row.body_text,
          bodyHtml: row.body_html,
        }).forSource(draft.definition.source),
        null,
      );
      const linkKey =
        read.outcome === "read" ? (read.parsed.linkKey ?? null) : null;
      readings.set(`${index}:${row.id}`, {
        linkKey,
        row:
          linkKey === null
            ? null
            : {
                id: row.id,
                linkKey,
                subject: row.subject,
                effectiveDate: row.effective_date,
                parsed: read.parsed,
                parserId: null,
              },
      });
    }
  };

  return {
    drafts,
    get exhausted() {
      return exhausted;
    },
    async read(m, userId, settlement, wanted, search) {
      if (wanted.size === 0) return [];
      const found: ComponentRow[] = [];
      const seen = new Set<string>();
      for (let index = 0; index < drafts.length; index++) {
        const ids = await candidateIds(
          m,
          userId,
          settlement,
          search,
          drafts[index],
        );
        await readMissing(m, userId, index, ids);
        for (const id of ids) {
          const reading = readings.get(`${index}:${id}`);
          // An email two drafts both cover is a candidate once: the first draft's reading.
          if (
            reading?.row &&
            reading.linkKey !== null &&
            wanted.has(reading.linkKey) &&
            !seen.has(id)
          ) {
            seen.add(id);
            found.push(reading.row);
          }
        }
      }
      return found;
    },
  };
}
