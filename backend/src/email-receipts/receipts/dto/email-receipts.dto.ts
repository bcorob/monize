import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Transform, Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  registerDecorator,
  ValidateIf,
  ValidateNested,
} from "class-validator";
import {
  IsCalendarDate,
  isCalendarDate,
} from "../../../common/validators/is-calendar-date.validator";
import { IsNoControlCharacters } from "../../mailbox/no-control-characters.validator";
import {
  IsReceiptDomain,
  normalizeReceiptDomain,
} from "../../parsers/dto/receipt-domain.validator";
import {
  EMAIL_RECEIPT_STATUSES,
  EmailReceiptStatus,
} from "../../entities/email-receipt.entity";

export const EMAIL_RECEIPTS_DEFAULT_LIST_LIMIT = 50;
export const EMAIL_RECEIPTS_MAX_LIST_LIMIT = 200;
export const EMAIL_RECEIPTS_MAX_LIST_OFFSET = 100000;

/**
 * The statuses "process in bulk" can act on again: an email waiting to be read,
 * and every state a new profile (or a new transaction) can change. `review` is
 * not one of them: it stands behind a proposal a person decides.
 */
export const EMAIL_RECEIPT_PROCESSABLE_STATUSES = [
  "pending",
  "no_parser",
  "parse_failed",
  "unmatched",
  "ambiguous",
  "review_conflict",
] as const satisfies readonly EmailReceiptStatus[];
export type EmailReceiptProcessableStatus =
  (typeof EMAIL_RECEIPT_PROCESSABLE_STATUSES)[number];
export const EMAIL_RECEIPTS_DEFAULT_BATCH_LIMIT = 100;
export const EMAIL_RECEIPTS_MAX_BATCH_LIMIT = 200;

/** Longest search text a request may carry, after trimming. */
export const EMAIL_RECEIPTS_MAX_SEARCH_CHARS = 200;

/** Where a search looks: everywhere, the subject, the sender or the body text. */
export const EMAIL_RECEIPT_SEARCH_FIELDS = [
  "all",
  "subject",
  "sender",
  "body",
] as const;
export type EmailReceiptSearchField =
  (typeof EMAIL_RECEIPT_SEARCH_FIELDS)[number];

/** A `YYYY-MM-DD` that is not before the one named by `other` (checked only when both are real dates). */
function IsNotBefore(other: string) {
  return function decorate(object: object, propertyName: string): void {
    registerDecorator({
      name: "isNotBefore",
      target: object.constructor,
      propertyName,
      validator: {
        validate: (value: unknown, args) => {
          const from = (args?.object as Record<string, unknown>)[other];
          return (
            !isCalendarDate(value) || !isCalendarDate(from) || from <= value
          );
        },
        defaultMessage: () => `${propertyName} must not be before ${other}`,
      },
    });
  };
}

/**
 * The search and the date range of the receipts page, one set of fields for the
 * list, its counts, the sender domains and the bulk filter, so each reads the
 * same emails (`receipt-filter.ts` holds the one predicate).
 */
export abstract class ReceiptSearchDto {
  @ApiPropertyOptional({
    maxLength: EMAIL_RECEIPTS_MAX_SEARCH_CHARS,
    description:
      "Text to find in the emails (case-insensitive substring). Trimmed; blank means no search.",
    example: "invoice",
  })
  @IsOptional()
  @Transform(({ value }) =>
    typeof value === "string" ? value.trim() || undefined : value,
  )
  @IsString()
  @MaxLength(EMAIL_RECEIPTS_MAX_SEARCH_CHARS)
  @IsNoControlCharacters()
  search?: string;

  @ApiPropertyOptional({
    enum: EMAIL_RECEIPT_SEARCH_FIELDS,
    default: "all",
    description:
      "Where `search` looks: the subject, the sender (address, domain, forwarding user), the body text, or all of them. Ignored without `search`.",
  })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null && v !== "")
  @IsIn(EMAIL_RECEIPT_SEARCH_FIELDS)
  searchIn?: EmailReceiptSearchField;

  @ApiPropertyOptional({
    example: "2026-01-31",
    description:
      "Only emails dated on or after this UTC day (YYYY-MM-DD): the date the list shows, `original_sent_at` else `received_at`.",
  })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null && v !== "")
  @IsCalendarDate()
  dateFrom?: string;

  @ApiPropertyOptional({
    example: "2026-12-31",
    description:
      "Only emails dated on or before this UTC day (YYYY-MM-DD); not before `dateFrom`.",
  })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null && v !== "")
  @IsCalendarDate()
  @IsNotBefore("dateFrom")
  dateTo?: string;
}

/** Query of `GET /email-receipts`. */
export class ListEmailReceiptsDto extends ReceiptSearchDto {
  @ApiPropertyOptional({ enum: EMAIL_RECEIPT_STATUSES })
  @IsOptional()
  @IsIn(EMAIL_RECEIPT_STATUSES)
  status?: EmailReceiptStatus;

  @ApiPropertyOptional({
    description:
      "A sender domain: emails from exactly this domain or one of its sub-domains. Lower-cased and trimmed.",
    example: "shop.example.com",
  })
  @IsOptional()
  @Transform(({ value }) => normalizeReceiptDomain(value))
  @IsReceiptDomain()
  domain?: string;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: EMAIL_RECEIPTS_MAX_LIST_LIMIT,
    default: EMAIL_RECEIPTS_DEFAULT_LIST_LIMIT,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(EMAIL_RECEIPTS_MAX_LIST_LIMIT)
  limit?: number;

  @ApiPropertyOptional({
    description: "Emails to skip, in the list's order (for paging).",
    minimum: 0,
    maximum: EMAIL_RECEIPTS_MAX_LIST_OFFSET,
    default: 0,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(EMAIL_RECEIPTS_MAX_LIST_OFFSET)
  offset?: number;
}

/** Query of `GET /email-receipts/domains`. */
export class ListEmailReceiptDomainsDto extends ReceiptSearchDto {
  @ApiPropertyOptional({
    enum: EMAIL_RECEIPT_STATUSES,
    description: "Count only the emails in this state.",
  })
  @IsOptional()
  @IsIn(EMAIL_RECEIPT_STATUSES)
  status?: EmailReceiptStatus;
}

/** Query of `GET /email-receipts/status-counts`. */
export class EmailReceiptStatusCountsDto extends ReceiptSearchDto {
  @ApiPropertyOptional({
    description:
      "Count only emails from exactly this domain or one of its sub-domains. Lower-cased and trimmed.",
    example: "shop.example.com",
  })
  @IsOptional()
  @Transform(({ value }) => normalizeReceiptDomain(value))
  @IsReceiptDomain()
  domain?: string;
}

/** Body of `POST /email-receipts/:id/link`. */
export class LinkEmailReceiptDto {
  @ApiProperty({ description: "The transaction this email paid for." })
  @IsUUID()
  transactionId: string;
}

/**
 * Body of `POST /email-receipts/:id/ask-ai`. The transaction is optional: an
 * email that already has one is asked about as it is. A blank or null value
 * means "none", as in the other forms of this module.
 */
export class AskAiEmailReceiptDto {
  @ApiPropertyOptional({
    nullable: true,
    description:
      "The transaction this email paid for, when the person chose another one.",
  })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null && v !== "")
  @IsUUID()
  transactionId?: string | null;

  @ApiPropertyOptional({
    description:
      "Recognize the email as a brokerage trade confirmation: the AI proposes the investment transaction it reports (no bank transaction is involved).",
  })
  @IsOptional()
  @IsBoolean()
  asTrade?: boolean;
}

/** Body of `POST /email-receipts/process-batch`. */
export class ProcessBatchEmailReceiptsDto {
  @ApiPropertyOptional({
    description:
      "Only emails from this sender domain or one of its sub-domains. Lower-cased and trimmed.",
    example: "shop.example.com",
  })
  @IsOptional()
  @Transform(({ value }) => normalizeReceiptDomain(value))
  @IsReceiptDomain()
  domain?: string;

  @ApiPropertyOptional({
    enum: EMAIL_RECEIPT_PROCESSABLE_STATUSES,
    isArray: true,
    description: "Only emails in these statuses. Default: every one of them.",
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(EMAIL_RECEIPT_PROCESSABLE_STATUSES.length)
  @ArrayUnique()
  @IsIn(EMAIL_RECEIPT_PROCESSABLE_STATUSES, { each: true })
  statuses?: EmailReceiptProcessableStatus[];

  @ApiPropertyOptional({
    minimum: 1,
    maximum: EMAIL_RECEIPTS_MAX_BATCH_LIMIT,
    default: EMAIL_RECEIPTS_DEFAULT_BATCH_LIMIT,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(EMAIL_RECEIPTS_MAX_BATCH_LIMIT)
  limit?: number;

  @ApiPropertyOptional({
    description:
      "The `since` the previous call of this run answered: only emails not touched since then are taken, so a run that loops until `remaining` is 0 ends even when some emails stay in the same status.",
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  since?: string;
}

/**
 * What `POST /email-receipts/profile-batch` does with the emails a profile
 * matches: `count` reads only, `ignore` and `delete` act on them.
 */
export const EMAIL_RECEIPT_PROFILE_BATCH_ACTIONS = [
  "count",
  "ignore",
  "delete",
] as const;
export type EmailReceiptProfileBatchAction =
  (typeof EMAIL_RECEIPT_PROFILE_BATCH_ACTIONS)[number];

/** Body of `POST /email-receipts/profile-batch`. */
export class ProfileBatchEmailReceiptsDto {
  @ApiProperty({ description: "The profile whose emails are acted on." })
  @IsUUID()
  parserId: string;

  @ApiProperty({ enum: EMAIL_RECEIPT_PROFILE_BATCH_ACTIONS })
  @IsIn(EMAIL_RECEIPT_PROFILE_BATCH_ACTIONS)
  action: EmailReceiptProfileBatchAction;

  @ApiPropertyOptional({
    description:
      "The `next` the previous call of this run answered: the scan goes on after that email. Absent on the first call.",
  })
  @IsOptional()
  @IsUUID()
  after?: string;
}

export const EMAIL_RECEIPT_BULK_ACTIONS = ["delete", "ignore"] as const;
export type EmailReceiptBulkAction =
  (typeof EMAIL_RECEIPT_BULK_ACTIONS)[number];
/** Most emails one bulk request may name by id. */
export const EMAIL_RECEIPTS_BULK_MAX_IDS = 500;
/** Most emails one bulk request may act on when it names a filter. */
export const EMAIL_RECEIPTS_BULK_MAX_MATCHES = 20000;

/** Most states one filter may take out (the number of states there are). */
export const EMAIL_RECEIPTS_BULK_MAX_EXCLUDED_STATUSES =
  EMAIL_RECEIPT_STATUSES.length;
/** Most sender domains one filter may take out. */
export const EMAIL_RECEIPTS_BULK_MAX_EXCLUDED_DOMAINS = 50;
/** Most proposals one approval listing returns. */
export const EMAIL_RECEIPTS_APPROVABLE_MAX = 2000;
/** Most emails one reprocess call runs. */
export const EMAIL_RECEIPTS_BULK_REPROCESS_MAX_LIMIT = 25;
export const EMAIL_RECEIPTS_BULK_REPROCESS_DEFAULT_LIMIT = 10;

/** The state and sender domain of the list, as one bulk request names them, and what is taken out of it. */
export class BulkEmailReceiptFilterDto extends ReceiptSearchDto {
  @ApiPropertyOptional({ enum: EMAIL_RECEIPT_STATUSES })
  @IsOptional()
  @IsIn(EMAIL_RECEIPT_STATUSES)
  status?: EmailReceiptStatus;

  @ApiPropertyOptional({
    description:
      "A sender domain: emails from exactly this domain or one of its sub-domains, as the list reads it. Lower-cased and trimmed.",
    example: "gmail.com",
  })
  @IsOptional()
  @Transform(({ value }) => normalizeReceiptDomain(value))
  @IsReceiptDomain()
  domain?: string;

  @ApiPropertyOptional({
    enum: EMAIL_RECEIPT_STATUSES,
    isArray: true,
    description: "States taken out of the selection.",
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(EMAIL_RECEIPTS_BULK_MAX_EXCLUDED_STATUSES)
  @ArrayUnique()
  @IsIn(EMAIL_RECEIPT_STATUSES, { each: true })
  excludeStatuses?: EmailReceiptStatus[];

  @ApiPropertyOptional({
    isArray: true,
    type: String,
    maxItems: EMAIL_RECEIPTS_BULK_MAX_EXCLUDED_DOMAINS,
    description:
      "Sender domains taken out of the selection, each with its sub-domains. Lower-cased and trimmed.",
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(EMAIL_RECEIPTS_BULK_MAX_EXCLUDED_DOMAINS)
  @ArrayUnique()
  @Transform(({ value }) =>
    Array.isArray(value) ? value.map(normalizeReceiptDomain) : value,
  )
  @IsReceiptDomain({ each: true })
  excludeDomains?: string[];

  @ApiPropertyOptional({
    example: "2026-01-31",
    description: "Only emails received on or after this UTC day (YYYY-MM-DD).",
  })
  @IsOptional()
  @IsCalendarDate()
  receivedFrom?: string;

  @ApiPropertyOptional({
    example: "2026-12-31",
    description:
      "Only emails received on or before this UTC day (YYYY-MM-DD); not before `receivedFrom`.",
  })
  @IsOptional()
  @IsCalendarDate()
  @IsNotBefore("receivedFrom")
  receivedTo?: string;
}

/** The property must be absent when `other` is present: a request names ids or a filter, never both. */
function IsAbsentWhen(other: string) {
  return function decorate(object: object, propertyName: string): void {
    registerDecorator({
      name: "isAbsentWhen",
      target: object.constructor,
      propertyName,
      validator: {
        validate: (value: unknown, args) =>
          value === undefined ||
          (args?.object as Record<string, unknown>)[other] === undefined,
        defaultMessage: () =>
          `send either ids or filter, not both (${propertyName} and ${other})`,
      },
    });
  };
}

/**
 * Body of `POST /email-receipts/bulk`: delete or ignore many stored emails.
 * Exactly one of `ids` and `filter` names them; `expectedCount` is how many the
 * person was told, and a different number refuses the whole request.
 */
export class BulkEmailReceiptsDto {
  @ApiProperty({ enum: EMAIL_RECEIPT_BULK_ACTIONS })
  @IsIn(EMAIL_RECEIPT_BULK_ACTIONS)
  action: EmailReceiptBulkAction;

  @ApiPropertyOptional({
    description: "The emails to act on, by id. Send this or `filter`.",
    maxItems: EMAIL_RECEIPTS_BULK_MAX_IDS,
  })
  @ValidateIf(
    (o: BulkEmailReceiptsDto) => o.ids !== undefined || o.filter === undefined,
  )
  @IsAbsentWhen("filter")
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(EMAIL_RECEIPTS_BULK_MAX_IDS)
  @ArrayUnique()
  @IsUUID("all", { each: true })
  ids?: string[];

  @ApiPropertyOptional({
    type: BulkEmailReceiptFilterDto,
    description:
      "Every email matching this state and sender domain, as the list reads them. Send this or `ids`.",
  })
  @ValidateIf(
    (o: BulkEmailReceiptsDto) => o.filter !== undefined || o.ids === undefined,
  )
  @IsObject()
  @ValidateNested()
  @Type(() => BulkEmailReceiptFilterDto)
  filter?: BulkEmailReceiptFilterDto;

  @ApiProperty({
    minimum: 1,
    maximum: EMAIL_RECEIPTS_BULK_MAX_MATCHES,
    description:
      "How many emails the request matches, as the person was told. A different count refuses the request with 409 and writes nothing.",
  })
  @IsInt()
  @Min(1)
  @Max(EMAIL_RECEIPTS_BULK_MAX_MATCHES)
  expectedCount: number;
}

/** Exactly one of `ids` and `filter` names the emails: the target of a bulk command. */
export abstract class ReceiptSelectionTargetDto {
  @ApiPropertyOptional({
    description: "The emails to act on, by id. Send this or `filter`.",
    maxItems: EMAIL_RECEIPTS_BULK_MAX_IDS,
  })
  @ValidateIf(
    (o: ReceiptSelectionTargetDto) =>
      o.ids !== undefined || o.filter === undefined,
  )
  @IsAbsentWhen("filter")
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(EMAIL_RECEIPTS_BULK_MAX_IDS)
  @ArrayUnique()
  @IsUUID("all", { each: true })
  ids?: string[];

  @ApiPropertyOptional({
    type: BulkEmailReceiptFilterDto,
    description:
      "Every email matching this filter, as the list reads them. Send this or `ids`.",
  })
  @ValidateIf(
    (o: ReceiptSelectionTargetDto) =>
      o.filter !== undefined || o.ids === undefined,
  )
  @IsObject()
  @ValidateNested()
  @Type(() => BulkEmailReceiptFilterDto)
  filter?: BulkEmailReceiptFilterDto;
}

/** Body of `POST /email-receipts/bulk/count`: how many emails a filter selects. */
export class CountEmailReceiptsDto {
  @ApiProperty({ type: BulkEmailReceiptFilterDto })
  @IsObject()
  @ValidateNested()
  @Type(() => BulkEmailReceiptFilterDto)
  filter: BulkEmailReceiptFilterDto;
}

/** Body of `POST /email-receipts/bulk/reprocess`. */
export class BulkReprocessEmailReceiptsDto extends ReceiptSelectionTargetDto {
  @ApiPropertyOptional({
    enum: EMAIL_RECEIPT_STATUSES,
    isArray: true,
    description:
      'Only emails in these states ("restore ignored" is ["ignored"]); an email whose state changed meanwhile is left alone.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(EMAIL_RECEIPT_STATUSES.length)
  @ArrayUnique()
  @IsIn(EMAIL_RECEIPT_STATUSES, { each: true })
  onlyStatuses?: EmailReceiptStatus[];

  @ApiPropertyOptional({
    description:
      "The `since` the previous call of this run answered: only emails not touched since then are taken.",
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  since?: string;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: EMAIL_RECEIPTS_BULK_REPROCESS_MAX_LIMIT,
    default: EMAIL_RECEIPTS_BULK_REPROCESS_DEFAULT_LIMIT,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(EMAIL_RECEIPTS_BULK_REPROCESS_MAX_LIMIT)
  limit?: number;
}

/** Body of `POST /email-receipts/bulk/approvable`. */
export class ApprovableEmailReceiptsDto extends ReceiptSelectionTargetDto {}
